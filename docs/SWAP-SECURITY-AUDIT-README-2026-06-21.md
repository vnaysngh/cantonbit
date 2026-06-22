# Swap Security Audit README — 2026-06-21

## Remediation status — 2026-06-21

The release-blocking code findings in this report have been remediated in the
current worktree. This is still not a production certification: migrations
`029`–`039` must be applied in order, deployment configuration must be checked,
and funded end-to-end smoke swaps must pass on the target network.

Implemented controls:

- C2C quotes now require an independent fail-closed BTC/USD and CC/USD sanity
  bound at quote and settlement time, with strict server-side amount caps.
- Full-row lifecycle upserts were removed from the HTLC and C2C services. State
  changes now use compare-and-swap updates or serialized reservation RPCs.
- Forward CBTC, reverse WBTC, and C2C counter-asset inventory are reserved
  atomically. Reverse WBTC is reserved before user Canton funds are locked or
  transferred into custody.
- Reverse Allocation and `HtlcLock` commits are recoverable by deterministic
  command ID, with exact party, amount, instrument, hashlock, and timelock checks.
- EVM settlement evidence requires configurable confirmations and revalidates the
  receipt block hash before the Canton-side irreversible action.
- Loop custody evidence is persisted, exact, ambiguity-rejecting, and unique.
  `counter_locking` and `refunding` are mutually exclusive lifecycle claims.
- C2C counter receipt recovery scans from the persisted creation offset and
  refuses reissue without complete acceptance evidence.
- Managed C2C refuses to consume the user sell leg unless the counter delivery is
  direct in the same Canton transaction.
- Refund and delivery commands use deterministic IDs and recover committed
  transaction trees after request/DB crashes.
- Separate Loop CC fee collection was removed. Loop traffic cost is covered by
  the platform spread, eliminating the non-atomic “fee paid, swap failed” state.
  Managed/email fees remain inside the atomic Canton settlement transaction.
- Managed fee accounting uses durable outbox fields and reconciliation.
- Distributed Postgres rate limits, nonce CSP, production Trusted Types,
  dependency upgrades, and restrictive local secret-file modes were added.

Residual protocol limitations:

- Loop EVM→Canton remains trust-minimized rather than trustless: revealing the
  secret creates a durable venue delivery obligation, not a cross-participant
  on-ledger hashlock.
- Loop Canton→EVM remains custodial during settlement because the Loop
  participant cannot execute the custom HTLC DAR and the standard allocation
  primitive cannot be settled cross-participant with the required authorities.
- Browser-held secrets cannot be protected from a successful same-origin XSS.
  CSP/Trusted Types reduce that risk but do not make browser storage a hardware
  security boundary.
- Production rollout still needs migration execution, environment checks,
  alerting, and funded recovery drills.

## Scope

This audit covers the current implementation of:

1. Cross-chain WBTC↔CBTC swaps with participant-managed/email wallets.
2. Cross-chain WBTC↔CBTC swaps with Loop wallets.
3. Canton CBTC↔CC swaps with participant-managed/email wallets.
4. Canton CBTC↔CC swaps with Loop wallets.
5. Platform-fee and Canton network-fee design for both swap families.

The review includes protocol design, authorization, state transitions, database
concurrency, ledger/EVM recovery, pricing, inventory reservation, failure handling,
refunds, fee accounting, dependencies, and fund-safety edge cases.

The detailed findings below preserve the original audit state and required-fix
rationale. The remediation section above describes the current worktree.

## Executive verdict

The release-blocking code defects have been addressed. Mainnet enablement remains
conditional on applying the new migrations and passing funded end-to-end and
failure-recovery tests against the exact deployed contracts and participants.

## What “atomic” means in this application

There are three different kinds of atomicity. They must not be treated as the same
property.

### 1. Single-ledger transaction atomicity

Canton guarantees that every command in one submitted transaction succeeds or the
whole transaction fails.

Example: accepting a user's pending sell offer and directly transferring the
counter asset in the same Canton update is atomic.

### 2. Cross-chain protocol atomicity

No transaction can commit simultaneously on Canton and an EVM chain. Cross-chain
HTLCs instead provide *economic atomicity* through:

- one shared hashlock;
- staggered timelocks;
- claims that reveal the preimage;
- unilateral refund paths.

