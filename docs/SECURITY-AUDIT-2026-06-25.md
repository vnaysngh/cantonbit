# Whole-App Security Audit — 2026-06-25

Full-application security audit per `.cursor/rules/security-audit.mdc` (whole app, source
read directly, threat model includes solvency / double-pay / mis-reconciliation — not only
external-attacker paths).

**Method:** 11 domain reviewers reading source directly → adversarial verification per
candidate → gap sweep. **166 files read.** 36 candidates → **20 findings survived**
(3 HIGH, 11 MEDIUM, 6 LOW). All 3 HIGH re-verified by hand against the source.

**Status legend:** ✅ fixed · ⬜ open · ⏭ deferred · severity from verified impact.

**Remediation pass (2026-06-24):** 17/20 findings fixed in code (H-3 explicitly deferred).
276/276 tests pass after fixes. Apply migration `040_unified_vault_cbtc_float_reservation.sql`
before deploying cross-family reservation changes.

---

## 1. Scope map

- **API routes (87):** `htlc/*`, `canton/swap/*`, `mint/*`, `redeem/*`, `transfers/*`,
  `parties/*`, `solver/[...path]` proxy, `swap/session`, `canton/packages/*`.
- **Daemons:** `swap-solver/src/{htlc-solver-daemon,canton-swap-daemon,health-server,hygiene-sweep}.mts`.
- **Contract:** `contracts/src/HTLCEscrow.sol` (verified clean for reentrancy / claim-XOR-retake).
- **Migrations:** `supabase/migrations/*` (reservation RPCs 029/030/037 + **040** unified CBTC lock).
- **Cron:** `vercel.json` → `/api/htlc/auto-refund`.

## 2. Findings

### ✅ FIXED this session

**Unauthenticated debug routes exposing the privileged validator JWT** —
`app/api/canton/packages/route.ts`, `app/api/canton/packages/[id]/route.ts`. Gated behind
`requireDaemon` + `encodeURIComponent` on the segment.

**H-1 · Cross-family vault double-reservation → insolvency** — ✅
Migration `040_unified_vault_cbtc_float_reservation.sql`: shared helper
`sum_vault_cbtc_reserved_sats()` and advisory lock key `vault-cbtc-float:{party}` for both
`accept_htlc_order_with_float_reservation` and C2C `reserve_canton_swap_float` when
`to_asset = 'CBTC'`.

**H-2 · IP rate-limit fully bypassable** — ✅
`lib/canton-swap-rate-limit.ts`: client IP from rightmost trusted `X-Forwarded-For` hop only;
`x-real-ip` no longer trusted (also closes L-1).

**M-1 · Refund re-picks live holdings** — ✅
`refundMainCanton` / `refundCounter`: `fetchTransactionTreeByCommandId` before re-sending when
recovering Loop custody refunds or managed HtlcLock refunds.

**M-2 · C2C float TOCTOU** — ✅ (partial)
Retry loop re-reads ledger float immediately before each RPC attempt (`canton-swap-service.ts`,
`htlc-service-singleton.ts` accept). Full ledger-inside-SQL remains impractical; unified lock
(H-1) closes the cross-family race.

**M-3 · Stale amuletPrice** — ✅
`parseAmuletPriceFromMiningRounds` selects the highest `round.number`.

**M-4 · Web mainnet guard** — ✅
`lib/mainnet-guard.ts` + middleware guard on `/api/htlc`, `/api/canton/swap`, `/api/mint`,
`/api/redeem` when `NEXT_PUBLIC_NETWORK=mainnet` without `ALLOW_MAINNET=true`.

**M-5 · Server vault IDs from NEXT_PUBLIC_*** — ✅
`expectedSettlementParty`, `expectedSolverCanton`, `expectedSolverEvm` use server env only.

**M-6 · Mint/redeem rate limits** — ✅
`lib/mint-redeem-guard.ts` wired on all `mint/*` and `redeem/*` routes (IP + party/user).

**M-7 · EVM unlockTime not bound to userTimelock** — ✅
`assertEvmLockSafeForReveal` checks `expectedUserTimelock` within 120s; wired in `verifyEvmLock`.

**M-8 · EVM finality default too low in prod** — ✅
`evmMinConfirmations()` defaults to **12** in production when `EVM_MIN_CONFIRMATIONS` unset.

**M-9 · network-fee estimate trusts client vaultParty** — ✅
Forces `expectedCantonSwapParty()` server-side; 503 if unset.

**M-10 · OAuth origin spoofing** — ✅
`lib/request-origin.ts`: `PUBLIC_SITE_ORIGIN` / `PUBLIC_SITE_ORIGINS` allowlist when configured.

**M-11 · Wide CSP connect-src** — ✅
`proxy.ts`: explicit `connect-src` from network config + Supabase + Loop; optional
`CSP_CONNECT_SRC_EXTRA`. Trusted-Types already present in production CSP.

**L-1 · x-real-ip spoofing** — ✅ (folded into H-2 fix)

**L-2 · Loop quote party unverified** — ✅
`authorizeQuoteParty` now requires Loop session party match (same as write paths).

**L-3 · auto-refund comment mismatch** — ✅
Route header comment updated to match fail-closed auth.

