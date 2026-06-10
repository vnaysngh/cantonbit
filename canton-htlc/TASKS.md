# Task List — Trustless Atomic EVM↔Canton Swap (cBTC first)

> Single source of truth. Mirrors the in-app task tracker. Build reference:
> `BUILD-PLAN-cancore.md`. Research/why: `T1-FINDINGS.md`, `AUDIT-AND-ROADMAP.md`.
>
> Model (settled): Cancore-equivalent HTLC. **Trustless EVM leg** (real HTLC),
> **trust-minimized cBTC leg** (cBTC has no on-ledger hashlock — proven). One
> secret `s` (H = keccak256(s)) binds both legs. User reveals `s` via Loop wallet.
> NO bond — the secret reveal binds the legs.

## Status

| ID | Task | Status |
|----|------|--------|
| T0 | Save Cancore's verified HTLC.sol as EVM reference | ✅ done |
| T1 | On-node spike — what's possible on Canton (cBTC has no hashlock) | ✅ done |
| T2 | Switch both legs to keccak256 (parity proven 0x9427…9903) | ✅ done |
| T4 | Rewrite HTLCEscrow to Cancore's shape (lock/claim/retake, hardened) | ✅ done |
| T5 | Harden Canton template (binding checks) | ✅ done |
| T6 | Decision: use new HTLCEscrow, retire OIF | ✅ done |
| **T7** | **Order + API: carry hashLock + timelocks; secret holder** | **▶ in progress** |
| T3 | Read WarpX skew_max + set timelock ladder | pending |
| T8 | Canton cBTC leg: lock + auto-accept delivery (Cancore-equiv) | pending |
| T9 | reveal-watch: extract preimage from the user's Canton claim | pending |
| T10 | settle.ts: EVM claim(s); DELETE the oracle | pending |
| T11 | refunds: EVM retake + Canton refund after timeouts; watchtower | pending |
| T12 | Reverse direction (Canton → EVM) | pending |
| T13 | End-to-end on DevNet ⟷ Arbitrum/Base Sepolia | pending |
| T14 | Recovery matrix (defection at every step self-heals) | pending |
| T15 | External security audit (both HTLC contracts) | pending |
| T16 | Mainnet params, monitoring, runbook | pending |
| T17 | (Optional) Dutch auction + partial fills | pending |

## The flow (Cancore's 8 steps → our components)
1. Create Order (User) — sign order committing to H + timelocks.            [T7]
2. Accept Order (Solver) — solver matches/takes the order.                  [T8]
3. HTLC Proposal: lock on EVM (User) — HTLCEscrow.lock(H,…) via MetaMask.    [T4 done + frontend]
4. Counter HTLC: lock on Canton (Solver) — lock cBTC under H, shorter T.    [T8]
5. Accept Counter (User) — Loop auto-accept (Preapproval).                  [T8]
6. Claim Counter: reveal preimage (User) — Loop claim reveals s on Canton.  [frontend + T9]
7. Claim Main: use s (Solver) — read s, HTLCEscrow.claim(s) on EVM.         [T9/T10]
8. Completed.
R. Refund — EVM retake(H) after T_user; Canton refund after T_solver.       [T11]

Timelock rule: T_user (EVM) > T_solver (Canton), min 2h window.             [T3]

## What "in progress" (T7) covers
The signed order must commit to the hashLock H and the two timelocks, so both
legs are provably the same swap. Update the order type + EIP-712 typed data + the
quote/sign flow so the user generates the secret, signs over H, and the solver
can't alter H.
