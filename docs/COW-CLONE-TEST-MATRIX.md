# CoW-Clone Swap — Complete Test Matrix (the "done auditing" definition)

> Purpose: stop the whack-a-mole. This is the EXHAUSTIVE list of every assumption
> the no-pre-lock + Allocation design makes. "Audited" = every row here is either
> ✅ verified live, or explicitly accepted as residual risk with a reason. No row
> is left implicit. The throwaway e2e test must exercise every row marked [E2E].
>
> Honest status as of 2026-06-05: existing e2e tests (`e2e-base.ts`, `e2e-full.ts`)
> SIMULATE the Canton delivery (`// SIMULATE Canton delivery — marked delivered`),
> so the entire Canton allocate/execute/withdraw cycle is UNTESTED end-to-end.

Legend: ✅ verified live · 🟡 half-tested / inferred · ❌ untested · [E2E] must be in the e2e run

## A. EVM leg — no-pre-lock reorder

| # | Assumption | Status | Notes |
|---|---|---|---|
| A1 | `eth_call(openFor)` REVERTS on bad/empty signature | ✅ | tested live (both reverted) |
| A2 | `eth_call(openFor)` SUCCEEDS on a VALID order+sig (the other half) | ❌ [E2E] | only failure case tested; must prove valid one simulates clean |
| A3 | Holding the signed order and submitting `openFor` LATER still works (Permit2/order deadline not tripped) | ❌ [E2E] | core of the reorder — never tested |
| A4 | A valid `openFor` actually PULLS the WBTC when submitted post-delivery | ❌ [E2E] | the real money pull |
| A5 | The specific `openFor` revert reasons are decodable (bad-sig vs insufficient-balance vs expired) | ❌ | got "unknown"; needs the escrow custom-error ABI |
| A6 | Replay: same orderId can't be openFor'd twice | 🟡 | escrow has orderStatus; not re-tested in new flow |
| A7 | Permit2 deadline == fillDeadline binding holds | ❌ | spec'd, not built/tested |
| A8 | Reorg after cBTC delivered but before WBTC pulled | ❌ | accept as residual? model the window |

## B. Canton leg — Allocation lock/release/refund

| # | Assumption | Status | Notes |
|---|---|---|---|
| B1 | Allocate envelope shape accepted by live registry | ✅ | 404 "No holdings" = parsed full shape |
| B2 | `AllocationFactory_Allocate` SUCCEEDS with REAL holdings + real parties | ❌ [E2E] | never run once with real cBTC |
| B3 | Our solver party can be `sender` of an allocation (ledger authorization) | ❌ [E2E] | template-level auth untested |
| B4 | Our solver party can be `executor` and RELEASE via `Allocation_ExecuteTransfer` | ❌ [E2E] | the release leg — never executed |
| B5 | Executor can release WITHOUT the user (receiver) online — delegation is automatic | 🟡 [E2E] | read a Daml *comment* "typically"; never executed |
| B6 | `Allocation_ExecuteTransfer` FAILS after `settleBefore` (timeout enforced) | ❌ [E2E] | the refund-safety guarantee |
| B7 | `Allocation_Withdraw` returns the cBTC to sender after timeout | ❌ [E2E] | the actual refund path |
| B8 | Holdings get LOCKED (not spendable) while allocated | ❌ [E2E] | the "escrow" property itself |
| B9 | `settlementRef` shape (`{id, cid}`) is what the registry expects | 🟡 | guessed; parsed but with placeholder |
| B10 | Decimal/amount + time (ISO) formats match registry expectations | 🟡 | mirrored transfer-factory; not run real |

## C. Orchestration / cross-leg

| # | Assumption | Status | Notes |
|---|---|---|---|
| C1 | Full happy path: allocate cBTC → verify WBTC claimable (eth_call) → openFor (pull WBTC) → executeTransfer (release cBTC) | ❌ [E2E] | THE end-to-end proof — never run |
| C2 | Sad path: allocate → WBTC pull fails → executeTransfer NOT fired → withdraw refunds cBTC | ❌ [E2E] | the no-loss guarantee |
| C3 | Float exposure cap actually bounds in-flight cBTC | ❌ | spec'd, not built |
| C4 | Two concurrent orders don't double-spend the same float holdings | ❌ | concurrency — not considered |
| C5 | Crash mid-flow (between allocate and execute) recovers correctly on restart | ❌ | the desync class that stranded the 0.00001 |

## D. What we explicitly ACCEPT as residual (not testable pre-build)

| # | Risk | Why accepted |
|---|---|---|
| D1 | Solver decides WHEN to release (not atomic) | Canton can't observe Arbitrum — unavoidable, established |
| D2 | Treasury bears CBTC-delivered-but-WBTC-unpullable loss | Inherent to solver-fronting; bounded by A2/A3 pre-flight + caps |
| D3 | Reorg in the tiny pull window (A8) | Bound by tight deadline; log as loss event if it ever fires |

## The e2e test must prove, in ONE run

A2, A3, A4, B2, B3, B4, B5, B6, B7, B8, C1, C2 — i.e. a real allocate→execute happy
path AND a real allocate→timeout→withdraw sad path, with real (small) cBTC on
devnet first, then a single small mainnet rehearsal. Anything that can't be made
to pass becomes a design change, not a footnote.

## E2E PROBE RESULTS (2026-06-05) — first real Canton-leg run

Ran `probe-allocation-mainnet.mts` against LIVE mainnet cBTC (0.00001). Findings:

**Proven (matrix rows flipped ✅):**
- B2 allocate succeeds with real holdings ✅
- B3 solver can be sender ✅
- B7 `Allocation_Withdraw` refunds cBTC ✅ (safety net auto-withdrew cleanly, twice)
- Lock→refund cycle works end-to-end with real funds ✅

**Surfaced by the run (would NOT have been found by auditing):**
1. `DvpLegAllocation` precondition: **`allocateBefore` MUST be strictly before
   `settleBefore`** (cBTC registry enforces it). First attempt reverted. Fixed.
2. The Allocation template path is `...V0.Holding.Allocation:DvpLegAllocation` —
   it CONTAINS "Holding", which broke substring-based contract-id extraction. Fixed
   (match entity name, not substring).
3. 🔴 **REAL FUND-SAFETY BUG (pre-existing, not new):** `getHoldings` reads only
   `amount`+`owner` and IGNORES the `HoldingView.lock : Optional Lock` field. So a
   holding LOCKED in an allocation still counts toward `getFloatSats`. Confirmed
   live: float read 21000 while 1000 was locked (true spendable = 20000).
   → over-reports float; under concurrency the solver could select a locked
   holding as input (C4 double-allocate). **FIX: getHoldings must read `lock` and
   exclude/flag locked holdings.** Applies to the CURRENT transfer flow too.

**Still untested:** B4/B5 (executeTransfer release — happy path), B6 (execute fails
after settleBefore), C1/C2 (full cross-leg happy + sad), C5 (crash recovery).

## "Done auditing" =
Every ❌/🟡 above is either flipped to ✅ by the e2e run, or moved to section D with
an explicit reason. Until then, we are NOT done.