**L-4 · Solver proxy GET orders without ownership** — ✅
GET `/orders` list requires daemon; GET `/orders/:id` requires `cantonParty` + session match
and post-fetch `cantonParty` equality check.

**L-5 · fail-open pending check in receipt proof** — ✅
`verifyCounterLegReceiptProof` uses `listPendingOffersStrict`.

**L-6 · Auto-refund failures don't affect /ready** — ✅
`health-server.mts` adds `pollFail()`; HTLC daemon calls it on auto-refund sweep errors.

### 🔴 HIGH (remaining)

**H-3 · Mint can pay the WRONG user** — ⏭ deferred (explicit product decision)
`lib/mint-processor.ts:808` — resolve ownership by `depositAccountContractId` only; never
by non-unique `bitcoin_address`.

### 🟡 MEDIUM (11) — all ✅ except notes above

| # | Status | Location | Issue | Fix applied |
|---|---|---|---|---|
| M-1 | ✅ | `htlc-service-singleton.ts` | Refund double-pay window | Ledger-truth before re-send |
| M-2 | ✅ | `canton-swap-service.ts` | Float TOCTOU | Retry + fresh read; H-1 lock |
| M-3 | ✅ | `canton-scan-pricing.ts` | Stale amuletPrice | Latest mining round |
| M-4 | ✅ | `proxy.ts` + `mainnet-guard.ts` | No web mainnet guard | ALLOW_MAINNET gate |
| M-5 | ✅ | `htlc-auth.ts` | NEXT_PUBLIC_* vault fallback | Server env only |
| M-6 | ✅ | `mint/*`, `redeem/*` | No rate limits | `requireMintRedeemRateLimit` |
| M-7 | ✅ | `htlc-evm-lock-guard.ts` | unlockTime unbound | `expectedUserTimelock` check |
| M-8 | ✅ | `htlc-evm-counter-lock.ts` | 3-conf default | Prod default 12 |
| M-9 | ✅ | `network-fee/estimate` | Client vaultParty | Server settlement party |
| M-10 | ✅ | `request-origin.ts` | OAuth origin spoof | Allowlist env |
| M-11 | ✅ | `proxy.ts` | Wide connect-src | Explicit allowlist |

### ⚪ LOW (6) — all ✅

| # | Status | Location | Issue |
|---|---|---|---|
| L-1 | ✅ | `canton-swap-rate-limit.ts` | x-real-ip spoofing |
| L-2 | ✅ | `htlc-auth.ts` | Unverified Loop quote party |
| L-3 | ✅ | `htlc/auto-refund/route.ts` | Misleading comment |
| L-4 | ✅ | `solver/[...path]/route.ts` | Unauthenticated order read |
| L-5 | ✅ | `canton-swap-settle.ts` | Fail-open pending check |
| L-6 | ✅ | `htlc-solver-daemon.mts` | Sweep failures ignored by /ready |

## 3. Sibling-path compare (reconcile / reissue)

Reconcile/reissue paths verified **clean** this round. **L-5** fail-open pending check is
now closed (`listPendingOffersStrict` in `verifyCounterLegReceiptProof`).

## 4. Auth / config parity

Parity gaps from the original audit (**H-2**, **M-4**, **M-5**, **M-8**, **L-1**, **L-2**)
are addressed. Deploy checklist:

- Set `CANTON_SWAP_SETTLEMENT_PARTY`, `SOLVER_EVM`, `SOLVER_CANTON_PARTY` server-side (no
  `NEXT_PUBLIC_*` fallback for fund identities).
- Set `ALLOW_MAINNET=true` on web + daemons for mainnet.
- Set `PUBLIC_SITE_ORIGIN` or `PUBLIC_SITE_ORIGINS` for OAuth callback base URL.
- Set `TRUSTED_PROXY_HOPS` to match Railway/edge XFF depth (default `1`).
- Apply migration **040** on Supabase before enabling concurrent HTLC + C2C CBTC load.

## 5. Doc vs code

- **L-3**: auto-refund comment now matches fail-closed auth. ✅
- `SWAP-QUOTE-DESIGN.md` P1/P2 claims still verified accurate.

## 6. Funds-path notes

- **HTLC / C2C:** H-1 unified reservation is the critical solvency fix; M-1/M-7/M-8 residuals
  closed in this pass.
- **Mint/redeem:** M-6 rate limits added; **H-3** remains the open funds-path item.

## 7. Files read

166 files (full list in the audit workflow result; available on request).

## 8. Gaps / not fully verified

- **M-10/M-11** exploitability still depends on deploy config (allowlist env vars, CSP extras).
  Confirm production values before launch.
- **H-3** deferred by product choice — still the highest-risk open item in mint/redeem.

## Recommended order of remaining work

1. **H-3** (mint resolve-by-contract-id) when ready to touch mint processor.
2. Deploy migration **040** + verify concurrent HTLC/C2C CBTC reservation under load.
3. Confirm production env: `PUBLIC_SITE_ORIGIN`, `TRUSTED_PROXY_HOPS`, `EVM_MIN_CONFIRMATIONS`,
   `ALLOW_MAINNET`, settlement party server vars.
