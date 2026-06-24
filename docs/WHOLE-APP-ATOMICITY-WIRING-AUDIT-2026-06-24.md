# Whole-App Atomicity and Wiring Audit — 2026-06-24

This document records the audit pass performed after the broader swap reliability review. It focuses on whether the app enforces the product contract in code:

- managed/email cross-chain swaps should preserve HTLC economic atomicity;
- managed/email C2C swaps should settle atomically in one Canton transaction where possible;
- Loop swaps are trust-minimized, not fully trustless, because Loop cannot vet the custom HTLC DAR;
- Loop flows must still be exact-matched, proof-gated, recoverable, and never falsely shown as complete;
- no backend, daemon, or UI surface should mark external state complete unless the required ledger/EVM proof exists.

## Executive summary

The main issue found was not one isolated UI bug. The app had several places where raw lifecycle states were treated as truth without checking the proof required for that specific flow. That created the exact class of failures seen in testing: Loop swaps could appear complete before the Loop accept proof existed, daemon logic could observe a preimage too early, and status pages could show misleading terminal states.

This pass adds executable invariant checks, gates daemon preimage access, makes completion proof-aware, and aligns `/orders` and `/swap/orders/[id]` with one status projector.

Local validation is clean:

- `npm run typecheck`
- `npm --prefix swap-solver run typecheck`
- `npm test`
- `npm --prefix swap-solver test`

Funded devnet smoke tests are still required before calling the whole system fully validated.

## Findings and fixes

### 1. Loop forward HTLC could expose the preimage before CBTC delivery was proven

Affected flow: WBTC → CBTC with Loop wallet.

Risk: once the user reveals the preimage, the solver can claim the WBTC. For Loop users, CBTC is delivered through standard transfers, not the custom HTLC claim. If the preimage becomes visible to the daemon before the exact CBTC delivery/accept proof exists, the solver can claim WBTC while the user only has a pending or unproven CBTC offer.

Fix:

- Added `htlcCanExposePreimageToSolver` in `lib/swap-product-invariants.ts`.
- `/api/htlc/[id]/preimage` now refuses daemon preimage access unless the flow-specific proof gate passes.
- `/api/htlc/active` scrubs `revealedPreimage` from forward orders until that same gate passes.
- `recordMainClaim` now refuses to mark a forward swap complete unless the proof gate passes.
- The HTLC solver daemon now checks Loop delivery proof before attempting EVM WBTC claim.

Required Loop forward proof is now:

- `counterTransferUpdateId` exists, and
- `counterClaimUpdateId` exists, and
- solver EVM claim tx exists before visible completion.

### 2. Forward Loop accept recording was not strict enough

Affected flow: WBTC → CBTC with Loop wallet when CBTC delivery creates a pending Loop transfer offer.

Risk: the order could move through `counter_claimed` without proving that the user accepted the exact CBTC offer for that order.

Fix:

- `recordCounterClaimed` now verifies the submitted Loop accept update consumed the exact `counterTransferOfferCid`.
- Direct/preapproved delivery is only accepted when the original transfer update proves receiver delivery.
- Missing offer is no longer treated as proof of delivery.
- If delivery was direct/preapproved, the service persists `counterClaimUpdateId = counterTransferUpdateId`.

Result: the daemon cannot use the preimage just because the user clicked claim; it must see exact delivery/accept evidence.

### 3. Loop forward direct delivery recovery was ambiguous

Affected flow: WBTC → CBTC with Loop wallet and TransferPreapproval/direct delivery.

Risk: if the standard transfer completed directly, recovery code could previously confuse “no pending offer found” with “delivery happened.” That is unsafe because absence of a pending offer can also mean propagation lag or an unpersisted offer id.

Fix:

- Direct delivery is now recovered from the original ledger update tree.
- The recovery parser checks sender, receiver, amount, instrument, and order-bound memo.
- The service fails closed when the original update does not prove either:
  - exact pending offer creation, or
  - direct receiver delivery.

### 4. Reverse Loop custody matching needed stronger order binding

Affected flow: CBTC → WBTC with Loop wallet.

Risk: custody detection could be ambiguous when matching by sender/receiver/amount/instrument only, especially with repeated test swaps of identical amounts.

Fix:

- Reverse Loop custody transfers now include an order-bound memo.
- Solver-side confirmation prefers the exact memo.
- Legacy no-memo fallback is restricted by time window and still fails closed on ambiguity.
- The daemon now reconciles `main_locking` Loop reverse orders by retrying custody confirmation instead of leaving the browser solely responsible for recovery.
- Propagation lag no longer rolls the order back to `accepted`; it stays recoverable and retryable.

### 5. C2C swaps could look complete while the counter leg still needed acceptance

Affected flows: C2C Loop and any C2C path that creates a pending counter offer.

Risk: `filled` was too coarse. A C2C fill can consume the user sell leg and create an incoming counter offer. That is not user-visible completion until direct delivery is proven or the exact counter offer is accepted.

Fix:

- Added `c2cVisibleCompleted` in `lib/swap-product-invariants.ts`.
- C2C visible completion now requires:
  - `status === "filled"`,
  - `settlementUpdateId`, and
  - if `counterLegOfferCid` exists, `counterReceiptUpdateId`.
- History logic now keeps “accept counter leg” available even when the DB status is `filled` but the receipt proof is missing.

### 6. UI status was coupled to raw backend state names

