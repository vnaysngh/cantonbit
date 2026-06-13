# HTLC Security Audit - 2026-06-12

This document records the security audit and fixes for the CBTC HTLC swap flows:

- EVM -> Canton email: trustless, on-ledger keccak HTLC
- Canton -> EVM email: trustless, on-ledger keccak HTLC
- EVM -> Canton Loop: trust-minimized reveal-first flow
- Canton -> EVM Loop: custody flow aligned with the proven Loop custody ceiling

The audit focused on bugs that could lose user funds, app/solver funds, or leak private swap data.

## Deployment Action

The new hardened DAR is:

```text
canton-htlc/.daml/dist/cbtc-htlc-hardened-0.1.0.dar
```

Package id:

```text
1b2397fd7dcf177d90785059d33780de50936804b145b0fe7275bcf73faf2d28
```

After uploading this DAR to the participant, set:

```text
CBTC_HTLC_PKG_ID=1b2397fd7dcf177d90785059d33780de50936804b145b0fe7275bcf73faf2d28
```

The app intentionally no longer defaults to an old package id. If `CBTC_HTLC_PKG_ID` is missing, on-ledger HTLC creation/claim/refund fails closed instead of silently using a stale DAR. Do not rely on the package version label alone; the package id/hash is the authoritative value.

This DAR uses package name `cbtc-htlc-hardened` instead of `cbtc-htlc`. The earlier `cbtc-htlc v0.1.5` uploaded to the participant contained the dropped `LoopHtlcGate` template, so Canton rejects later `cbtc-htlc` packages that remove that template as invalid upgrades. The hardened email HTLC package is intentionally a fresh package line.

## Findings And Fixes

### 1. Critical/P0 - Reverse Email Route Could Lock Victim CBTC

Affected flows:

- Canton -> EVM email
- Any route that accepted `userCantonParty` from the client while the backend could act as participant

Risk:

An unauthenticated or wrong-session caller could submit a reverse order for a victim's Canton party. Because backend routes can act on participant-hosted parties, this could create or progress swaps against funds the caller did not own.

Implemented approach:

- Added centralized party ownership guards.
- WarpX-hosted parties must resolve through the authenticated email session mapping.
- Loop parties must resolve through a valid Loop JWT profile and match the connected Loop party.
- Order routes now authorize against the stored order owner before mutation.

Status: Fixed.

### 2. Critical/P0 - Public Cleanup Could Withdraw Solver Allocations

Affected flows:

- Solver allocation cleanup
- EVM -> Canton email counter-lock path
- Canton -> EVM email main-lock path

Risk:

The cleanup route was callable as a public mutation and could withdraw allocations that were still part of live swaps. That could strand user orders or return solver funds at the wrong time.

Implemented approach:

- Cleanup is daemon-only in production.
- Cleanup lists active orders and skips allocation contract ids referenced by active swaps.
- Response reports `skippedActive` separately from withdrawn orphan allocations.

Status: Fixed.

### 3. High - Public Mutation Routes Missing Owner/Solver Authorization

Affected flows:

- Claim, refund, cancel, lock, accept, prepare, confirm, and record routes under `/api/htlc`
- Both email and Loop paths

Risk:

Attackers could drive state transitions for orders they did not own, trigger premature refund/claim attempts, reveal operational data, or force the solver into unsafe work.

Implemented approach:

- Added route-level guards:
 - User-owned actions require the order owner.
 - Solver/maintenance actions require daemon bearer authorization.
 - Mixed routes allow either the owner or the daemon only where the protocol needs both.
- Added solver Canton party and solver EVM address checks on order creation when configured.

Status: Fixed.

### 4. High - Private Swap Data Was Publicly Readable

Affected flows:

- `/api/htlc/active`
- `/api/htlc/history`
- `/api/htlc/[id]`
- `/api/htlc/[id]/preimage`

Risk:

Public reads could leak active orders, parties, amounts, order state, and preimages. Preimage exposure is especially sensitive because it is the cross-chain unlock secret.

Implemented approach:

- Active order feed is daemon-only.
- Preimage endpoint is daemon-only.
- Order details require order owner or daemon.
- History with a `party` query requires proof that the requester owns that party.

Status: Fixed.

### 5. High - Stale Daml Package Id And Package Mismatch Risk

Affected flows:

- On-ledger Canton HTLC lock creation
- On-ledger Canton HTLC claim/refund
- Email trustless flows

Risk:

The runtime used a hardcoded old HTLC package id. After contract hardening, a stale package id would mean the app could still create old-template locks that do not enforce the new binding checks.

Implemented approach:

- Removed the hardcoded HTLC package id.
- Runtime now requires `CBTC_HTLC_PKG_ID`.
- Hardened DAR was built with DPM and inspected to obtain the new package id.

