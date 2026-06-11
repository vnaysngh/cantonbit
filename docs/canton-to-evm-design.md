# Canton → EVM swap — research + locked design (2026-06-11)

Research round: Cancore docs (https://docs.cancore.io/usecases/en — UC4/UC5 = sell
CC/cBTC for EVM token, UC4L/UC5L Loop variants, UC4R/UC5R refunds), Cancore prod
bundle (cancore.io/assets/index-*.js, embedded OpenAPI + Loop orchestration), Splice
AllocationV1 docs. This file is the single reference for the reverse direction.

## What Cancore does (confirmed)

1. **USER (maker) locks the Canton asset FIRST** — custom Daml HTLC
   (`HTLCProposal`/`Proposal_Accept`/`HTLC_Claim`/`HTLC_Refund`), **LONGER timelock**
   (typical 3h, min expiration 2h). Participant-managed users: **the platform
   auto-locks** (node signs for the user).
2. **Venue locks the EVM asset second** — same hashLock, **SHORTER timelock**
   (typical 1h), receiver = user's EVM address. Two timers in their model:
   `swap.timeout` (main/Canton) > `swap.counterTimeout` (EVM).
3. **User claims the EVM leg in MetaMask** → `claim(preimage)` on-chain IS the
   secret reveal.
4. **Venue claims the Canton HTLC** with the now-public preimage.
5. Refunds: user `HTLC_Refund` after the long timeout (auto-refund cron + manual
   button); venue EVM `retake` after the short one. EVM leg becomes refundable
   first (correct ordering).
6. **Loop sellers (external wallet)** = "Flow B": `build-transfer-to-venue` —
   user signs a standard TransferInstruction to the venue + one `HTLCInitRequest`;
   venue runs `InitRequest_ExecuteWithEscrow` = atomic "transfer accept + allocate
   + proposal". **Custody-during-swap**; their admin surface (cleanup-failed-
   transfer, force-withdraw) exists because this step is the fragile part.

## OUR design — EMAIL (participant-managed) users: FULLY TRUSTLESS

Both Canton parties (user + solver) are LOCAL on warpx → the proven HtlcLock works
with roles flipped. No new DAR. No new mechanism.