The two chain transactions still happen at different times. The protocol is atomic
only if the hashlock, timelocks, finality assumptions, watchtowers, and refund paths
are all implemented correctly.

### 3. Orchestrator/database atomicity

The database must not claim that an external action happened unless it did, and two
workers must not execute conflicting actions for the same order.

Examples:

- `main_locked` must not be overwritten by a stale `cancelled` write.
- `refunding` and `counter_locking` must be mutually exclusive.
- inventory reservation and status transition must occur in one serialized
  database transaction.

This layer is currently incomplete in both HTLC and C2C flows.

## Atomicity by flow

| Flow | Current atomicity | Important limitation |
|---|---|---|
| Cross-chain, managed/email | Economic HTLC atomicity with durable recovery | Still depends on configured EVM confirmation depth and active refund/watchtower operations |
| Cross-chain, Loop buyer, EVM→Canton | Trust-minimized venue delivery obligation | Preimage disclosure and cross-participant standard transfer cannot be one Canton/EVM transaction |
| Cross-chain, Loop seller, Canton→EVM | Custodial during settlement | WBTC is reserved first and custody is recoverable, but the venue temporarily controls CBTC |
| C2C, managed direct delivery | Atomic in one Canton update | Quote/reference services and DB reservation occur before the ledger submit |
| C2C, Loop counter offer | Atomic user-sell consumption + counter-offer creation | Final receipt requires the user's later Loop accept; strict receipt proof prevents double reissue |

## Release-blocking findings

### SEC-01 — C2C quote manipulation can drain the settlement vault

**Severity:** Critical  
**Affected:** Managed and Loop C2C

[`lib/canton-quote.ts`](../lib/canton-quote.ts) reads `user_gets` from the
Tradecraft quote API and uses that amount to determine how much the Oranj settlement
vault pays. The settlement does not execute against Tradecraft liquidity, so
Tradecraft is functioning as a price oracle rather than as the settlement venue.

The independent BTC/USD × CC/USD sanity check in
[`lib/canton-quote-sanity.ts`](../lib/canton-quote-sanity.ts) is disabled and is not
called by the C2C quote path.

An attacker who can manipulate the underlying AMM price, compromise the quote API,
or exploit a bad quote can make the vault deliver excess CBTC or CC.

The impact is amplified because the server does not enforce the limits in
[`lib/swap-amount-limits.ts`](../lib/swap-amount-limits.ts); those limits are
currently UI-only.

**Required fix:**

- Enforce a fail-closed independent reference-price bound on every quote and again
  immediately before settlement.
- Add server-side maximum input, maximum output, per-user exposure, and daily
  notional limits.
- Reject quotes outside the reference band even if Tradecraft returns HTTP 200.
- Treat Tradecraft as an executable venue only if the same transaction actually
  consumes Tradecraft liquidity. Otherwise treat it as an untrusted oracle input.

### SEC-02 — Stale HTLC writes can overwrite irreversible state

**Severity:** Critical  
**Affected:** Managed and Loop cross-chain

[`lib/htlc-service-singleton.ts`](../lib/htlc-service-singleton.ts) contains
lifecycle functions that read an order, perform work, mutate the in-memory object,
and call the full-row upsert in
[`lib/htlc-order-store.ts`](../lib/htlc-order-store.ts).

For example, `cancel()` can read `accepted` while another request is committing a
Canton lock. The stale cancellation can then write `cancelled` and clear contract
IDs from the row after the ledger lock has committed. The refund worker no longer
has the CIDs needed to recover the user's funds.

**Required fix:**

- Replace lifecycle upserts with status/version compare-and-swap operations.
- Claim an operation state before every irreversible external action.
- Store immutable terms separately from mutable lifecycle fields.
- Never let a stale row update set existing contract IDs or transaction IDs to
  `NULL`.

Recommended HTLC operation states:

```text
open
  → accepting
  → accepted
  → main_locking
  → main_locked
  → counter_locking
  → counter_locked
  → claiming
  → claimed

main_locked | counter_locked
  → refunding
  → refunded
```

Only one transition should be claimable from a given status.

### SEC-03 — Loop custody baseline is not persisted

**Severity:** Critical  
**Affected:** Loop cross-chain Canton→EVM

`solverCustodyBaselineCids` is captured in
[`lib/htlc-service-singleton.ts`](../lib/htlc-service-singleton.ts) and exists in
[`lib/htlc-types.ts`](../lib/htlc-types.ts), but
[`lib/htlc-order-store.ts`](../lib/htlc-order-store.ts) does not serialize it and no
migration adds a column.