Affected surfaces:

- `/orders`
- `/swap/orders/[id]`
- order details modal

Risk: users saw raw/internal lifecycle states or misleading terminal labels. Examples: `counter_locked`, `counter_claimed`, or `filled` being rendered as complete without proof.

Fix:

- Added `lib/swap-status-projector.ts`.
- `/orders` and `/swap/orders/[id]` now derive labels from proof-aware projection instead of raw DB status.
- Raw statuses are mapped to user-level states:
  - `counter_locked` → “Ready to claim”
  - Loop forward `counter_claimed` without accept proof → “Accept pending”
  - `main_claimed` without required proof → “Finalizing”
  - C2C `filled` with pending counter offer → “Accept pending”
- Polling now stops only when the proof-aware projector says the order is terminal.

### 7. Forward Loop accept recovery still depended on the original local secret

Affected flow: WBTC → CBTC with Loop wallet after the user already revealed the preimage and a pending CBTC offer exists.

Risk: if the user refreshed or reopened the status page, accepting the exact CBTC offer still tried to recover the locally stored secret. After reveal, the preimage is already server-recorded and the remaining step is Loop accept proof, so this could block valid recovery.

Fix:

- `/swap/orders/[id]` now uses `order.revealedPreimage` for the accept-pending Loop path when available.
- It only falls back to local secret recovery if the server-recorded preimage is not yet visible.

### 8. Privileged route ownership model was rechecked

Audited areas:

- HTLC claim/record/preimage/daemon routes
- C2C prepare/confirm user leg routes
- C2C prepare/confirm counter accept routes
- transfer create/accept routes
- mint/redeem privileged routes

Result:

- Swap routes use order-owner or daemon guards for state-changing paths.
- Transfer create/accept resolves the caller party server-side instead of trusting client-supplied sender/receiver authority.
- Mint/redeem routes derive the acting party from session resolution and do not blindly trust body `partyId`.
- No additional ownership bug was found in this pass.

## Executable invariant matrix added

The new invariant matrix lives in `lib/swap-product-invariants.ts` and covers:

1. HTLC WBTC → CBTC managed
2. HTLC WBTC → CBTC Loop
3. HTLC CBTC → WBTC managed
4. HTLC CBTC → WBTC Loop
5. C2C managed
6. C2C Loop

Each flow defines:

- atomicity model;
- who signs;
- when user funds move;
- when solver/vault funds move;
- when preimage exposure is allowed;
- required completion proof;
- refund/recovery path.

Tests were added in `lib/swap-product-invariants.test.ts`.

## Files touched by this audit pass

Core invariant/status files:

- `lib/swap-product-invariants.ts`
- `lib/swap-product-invariants.test.ts`
- `lib/swap-status-projector.ts`

HTLC proof and daemon wiring:

- `app/api/htlc/[id]/preimage/route.ts`
- `app/api/htlc/active/route.ts`
- `lib/htlc-service-singleton.ts`
- `lib/htlc-client.ts`
- `swap-solver/src/htlc-solver-daemon.mts`

C2C proof/status wiring:

- `lib/canton-swap-history.ts`
- `lib/canton-swap-history.test.ts`

User-facing status surfaces:

- `app/orders/page.tsx`
- `app/swap/orders/[id]/page.tsx`

## Validation performed

Local checks passed after the final patch:

```bash
npm run typecheck
npm --prefix swap-solver run typecheck
npm test
npm --prefix swap-solver test
```

The test suite now includes specific guards for:

- all six swap flow invariant entries;
- Loop forward not exposing preimage until delivery/accept proof exists;
- Loop forward not rendering visible completion without delivery proof and EVM claim tx;
- managed forward requiring Canton claim proof;
- C2C `filled` not being visible-complete while a counter offer is pending;
- C2C direct settlement completing only with settlement proof.

## Remaining required devnet smoke tests

These were not executed in this local pass and must be run before final confidence:

1. WBTC → CBTC managed/email happy path.
2. WBTC → CBTC Loop direct-delivery/preapproval path.
3. WBTC → CBTC Loop pending-offer accept path.
4. CBTC → WBTC managed/email happy path.
5. CBTC → WBTC Loop custody path.
6. C2C managed direct fill.
7. C2C Loop sell offer + counter accept path.
8. Refresh/reopen `/swap/orders/[id]` at every intermediate state.
9. Kill/restart web and `npm run solver:htlc` after each external commit point.

Acceptance criteria for those smoke tests:

- no flow shows `Completed` without the required proof fields;
- no Loop path is described as fully atomic;
- no raw internal status is visible to users;
- pending Loop accepts remain actionable after refresh;
- daemon does not claim WBTC before Loop CBTC delivery/accept proof;
- C2C pending counter offer does not appear terminal until accepted/proven.

## Current risk assessment

Local code-level risk is reduced materially by the new proof gates and projector. The remaining risk is integration/runtime behavior:

- Loop provider popup timing and update-id propagation can only be fully proven in browser/devnet.
- Canton update visibility across participants can lag; the code now retries/fails closed, but UX timing still needs smoke testing.
- Existing legacy orders without order-bound memos are handled conservatively; identical-amount legacy offers can fail closed as ambiguous.
- EVM finality/nonce behavior is still best proven by running funded devnet swaps with the solver daemon active.

Do not mark this work production-complete until the devnet smoke matrix above passes.