| Step | Actor | Action |
|---|---|---|
| 1 | Browser | generate secret s, H=keccak(s) (existing generateSecret) |
| 2 | Backend (CanActAs user = Cancore's "auto-lock") | Allocation: **sender=USER party**, receiver=solver, executor=solver; HtlcLock: **locker=user**, receiver=solver, executor=solver, unlockTime=**LONG** → status `main_locked` |
| 3 | Solver daemon | sees main_locked (our own backend created the lock — trusted write) → **locks WBTC on EVM**: hashLock=H, receiver=**user's EVM address**, unlockTime=**SHORT** → `counter_locked` |
| 4 | **User, MetaMask** | **claims the WBTC** (the one EVM signature) → preimage revealed ON-CHAIN → `counter_claimed` |
| 5 | Solver daemon | reads preimage (UI records it AND the daemon watches the EVM `Claimed` event itself — NEVER trust only the browser) → exercises `HtlcLock.Claim` as receiver(=solver, LOCAL party, own authority) → **ledger checks keccak** → `Allocation_ExecuteTransfer` → cBTC to solver → `main_claimed` |

Authority check (why this works, proven primitives): DvpLegAllocation's
ExecuteTransfer needs **receiver + executor** authorizers = solver + solver = the
solver ALONE (the exact shape the original self-swap spike proved on-node).

Refunds:
- User: `HtlcLock.Refund` (controller locker=user, backend CanActAs) after the LONG
  timelock → `Allocation_Withdraw` returns the cBTC. Auto-refund sweep branch.
- Solver: EVM `retake(hashLock)` after the SHORT timelock if the user never claims.

Timelocks (existing lib/htlc-timelock.ts, assignments flipped per direction):
- `userTimelock` (LONG) = **Canton** HtlcLock unlockTime (user's refund gate).
- `solverTimelock` (SHORT) = **EVM** lock unlockTime (solver's retake gate).
- Gap (user-solver) must dominate: read EVM reveal + claim Canton + EVM finality —
  existing MIN_GAP (~20m) is fine.

Statuses (direction="canton-to-evm"; main leg = CANTON, counter leg = EVM):
open → accepted → main_locked (cBTC HtlcLock) → counter_locked (WBTC locked)
→ counter_claimed (user claimed WBTC, preimage public) → main_claimed (solver
claimed cBTC) | refunded | cancelled.

SOLVER-SAFETY RULE: the daemon MUST itself watch the EVM `Claimed` event for
reverse orders in `counter_locked` (extract preimage from the log). If we relied
only on the browser's recordCounterClaimed and the user claimed WBTC silently, the
auto-refund would later return their cBTC → solver loses both legs.

## Loop sellers (Canton→EVM, external wallet) — Variant A custody (FINAL, 2026-06-12)

**The allocation-escrow idea (Variant B) is DEAD — proven on-node, both directions.**
We built it and browser-tested it: the Loop wallet DID sign `AllocationFactory_Allocate`
(the lock landed on-ledger). But settlement is impossible: the cBTC
`DvpLegAllocation`'s `ExecuteTransfer` demands **sender + receiver + executor — all
three — live at execute time** (no pre-delegation; error transcript: "requires
authorizers [loop user], [warpx]"). A bare allocation between cross-participant
parties can be locked but settled by NO ONE: we lack the Loop party's authority,
the user lacks ours. Our custom HtlcLock settles only because the CONTRACT
aggregates authorities (locker = signatory, receiver = controller) — which needs
the DAR on the controller's participant → email-only. **Cancore's transfer-to-venue
custody is FORCED by Canton's authority model.** Never propose Loop allocation
escrows again — in either direction (the buyer-direction probe failed the same way
on the missing receiver).

**Variant A flow (built):**
1. User signs ONE standard `TransferFactory_Transfer` (their cBTC → venue party);
   holding cids read in the browser (`provider.getActiveContracts` — raw ACS-entry
   shape, NOT the SDK's documented flat shape).
2. Backend finds the offer in ITS OWN view and ACCEPTS as the venue
   (`confirmLoopSellerLock`) → custody begins → `main_locked`.
3. Daemon locks WBTC (short timelock, receiver = user's EVM address).
4. User MetaMask-claims the WBTC (the reveal). `claim-main` just records — the
   cBTC is already in our float (custody settled at lock time).
5. Refunds: FULLY AUTOMATED on our side — the sweep (and the UI button →
   refund-main) sends the custodied cBTC straight back via a direct transfer
   (auto-accepts via the user's preapproval); guarded on preimage-not-revealed.
   `recordMainClaim` hard-rejects reverse orders (stale-daemon false-completion fix).

Trust: custody-during-swap (identical to Cancore's production Loop mode). The
user's protections: the venue accept is atomic + visible, the EVM lock is verified
before they reveal, and refunds are automated.

## Build inventory (additive; frozen paths untouched)

- lib/htlc-onledger.ts: `allocate`/`createHtlcLock`/`refundHtlcLock` get optional
  sender/locker params (default = solver → existing EVM→Canton callers unchanged).
- lib/htlc-service-singleton.ts: `lockMainCanton`, `recordCounterLocked`,
  `claimMainAsSolver`, refund branch by direction. recordCounterClaimed reused.
- Routes: POST /api/htlc/[id]/lock-main, /counter-lock, /claim-main.
- Daemon: reverse branch (main_locked→lock WBTC; counter_locked→watch EVM Claimed;
  counter_claimed→claim cBTC; retake after solverTimelock).
- DB: migration 009 — counter_lock_tx column.
- UI: direction toggle on /swap (email users only for canton-to-evm in v1);
  Claim button = MetaMask WBTC claim + recordCounterClaimed.