Status: Fixed in code. Requires uploading the new DAR and setting `CBTC_HTLC_PKG_ID` in deployment.

### 6. Medium - Canton HTLC Did Not Bind Amount And Instrument

Affected flows:

- EVM -> Canton email
- Canton -> EVM email
- Any flow using `CbtcHtlc:HtlcLock`

Risk:

The on-ledger wrapper checked parties and settlement timing, but not the exact allocation amount or token instrument. A mismatched allocation could be wrapped under the correct hashlock with wrong economic terms.

Implemented approach:

- Added `amount` and `instrumentId` fields to `HtlcLock`.
- `Claim` and `Refund` now fetch the allocation view and assert sender, receiver, executor, amount, instrument id, and settlement window.
- App-side HTLC creation now passes `amountBtc` and the configured CBTC instrument id.
- Daml tests cover mismatched allocation rejection.

Status: Fixed.

### 7. Medium - Loop Party Registration Accepted Bare Party Id

Affected flows:

- Loop wallet registration
- Loop swap ownership checks

Risk:

A caller could register or claim association with a Loop party id without proving wallet control. That could allow unauthorized history access or incorrect party ownership mapping.

Implemented approach:

- Loop registration now requires the wallet's "Exchange API Key" signature payload.
- Server exchanges the signature for a Loop JWT.
- Server fetches Loop `/api/v1/profile` and requires the profile party to match the requested party id.
- The verified JWT is stored as the server-side Loop session.
- The global wallet provider no longer signs or registers in the background, so page loads do not repeatedly prompt the wallet.
- Loop login first checks the existing server-side Loop session without a wallet prompt and redirects immediately if that session is still valid for the connected party.
- Loop login is now user-click-driven when no valid server-side session exists: connect wallet, request one signature, register, then redirect only after success.
- Failed signature/registration stays on login, shows the error, and retries use a fresh Loop connect path instead of a stale provider.
- Session probes verify the cached Loop API key belongs to the currently connected Loop party before skipping the signature, preventing stale cross-account cookie reuse.

Status: Fixed.

### 8. Low/Conditional - Fee-On-Transfer EVM Token Accounting

Affected flows:

- EVM HTLC escrow
- Any future non-WBTC token support using the same escrow

Risk:

If a fee-on-transfer token were used, the escrow could record the requested amount while receiving less. A claim would then try to transfer more than the escrow actually received.

Implemented approach:

- Escrow checks token balance before and after `safeTransferFrom`.
- If received amount differs from requested amount, lock reverts with `UnsupportedFeeOnTransferToken`.
- Added a Foundry regression test with a fee-on-transfer mock token.

Status: Fixed.

## Additional Hardening

### Daemon Authorization

Production daemon routes now require bearer authorization using:

- `HTLC_DAEMON_SECRET`, or
- `CRON_SECRET`

Development still allows local runs without a secret for local ergonomics. Production fails closed when the secret is missing.

### Solver Daemon Calls

The solver daemon and hygiene sweep now send the daemon bearer token to protected API routes. This keeps automated solver work functional after route hardening.

### Order Creation Invariants

Order creation now rechecks:

- Valid direction
- Party ownership
- Solver Canton party, when configured
- Solver EVM address, when configured
- Timelock ladder
- Fresh quote/amount ratio

### Cleanup Safety

Allocation cleanup is limited to orphan allocations and no longer treats every solver allocation as withdrawable.

## Verification

Commands run after fixes:

```text
npx tsc --noEmit
npm test
npm --prefix swap-solver test
cd contracts && forge test
cd canton-htlc && dpm build
cd canton-htlc && JAVA_HOME=/opt/homebrew/opt/openjdk@17 PATH="/opt/homebrew/opt/openjdk@17/bin:$PATH" dpm test
git diff --check
```

Results:

- TypeScript passed.
- App tests passed: 14/14.
- Solver tests passed: 108/108.
- Foundry tests passed: 32/32.
- DPM build passed and produced `cbtc-htlc-hardened-0.1.0.dar`.
- DPM tests passed after explicitly setting Java 17 environment.
- Whitespace check passed.
- After review fixes, `npx tsc --noEmit` and `npm test` were rerun and passed.

### 7. High - Managed Claim Missing EVM Claim-Margin Gate (2026-06-12 follow-up)

Affected flows:

- EVM → Canton email (`POST /api/htlc/{id}/claim-managed`)
- `claimCounterAsBackend` in `lib/htlc-service-singleton.ts`

Risk:

The Loop reveal path (`claimCounter`) called `verifyEvmLock` before delivering CBTC, ensuring the solver had enough time to claim WBTC after reveal. The managed path did not. A user could reveal near `userTimelock`, receive CBTC, and still `retake` WBTC after the solver ran out of time.

