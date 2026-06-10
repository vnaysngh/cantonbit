# Build Plan — Cancore-faithful HTLC atomic swap (EVM ↔ Canton)

Decision (final): build EXACTLY Cancore's 8-step HTLC flow. It IS the best
achievable for EVM↔Canton, and it is trustless — the preimage reveal binds both
legs; no orchestrator decides settlement. First asset: cBTC. User reveals the
preimage via their Loop wallet (like Cancore).

## Why this is trustless (settled)
- Canton locks need the receiver's signature to release → each party claims their
  OWN side. The solver NEVER signs for the user. (This is why our solver-claims-
  for-user spike failed — wrong actor. The USER claims.)
- One secret `s` (H = keccak256(s)) unlocks both legs or both refund on timeout.
- No trusted oracle, no orchestrator gating the hash — the ledger + the secret do.

## The 8 steps → our components (solver plays "opponent")
| # | Cancore step | Actor | Our implementation |
|---|---|---|---|
| 1 | Create Order | User | API: user signs order committing to hashLock H + timelocks |
| 2 | Accept Order | Solver | solver matches the order (plays the counterparty) |
| 3 | HTLC Proposal: lock on EVM | User | user calls `HTLCEscrow.lock(H, T_user, amount, token, solver)` (MetaMask) |
| 4 | Counter HTLC: lock on Canton | Solver | solver locks cBTC on Canton under H, shorter timelock T_solver < T_user, receiver = user |
| 5 | Accept Counter | User | user's Loop wallet accepts (Preapproval / auto-accept) |
| 6 | Claim Counter: reveal preimage | User | user's Loop wallet exercises the Canton claim with `s` → `s` now public on Canton |
| 7 | Claim Main: use `s` | Solver | solver reads `s` from Canton, calls `HTLCEscrow.claim(s)` on EVM |
| 8 | Completed | Both | both legs settled |
| R | Refund (timeout) | Either | EVM `retake(H)` after T_user; Canton refund after T_solver |

## Timelock rule (from Cancore): T_user (EVM) > T_solver (Canton)
User/main HTLC has the LONGER timeout (e.g. 3h); solver/counter the shorter (e.g.
1h). So after the user reveals `s` on Canton (step 6), the solver has time to claim
EVM (step 7) before the user's EVM lock can be refunded. Min 2h window.

## Canton-side lock mechanism for cBTC (step 4 + step 6)
cBTC has no native hashlock. Cancore's pattern (confirmed from their app bundle):
- LOCK: lock the cBTC holding (token-standard lock / the registry lock path), with
  the hashlock recorded.
- The HASH GATE lives in a CUSTOM Daml template (our HtlcLock), whose Claim choice
  asserts keccak256(preimage)==hashLock.
- DELIVERY on claim: a `TransferInstruction` to the user, which the user's
  `Preapproval` (auto-accept) accepts on the USER's participant — no cross-
  participant signing by the solver.
- The user exercises the claim (step 6) via their Loop wallet, revealing `s`.

NOTE: our earlier Allocation-based HtlcLock failed because the SOLVER tried to
release to the user (needs receiver co-sign). Correct model: the USER claims, so
the receiver-signature requirement is satisfied by the user themselves (auto-accept
via Loop). The solver's only Canton action is the LOCK (step 4), which it signs
alone (it owns the cBTC).

## Build tasks (supersede/refine T7–T14)
- B1. Canton HtlcLock v2: cBTC lock + keccak gate + TransferInstruction delivery,
      claim exercised by the USER (receiver), refund by the solver after timeout.
      Re-architect off Allocation-execute-by-solver → user-claims model.
- B2. EVM: HTLCEscrow already done (keccak, lock/claim/retake). Wire solver=claimer.
- B3. Order/API (step 1): user signs order with H + timelocks. (T7)
- B4. Solver: accept order (2) + lock Canton counter HTLC (4). (T8)
- B5. Frontend: user locks EVM (3) via MetaMask; user claims Canton (5,6) via Loop
      provider, revealing `s`. (uses existing app/swap Loop integration)
- B6. Solver reveal-watch (7): read `s` from the Canton claim, call EVM claim(s). (T9/T10)
- B7. Refunds + watchtower (R): EVM retake after T_user, Canton refund after
      T_solver. (T11)
- B8. E2E on DevNet ⟷ Arbitrum/Base Sepolia (T13); recovery matrix (T14).
- Delete OranjAttestorOracle once B6 lands (T10).

## First milestone
B1 — the corrected Canton HtlcLock where the USER claims (revealing the preimage)
and delivery is via TransferInstruction+Preapproval. This is the piece the spike
showed we had wrong, and it's the foundation. Build + node-test it first.
