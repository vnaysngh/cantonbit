# CoW-Style "No Pre-Lock" Swap — Implementation Plan

> Goal (verbatim from the team): **build as close to CoW Swap as possible** —
> the user's WBTC stays in their wallet until the solver delivers CBTC; the
> solver pulls the WBTC only *after* delivery, authorized by an off-chain
> signature. No funds locked up front; nothing stranded if a swap stalls.

Status: plan only, no code. Date 2026-06-05.
Direction confirmed by team: **CoW-style no-pre-lock** (not pre-lock, not HTLC).

---

## 0. Audit findings — how CoW *actually* settles (read before building)

Verified against CoW's contract docs + the GPv2Settlement reference, OIF source,
and the Daml HTLC source. The point of this section is to **not make grave
mistakes** by copying a mental model that doesn't hold cross-chain.

**A. CoW is "no pre-lock" but NOT "funds never move until later" — funds move
*during* the fill, atomically, in ONE transaction.**
- The user's sell token is pulled from their wallet via an **allowance to the
  `GPv2VaultRelayer`**, and that pull happens **inside the same `settle()` tx**
  that delivers the buy token. (docs.cow.fi — core contracts.)
- So CoW's atomicity = *single-chain, single-transaction*. Pull-sell and
  deliver-buy cannot desync because they're one EVM tx that reverts as a unit.

**B. We CANNOT replicate that atomicity. This is the irreducible gap.**
- Our buy side (CBTC) is on **Canton — a different ledger**. No single transaction
  spans Arbitrum + Canton. So our "no-pre-lock" is necessarily **two steps**:
  deliver CBTC on Canton, then pull WBTC on Arbitrum. They are bound by our
  solver + oracle, NOT by EVM tx atomicity.
- **Consequence:** going no-pre-lock **moves the completion risk from the USER to
  the SOLVER/treasury.** Today a solver failure strands the user's funds.
  No-pre-lock means the solver delivers CBTC first and then claims WBTC — if it
  *can't* claim (user moved/revoked the WBTC after signing), the **treasury eats
  the CBTC loss.** This is the SAME risk every CoW/UniswapX solver carries; it is
  inherent to the model and is the core decision the team has accepted.

**C. Authorization & the #1 footgun: signature replay.**
- CoW supports EIP-712 / presign / ERC-1271 and **explicitly warns about
  signature replayability** with some signature types. Our reorder holds the
  user's signature **longer** than today (we sign now, pull later), which widens
  the replay window. **Mitigation is mandatory** (see §"Footguns" below).

**D. CoW cross-chain is itself two-legged and re-locks.**
- CoW "Swap & Bridge" = atomic same-chain swap, *then* bridge via Across/Bungee,
  and the **bridge leg locks funds** (Across origin-chain escrow). None of these
  bridges reach Canton. So there is nothing to fork that helps the Canton leg —
  confirmed. We reuse our own `InputSettlerEscrow` + `openFor`, just called later.

**The three footguns that could cause real losses (and the required mitigations):**

| Footgun | Why it bites in no-pre-lock | Required mitigation |
|---|---|---|
| **Signature replay** | We hold the signed order longer before submitting `openFor` | Bind a unique nonce + a tight Permit2/order deadline = `fillDeadline`; reject reused nonces; never accept a signature past deadline |
| **Claimability gap** | Between delivering CBTC and pulling WBTC, the user can move/revoke WBTC → treasury loss | **Pre-flight before delivering CBTC**: assert user still holds ≥ amount WBTC AND Permit2 allowance/signature still valid AND not past deadline. Deliver ONLY if the pull is provably executable. Keep the gap tiny (pull WBTC immediately after delivery confirms). |
| **Float exposure** | Solver spends CBTC float *before* securing WBTC | Per-order cap + float pre-flight (already exist). Cap total in-flight no-pre-lock exposure to a configured treasury limit. |

These three are the "grave mistakes" guardrails. The reorder is safe **only** if
all three mitigations ship with it.

---

## The one change that matters