After a reload, `confirmLoopSellerLock()` can build a new baseline that already
contains the user's auto-accepted holding. That holding is then never recognized as
the order's deposit. The order stays `accepted`, while user CBTC is already in venue
custody and is not selected by the normal refund sweep.

**Required fix:**

- Persist the baseline or, preferably, bind the exact Loop submit update/created
  holding to the order.
- Add a unique reservation constraint for the custody holding CID.
- Reconcile accepted Loop orders for unmatched venue holdings and return unmatched
  funds automatically.

### SEC-04 — Loop custody refund can race with the EVM counter-lock

**Severity:** Critical  
**Affected:** Loop cross-chain Canton→EVM

`earlyRefundLoopCustody()` checks that no WBTC lock exists and only afterward moves
the order to `refunding`. The solver daemon may already be processing an earlier
`main_locked` snapshot and submit the WBTC lock after the refund check.

The user can then receive their CBTC refund while also retaining the preimage needed
to claim the solver's WBTC.

Relevant code:

- [`lib/htlc-service-singleton.ts`](../lib/htlc-service-singleton.ts)
- [`swap-solver/src/htlc-solver-daemon.mts`](../swap-solver/src/htlc-solver-daemon.mts)

**Required fix:**

- Add a durable `counter_locking` state or lease.
- The daemon must CAS `main_locked → counter_locking` before submitting the EVM
  transaction.
- Early refund must CAS `main_locked → refunding` before checking the chain.
- After winning its state, each side must recheck the order and chain before
  submitting.
- `counter_locking` and `refunding` must be mutually exclusive.

### SEC-05 — C2C counter recovery can double-pay

**Severity:** Critical  
**Affected:** Loop C2C and any managed C2C order using a counter offer

When a counter offer disappears from ACS, the service searches a bounded recent
update window for its acceptance. If the accept is older than that lookback, the
service concludes that the user did not receive the asset and reissues the counter
leg.

Relevant code:

- [`lib/canton-swap-settle.ts`](../lib/canton-swap-settle.ts)
- [`lib/canton-command-recovery.ts`](../lib/canton-command-recovery.ts)

**Required fix:**

- Persist the original settlement offset and counter-offer creation update.
- Search from that offset until the current ledger end, not from a fixed recent
  window.
- Persist an immutable “counter consumed/received” proof before permitting reissue.
- Require a CAS on both status and previous counter CID before submitting reissue.

## Cross-chain managed/email findings

### SEC-06 — EVM inclusion is treated as finality

**Severity:** High

The application accepts a successful receipt or a `"latest"` state read without a
chain-specific confirmation/finality policy. A reorg after Canton settlement can
remove the EVM lock or claim.

Relevant code:

- [`lib/htlc-service-singleton.ts`](../lib/htlc-service-singleton.ts)
- [`lib/htlc-evm-counter-lock.ts`](../lib/htlc-evm-counter-lock.ts)

**Required fix:**

- Record the EVM block number and block hash.
- Wait for a configured confirmation depth or safe/finalized tag before releasing
  the other leg.
- Revalidate the block hash before irreversible Canton settlement.
- Configure the policy separately for Base, Arbitrum, and test networks.

### SEC-07 — Reverse Canton lock crash recovery is incomplete

**Severity:** High

Reverse allocation and `HtlcLock` creation use deterministic command IDs, but a
ledger commit followed by a DB crash can leave the database without the created
CIDs. Retry receives a duplicate-command response and does not fully reconstruct
the missing allocation/HTLC state.

**Required fix:**

- Recover the transaction tree by command ID.
- Parse and validate the exact Allocation and `HtlcLock` created by that command.
- Repair the order row before continuing.
- Use exact parties, amount, instrument, settlement reference, hashlock, and
  timelock during recovery validation.

### SEC-08 — Solver EVM address validation fails open

**Severity:** High

The create route rejects a mismatched solver address only when `SOLVER_EVM` or
`NEXT_PUBLIC_SOLVER_EVM` is configured. If both are missing, the client-supplied
address is accepted.

**Required fix:**

- Refuse application startup and order creation if the canonical solver EVM address
  is missing.
- Overwrite the body value with the server-configured address rather than only
  comparing it.