Implemented approach:

- `claimCounterAsBackend` now calls `verifyEvmLock(o)` for `evm-to-canton` orders before exercising `HtlcLock.Claim`.

Status: Fixed.

See also: `docs/HTLC-SECRET-VAULT.md` (Issue B) for client vault context.

## Follow-up: whole-codebase review (2026-06-13)

A full security + HTLC-design-conformance review (every API route, the solver
daemon, keccak parity, the secret vault, env/deploy/RLS, and quote/amount binding)
confirmed the five core HTLC invariants hold and found no CRITICAL/HIGH auth bypass.
Fixes applied from that review:

- **Quote tolerance is a drift buffer only (was 1%, now 30bps).**
  `ORDER_AMOUNT_TOLERANCE_BPS` in `lib/htlc-quote.ts`. The platform fee is already
  subtracted inside the quote (`finish` → `fresh.outUnits` is net of fee), so the
  validation slack must cover ONLY ~60s of honest price drift, not also "exceed the
  fee." The old 1% let a user reclaim the fee as a standing skim against solver
  float on every order. Status: Fixed.

- **Defense-in-depth EVM-lock check in `recordCounterClaimed`.**
  `lib/htlc-service-singleton.ts`. The record-only reveal path now calls
  `verifyEvmLock` for any `evm-to-canton` order. Safe before (forward managed
  rejected; forward Loop reveals via `claimCounter`), but now a future change that
  routes a forward order here cannot become a late-reveal solver-robbery path.
  Status: Fixed.

- **Price cache stale window 10min → 90s + ops alert.** `lib/htlc-quote.ts`.
  A 10-min-stale price can defeat the de-peg breaker during a fast depeg that starts
  right after a source failure. Now refuses to quote beyond 90s and `alert()`s when
  serving stale. Status: Fixed.

- **RLS lockdown for `htlc_orders` + `solver_orders`.**
  `supabase/migrations/010_htlc_orders_rls_lockdown.sql`. These tables had RLS
  disabled (server-only by convention); now anon/authenticated grants are revoked
  and RLS is enabled (deny-all; service_role bypasses) so order data can't be read
  via the public anon key. Status: Fixed (apply the migration).

- **`NEXT_PUBLIC_HTLC_ESCROW` fails closed in production.**
  Single resolver `HTLC_ESCROW_ADDRESS` in `lib/swap-evm.ts` (used by the service,
  swap page, and orders page). A mainnet deploy that forgets the var now throws
  instead of silently pointing the EVM leg at the Base-Sepolia testnet escrow.
  Status: Fixed.

- **Credential-adjacent logging removed.** `lib/auth.ts`. `clientId`/`tokenUrl`
  now log only in dev; the raw Authentik error body is no longer dumped. Status: Fixed.

Still open (tracked, pre-mainnet): rotate the devnet Keycloak secret (confirm it's
not in git history); add a v1-vault TTL purge; Tier-2 non-extractable IndexedDB vault key.

Closed from the same review (2026-06-13 follow-up):

- **`__setLoopUnlockBypassForTests` production guard.** `lib/secret-vault.ts` throws if
  called when `NODE_ENV === "production"`. Status: Fixed.

- **`swap-solver/src/htlc-swap-service.ts` marked reference-only.** Header documents that
  production lifecycle is `lib/htlc-service-singleton.ts`; this file has no margin check
  and is for tests/docs only. Status: Fixed.

- **App `generateSecret` / `secretToPreimage` canonical vector test.** `lib/htlc-client.test.ts`
  pins the EVM/Daml hashLock parity vector. Status: Fixed.

- **Stale GET comment removed.** `app/api/htlc/route.ts` now points to `/api/htlc/history`.
  Status: Fixed.

- **Quote module header doc drift.** `lib/htlc-quote.ts` file comment now says 90s stale window.
  Status: Fixed.

- **Migration 010 RLS lockdown.** `supabase/migrations/010_htlc_orders_rls_lockdown.sql`
  — paste into Supabase SQL Editor (revoke anon/authenticated grants + enable RLS with
  no policies; service_role bypasses). Status: Fixed (applied on dev project).

## Operational Notes

- Upload `canton-htlc/.daml/dist/cbtc-htlc-hardened-0.1.0.dar` to the participant before enabling on-ledger HTLC flows that use the hardened package id.
- Set `CBTC_HTLC_PKG_ID` to the new package id after upload.
- Set `HTLC_DAEMON_SECRET` or `CRON_SECRET` in production so daemon-only routes are usable by the solver and cron but closed to public callers.
- Loop profile verification now fails closed if the Loop API profile does not expose a party id in one of the supported fields.