**Today (pre-lock):**
```
POST /orders → solver submits openFor NOW → WBTC pulled into escrow
            → watcher sees Open event → deliver CBTC → finalise (release WBTC)
```
WBTC leaves the wallet at step 1, before any CBTC is delivered. That is the
non-CoW behaviour and the source of stranded funds.

**CoW-style (no pre-lock) — what we want:**
```
POST /orders → store the signed intent ONLY (no chain tx, WBTC stays in wallet)
            → solver delivers CBTC on Canton
            → ONLY THEN solver submits openFor (pulls WBTC) + finalise (release)
```
WBTC stays in the user's wallet until CBTC is delivered. Exactly CoW's "if it
doesn't fill, your funds never moved."

## Why this is a REORDER, not a contract swap

The escrow's `openFor(order, sponsor, signature)` is **solver-submitted** — the
user's signature authorizes the pull, but *the solver chooses when to call it*.
The signature is valid until the order's `fillDeadline`/`expires`. So we can
**hold the signed order and call `openFor` after delivering CBTC** instead of
before. No new/forked contract required for the core change.

The only thing coupling lock→deliver today is that our **watcher triggers
delivery off the on-chain `Open` event**. We decouple that: delivery is triggered
by the **stored signed intent**, not by an on-chain event.

---

## What changes, file by file

### Solver — `swap-solver/`