- Verify the daemon hot key resolves to the same address during daemon startup.

### SEC-09 — Reverse WBTC inventory is not reserved

**Severity:** High

Multiple reverse orders may lock user CBTC while each order independently observes
the same solver WBTC balance. The daemon only checks balance immediately before
individual EVM lock submission.

**Required fix:**

- Reserve WBTC inventory before the user's Canton leg is locked.
- Serialize reservation by solver wallet and chain.
- Release reservations on cancel, refund, failed lock, or terminal settlement.

### SEC-10 — Refund commands are not uniformly crash recoverable

**Severity:** Medium

Some `refundHtlcLock` paths do not use deterministic command IDs or reconstruct
committed results. A ledger commit followed by a DB failure can leave the order
stuck even though funds were returned.

**Required fix:**

- Add deterministic refund command IDs.
- Recover committed refund trees.
- Persist `refundUpdateId`.
- Keep `refunding` until ledger evidence proves completion.

## Cross-chain Loop findings

### SEC-11 — Loop seller offer matching can consume the wrong transfer

**Severity:** High

`confirmLoopSellerLock()` matches a pending offer by sender and an amount greater
than or equal to the order amount. It does not require exact base-unit equality or
the expected CBTC instrument.

A larger unrelated transfer from the same user can be accepted for a smaller swap,
leaving the surplus in venue custody.

**Required fix:**

- Require exact amount equality in CBTC base units.
- Require exact sender, receiver, instrument admin, and instrument ID.
- Bind the Loop submit update ID or expected offer CID to the order.
- Reject ambiguous multiple matches.

### SEC-12 — Accepted forward HTLC orders can reserve float indefinitely

**Severity:** High

Order owners can call the accept endpoint. Migration 029 counts `accepted` forward
orders as reserved inventory, but accepted orders have no expiry/release path.

An authenticated account can create and accept orders without locking WBTC and
reserve the solver's CBTC float indefinitely.

**Required fix:**

- Add an accepted-order TTL.
- Release reservation if the EVM main lock is not proven before the deadline.
- Rate-limit accepted exposure by authenticated user and EVM address.
- Consider making forward acceptance daemon-only after the EVM lock is observed.

Migration 029 should also avoid subtracting amounts already removed from active
holdings by a Canton allocation; otherwise float can be double-counted as both
absent from holdings and still reserved.

### SEC-13 — Browser secret persistence can silently fail

**Severity:** High

`writeStore()` catches storage errors, while `rememberSecret()` returns `true`
without a write/readback check. The UI can proceed to lock funds even though the
secret was not stored.

**Required fix:**

- Make `writeStore()` return success/failure.
- Read back and validate the stored ciphertext before returning success.
- Abort before any fund lock if persistence fails.
- Provide an explicit encrypted secret backup/export flow.

### SEC-14 — Loop vault encryption is not an XSS boundary

**Severity:** Medium

The Loop and managed vault keys are derived from values available to same-origin
JavaScript. A successful XSS can derive the key and recover preimages. The Loop
signature is used as an unlock gesture but is not cryptographically verified by the
vault code.

**Required fix:**

- Add a strict Content Security Policy and Trusted Types.
- Remove inline/eval-compatible script allowances.
- Keep keys in non-extractable WebCrypto/IndexedDB storage where possible.
- Treat the current vault as identity-bound obfuscation, not protection from XSS.

### SEC-15 — Loop reverse is custodial and the unilateral withdrawal route is dead

**Severity:** Design limitation

The implemented Loop reverse flow transfers CBTC to the venue. It does not create
the allocation expected by `prepareLoopSellerWithdraw()`, so `allocationCid` is
absent and the user cannot invoke that path.

Refund depends on venue services and the refund sweep.

**Required fix:**

- Remove misleading unilateral-withdrawal claims from the transfer-to-venue flow.
- Clearly label this mode as custodial during settlement.
- Add operational custody controls: segregated accounting, unmatched-deposit
  reconciliation, refund SLA, alerts, and emergency return tooling.

### SEC-16 — Loop buyer reveal and delivery are not atomically bound

**Severity:** Design limitation / High if marketed as atomic

For EVM→Canton Loop swaps, the user gives the preimage to the backend before the
standard CBTC transfer is completed. Once the preimage is stored, the solver can
claim WBTC even if CBTC delivery later fails or the user never receives/accepts the
counter offer.

This ordering protects the solver but requires the user to trust the venue's
delivery and recovery service.

**Required fix:**

- Market the flow as trust-minimized/custodial, not fully atomic.
- Persist a delivery obligation before exposing the preimage to the EVM claimer.
- Use deterministic delivery commands, recovery workers, and permanent
  user-credit accounting.
- Full trustless atomicity is not currently possible for Loop users while their
  participant cannot vet the custom HTLC DAR.

## C2C managed/email findings

### SEC-17 — C2C float reservation double-counts the current order

**Severity:** High

`sumReservedOut()` includes `open`, `settling`, `filling`, and `user_locked`.
Settlement then subtracts that reservation and separately requires the current
order's output again.

An order can pass the initial check and fail at settlement even when sufficient
float exists.

**Required fix:**

- Implement one database RPC that atomically reserves float and changes status.
- Exclude the current order from subsequent availability calculations.
- Store explicit reservation rows/amounts rather than inferring reservations from
  lifecycle status.

### SEC-18 — Unsigned C2C orders can reserve vault inventory

**Severity:** High

Open orders are included in reservation totals even before a Loop user signs a sell
offer. Repeated authenticated order creation can deny service to other users.

**Required fix:**

- Do not reserve inventory for unsigned open drafts.
- Reserve only when a managed settle operation starts or a Loop user leg is
  cryptographically/ledger verified.
- Add per-user open-order limits and short draft TTLs.

### SEC-19 — Managed counter offers have no reliable expiry recovery

**Severity:** High

If the managed user's counter leg is not direct, settlement can consume the user's
sell asset and create a counter offer. Managed orders remain `settling`, do not
expire, and are skipped by the Loop-only counter-reissue worker.

**Required fix:**

To guarantee atomic delivery for managed users, require the counter leg to be
`direct` before consuming the sell leg. Because the backend can act as the managed
party, another valid design is a managed-only DVP/custom Daml settlement primitive
that completes both assets in one Canton transaction.

If counter offers remain supported:

- add managed counter reissue;
- add explicit backend acceptance where authorized;
- never mark terminal until receipt is proven.

### SEC-20 — Managed user offer is not persisted before fill

**Severity:** High

Managed settlement first creates the user's offer and then executes a separate fill
transaction. The offer CID is held only in local function state until fill
completes.

A process failure can leave the user offer locked but untracked by the order.

**Required fix:**

- Persist `userLegOfferCid` and an intermediate `user_offer_created` state
  immediately after the first transaction.
- Recover by deterministic command ID.
- Retry fill or reject the offer from that durable state.

## C2C Loop findings

### SEC-21 — Signed Loop offer can be stranded before confirmation

**Severity:** High

`confirmUserLeg()` verifies the signed offer and then runs a float check before
persisting the offer CID. If the float check fails, the order remains `open` and
does not track the user's 24-hour pending offer.

**Required fix:**

- Persist the verified offer CID first in a durable state such as
  `user_leg_verifying`.
- Atomically reserve float and transition to `user_locked`.
- If reservation fails, reject the exact user offer before returning failure.

### SEC-22 — Expiry marks orders terminal after reject failure

**Severity:** High

`expireStale()` logs a failed `rejectUserLegOffer()` call and still transitions the
order to `expired`. That order is no longer selected for the same cleanup, while
the user's sell offer may remain locked until its 24-hour ledger expiry.

**Required fix:**

- Add an `expiring` state.
- Mark `expired` only after rejection is proven or the offer is proven absent.
- Retry `expiring` rows indefinitely with alerting.

### SEC-23 — C2C creation is not first-write atomic

**Severity:** High

Both C2C and HTLC creation use “read existing, then upsert.” Two concurrent requests
can both observe no row and overwrite each other.

**Required fix:**

- Use insert-only creation: `INSERT ... ON CONFLICT DO NOTHING`.
- Reload the winner and compare all immutable terms.
- Reject an existing ID whose terms differ, even when the user party matches.

### SEC-24 — Fill recovery evidence is not strict enough

**Severity:** High

Recovery can infer success from incomplete event trees. Direct-delivery parsing does
not prove the sender relationship, and some counter-offer parsing call sites omit
the expected instrument.

**Required fix:**

- Require proof that the exact user offer was consumed.
- Require exact sender, receiver, amount, and instrument for the counter leg.
- Fail closed when either leg is not proven.
- Add negative tests for unrelated holdings, unrelated CC fee outputs, and partial
  event trees.