1. **`api.ts` — `POST /orders` stops locking.**
   - Remove the `escrowC.write.openFor(...)` call from order submission.
   - Just validate the signature + store the order as a new status `intent`
     (signed, not yet locked). Persist the signature so the solver can submit
     `openFor` later.
   - Return immediately — no chain tx, no gas, instant. (This is the "sign and
     you're done" CoW UX.)

2. **`index.ts` (watch loop) — delivery now driven by stored intents, not the
   `Open` event.**
   - New leg ordering per tick:
     - **deliver**: for each `intent` order, deliver CBTC on Canton (as today's
       `deliverSeenOrders`, but keyed off `intent` not `seen`).
     - **lock-after-deliver**: once CBTC delivery is confirmed/accepted, submit
       `openFor` (pull WBTC) → status `locked`.
     - **finalise**: attest + `finalise` to release WBTC to treasury (unchanged).
   - The `OpenWatcher` is no longer the intake trigger. (Keep it only as a
     reconciler/safety check that a lock we *think* we submitted actually landed.)

3. **`store.ts` — add the `intent` status** (signed-but-not-locked) ahead of
   `seen`. New lifecycle: `intent → delivering → delivered → locked → finalised`,
   with `refunded`/`failed` as terminal.

4. **Refund/abort path simplifies.** If the solver never delivers, there is
   **nothing to refund** — the WBTC never left the wallet. The signed intent just
   expires (like a CoW order). Refund logic only matters for the window *after*
   `openFor` but *before* `finalise` (a much smaller risk surface).

### App — `app/swap/` + `lib/`

5. **The user still signs the same EIP-712 order** — no UI change to the signing
   step. The difference is purely server-side ordering.
   - The status labels update: "WBTC locked — solver notified" becomes "Swap
     submitted — delivering CBTC" (nothing is locked yet).
   - Tracking view: leg 1 becomes "Delivering CBTC" instead of "WBTC locked".

6. **`lib/swap-api.ts`** — update the `SwapStatus` union + `STATUS_LABEL` for the
   new lifecycle (`intent`/`locked`).

---

## The honest trade-off this introduces (so it's a decision, not a surprise)

Reordering moves the completion risk from the **user** to the **solver**:

- **Today:** user's WBTC is locked first → if the *solver* fails to deliver CBTC,
  the user's funds are stuck (bad for user, safe for solver).
- **CoW-style:** solver delivers CBTC first → if the *user's signature can't pull
  the WBTC afterwards* (e.g. user moved/spent the WBTC after signing), the
  **solver is out the CBTC** (good for user, risk for solver).

This is the **same risk CoW/UniswapX solvers carry** — they front the output and
trust they can claim the input. CoW solvers manage it with: short deadlines, only
filling when the input is verifiably claimable, and reputation/economic checks.

**Mitigations we'd add (mirror CoW):**
- Keep the tight `fillDeadline` (already 10m) so the WBTC claim happens promptly
  after delivery — minimal window for the user to move funds.
- **Pre-flight the claimability**: before delivering CBTC, the solver checks the
  user still holds ≥ amount WBTC *and* the Permit2/signature is still valid.
  Deliver only if the pull will succeed.
- Optionally, require Permit2 allowance to be set (as today) so the pull is a
  single solver tx with no extra user friction.

This is the crux decision: **CoW-style means the solver fronts the CBTC and bears
the "can I still claim the WBTC?" risk.** That's inherent to the model — it's why
CoW/UniswapX swaps feel instant. If that risk is unacceptable, we stay pre-lock.

---

## Effort estimate

| Piece | Effort |
|---|---|
| `store.ts` new `intent` status + lifecycle | S |
| `api.ts` — stop locking on submit, store intent | S |
| `index.ts` — reorder legs (deliver → lock → finalise), drive off intents | **M–L** (the core change; careful ordering + the claimability pre-flight) |
| Watcher demoted to reconciler | S |
| App status labels + tracking copy | S |
| Tests: new lifecycle, claimability pre-flight, "user moved funds after signing" failure path | M |

**Rough total: ~1 week**, dominated by the watch-loop reorder and the
claimability-pre-flight (the safety check that makes the solver-fronting model
safe). No contract deployment, no fork — the existing `InputSettlerEscrow` +
`openFor` are reused, just called later.

---

## Open questions to confirm before building

1. **Permit2 allowance timing.** Today the user approves Permit2 before signing.
   In the no-pre-lock flow the pull happens after delivery — confirm the Permit2
   signature/allowance is still valid at pull time (it should be; Permit2
   witnesses carry their own deadline — align it with `fillDeadline`).
2. **Claimability pre-flight depth.** Is "user holds ≥ amount + allowance set"
   enough, or do we want a stronger guarantee before fronting CBTC? (CoW solvers
   accept residual risk here.)
3. **Float exposure.** The solver now spends CBTC float *before* securing the
   WBTC. Confirm the per-order cap + float pre-flight already bound this exposure.

---

## Decision record & 2026 context

**Models considered (and why we picked no-pre-lock):**

| Model | What it is | 2026 adoption | Fit for us |
|---|---|---|---|
| **CoW-style solver + optimistic settlement** | Sign intent, solver fills, claims input after | **Dominant / mainstream** (CoW, 1inch Fusion, Across) | ✅ **Chosen** — closest to CoW, reuses our contracts, proven pattern |
| **Resource lock / The Compact (UniswapX)** | One standing deposit in a vault, gasless per-swap signatures | **Emerging** (UniswapX) | ⚠️ EVM-centric, adds a deposit-vault step, doesn't reach Canton |
| **HTLC hash-timelock atomic swap** | Shared SHA-256 secret binds both legs; truly atomic | **Legacy** for DEXs (Lightning, Komodo) | ❌ User must act on both chains — kills the one-tap UX |

**Decided:** CoW-style no-pre-lock. It is the mainstream 2026 pattern, the closest
reachable to CoW's UX, and the only one that needs no new/forked contracts.

**Explicitly accepted trade-off:** completion risk moves from the user to the
**solver/treasury**. We mitigate (claimability pre-flight + tight deadline + float
cap) but do not eliminate it — this is inherent to every solver-fronting design.

**Explicitly rejected as infeasible:** single-transaction cross-chain atomicity
(CoW's same-chain guarantee cannot span Arbitrum↔Canton) and forking
CoW/Across/Bungee (none settle to Canton).

**Sources:** docs.cow.fi (core contracts, swap-and-bridge), docs.across.to (intent
lifecycle / origin-chain escrow), Uniswap The Compact (blog + repo),
SynfiniDLT/daml-htlc (Canton HTLC source), OIF oif-contracts
(InputSettlerEscrow vs InputSettlerCompact). See also
`docs/ATOMIC-SWAP-DESIGN.md` for the deeper A-vs-C analysis.