## Fee-design findings

### SEC-25 — Loop network fee can be paid twice

**Severity:** High

The wallet submits the CC fee first and then calls the API to record its update ID.
If recording fails, the browser has no durable pending-fee record. Retry can submit
another fee payment.

**Required fix:**

- Persist the returned update ID in browser recovery storage before calling the API.
- On retry, verify and record that existing update instead of creating a new
  payment.
- Bind one fee payment to one order with the existing global settlement-update
  uniqueness rule.

### SEC-26 — Loop fee is not atomic with swap completion

**Severity:** High

The Loop fee is a separate transaction that occurs before reveal and CBTC delivery.
The user can pay the fee even if the swap subsequently cannot complete.

**Required fix:**

- Make the fee a reusable order credit, refundable credit, or post-success charge.
- Do not describe the Loop fee as atomically collected with settlement.
- If Loop cannot submit the fee and swap command together, explicitly document the
  non-refundable policy and compensate failures automatically.

### SEC-27 — Managed fee accounting can be lost after collection

**Severity:** Medium

Managed Canton transactions collect the fee atomically with the swap action, but
some paths write `network_fee_ledger` only as a best-effort post-commit operation.
A database failure can permanently omit collected revenue from accounting.

**Required fix:**

- Add a durable outbox or reconciliation worker.
- Parse the committed Canton update to prove the fee leg and backfill missing rows.
- Do not rely only on the request process surviving after ledger commit.

### SEC-28 — Fee/notional safety guard is disabled

**Severity:** Medium

`assertNetworkFeeNotionalGuard()` is a no-op. Small swaps can incur network fees
greater than the swap's economic value.

**Required fix:**

- Reinstate a maximum fee-to-notional ratio.
- Add a minimum trade size when network fee collection is enabled.
- Display and bind the complete fee before the user signs.

### SEC-29 — Platform-fee configuration is not range validated

**Severity:** Medium

`PLATFORM_FEE_BPS` is converted with `Number()` and later converted to `BigInt`
without checking that it is an integer in a safe range. A negative value increases
user output; a fractional or malformed value can break quote execution.

**Required fix:**

- Parse once at startup.
- Require an integer between an explicit minimum and maximum, such as `0..1000`.
- Fail startup on invalid production configuration.
- Verify the public UI mirror matches the server value.

### SEC-30 — Server and UI fee flags can diverge

**Severity:** Medium / operational

The server uses `NETWORK_FEE_ENABLED`; the browser uses
`NEXT_PUBLIC_NETWORK_FEE_ENABLED`. A mismatched deployment can display no fee while
the server requires one, or prompt for a fee while collection is disabled.

**Required fix:**

- Return authoritative fee policy from the server.
- Make the UI render the server policy rather than an independent build-time flag.
- Add deployment health checks that compare the two values.

## Cross-cutting findings

### SEC-31 — Rate limiting is insufficient

**Severity:** Medium

HTLC order and quote routes do not have durable distributed rate limits. C2C quote
limiting is an in-memory map, resets on restart, is not shared across instances, and
uses forwarded headers as the client key.

**Required fix:**

- Use a distributed rate limiter keyed by authenticated user, Loop party, EVM
  address, and trusted proxy IP.
- Limit open orders, accepted exposure, quote cost, and concurrent ledger work.

### SEC-32 — No CSP/Trusted Types policy was found

**Severity:** Medium

This raises the impact of any XSS because same-origin JavaScript can access wallet
providers and derive the current browser secret-vault keys.

**Required fix:**

- Add a strict nonce/hash-based CSP.
- Enable Trusted Types.
- Audit third-party scripts and remove unnecessary runtime packages.

### SEC-33 — Production dependency advisories

**Severity:** High/Medium depending deployment reachability

`npm audit --omit=dev` reported five advisories:

- one high;
- three moderate;
- one low.

The high Hono advisory is pulled through `shadcn`, which is currently listed as a
production dependency even though it is normally a development/scaffolding tool.

**Required fix:**

- Move build/scaffolding-only packages to `devDependencies`.
- Upgrade Hono, Babel, js-yaml, Next/PostCSS as compatible.
- Re-run `npm audit --omit=dev` and document accepted residual risk.

### SEC-34 — Local treasury environment files are broadly readable

**Severity:** Medium / operational

Ignored environment files containing mainnet credentials were mode `0644`. They
were not found in tracked Git history, but other local users/processes may read
them.

**Required fix:**

```bash
chmod 600 .env.mainnet .env.devnet .env.local .env.development.local
chmod 600 swap-solver/.env.htlc-mainnet
```

Rotate any credential suspected of being copied into logs, screenshots, support
messages, or shared machines.

## How to make each flow atomic or as close as possible

### Managed cross-chain HTLC

A single transaction across EVM and Canton is impossible. The correct target is
trustless HTLC economic atomicity plus crash-safe orchestration:

1. Validate and bind canonical chain, escrow, token, solver address, amounts, and
   timelocks.
2. Reserve solver inventory atomically.
3. Use operation states and CAS before every chain submission.
4. Wait for configured EVM finality.
5. Use deterministic command/transaction recovery.
6. Keep independent watchtowers for preimage discovery.
7. Make every refund unilateral or automatically executable from durable evidence.

### Loop cross-chain HTLC

Full trustless atomicity is not available under the current Loop package-vetting
constraint because the Loop party cannot participate in the custom Canton HTLC.

Available choices:

1. Keep the current design but label it trust-minimized/custodial and harden the
   delivery/refund obligations.
2. Require a participant-managed wallet for fully trustless cross-chain swaps.
3. Revisit full standard-token DVP only if a proven settlement construction can
   execute without the Loop party being online or authorizing custom packages.
4. If Loop later vets the custom DAR, move the Loop party onto the same on-ledger
   hash-gated claim path as managed users.

### Managed C2C

For actual asset delivery to be atomic:

- require the user sell leg to remain a pending offer;
- require the counter leg to be direct;
- submit user-offer accept, counter direct transfer, and managed network fee in one
  Canton transaction.

If the counter leg would create an offer, stop before consuming the sell leg or use
a managed-only DVP/custom settlement contract.

### Loop C2C

The strongest currently available flow is:

1. Loop user creates a pending standard sell offer.
2. The service binds the exact CID and atomically reserves vault float.
3. The vault submits one transaction containing:
   - accept exact user offer;
   - direct counter transfer.

This requires the Loop user to have the appropriate counter-asset preapproval.

Without preapproval, the same transaction can only consume the sell offer and create
a counter offer. That atomically creates an obligation, but it does not atomically
deliver the asset. The UI and documentation must distinguish those guarantees.

### Fee atomicity

- Managed fees can be included in the same Canton transaction and are genuinely
  atomic with that Canton action.
- Loop fees are currently separate and cannot be called atomic with swap
  completion. Use reusable credits/refunds or charge only after delivery.
- Platform fees embedded in the quoted exchange rate are atomic only when the
  underlying swap settlement itself is safe and correctly priced.

## Recommended remediation order

1. Disable C2C mainnet fills until SEC-01 and server-side limits are fixed.
2. Implement versioned CAS state machines for HTLC and C2C.
3. Fix SEC-03 and SEC-04 before accepting additional Loop reverse custody.
4. Implement durable inventory reservations with TTL and release semantics.
5. Add EVM finality policies and deterministic recovery for every chain/ledger
   command.
6. Require direct counter delivery for “atomic” C2C claims.
7. Fix Loop fee recovery and credit/refund policy.
8. Add CSP, distributed rate limits, dependency upgrades, and operational key
   hardening.

## Latest validation after remediation — 2026-06-22

- Web unit tests: 221 passed.
- Solver unit tests: 114 passed.
- Web TypeScript check: passed.
- Solver TypeScript check: passed.
- ESLint: no errors; 57 existing warnings.
- `git diff --check`: passed.
- `npm audit --omit=dev`: 0 vulnerabilities.
- Stale Loop-fee prompt scan: no remaining app/lib/component/hook/solver matches
  for the old separate Loop CC network-fee flow.
- Secret-file modes: root and solver `.env*` files checked at `0600`.

Prior targeted `HTLCEscrow` Solidity tests covered correct claim, wrong preimage,
timelocks, receiver/sender authorization, double claim/lock prevention,
reentrancy-oriented ordering, and fee-on-transfer token rejection. No direct
exploit was found in the `HTLCEscrow` contract itself; the highest residual
release risks are migration execution, production configuration, funded
end-to-end smoke swaps, and recovery drills on the target network.
