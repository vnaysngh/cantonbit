# T1 Findings — what the on-node spike + Cancore reverse-engineering proved

Date: 2026-06. Status: T1 produced a DEFINITIVE answer (the design must change).

## What the spike PROVED on the WarpX node (3 runs, real cBTC, all recovered)
1. Our `HtlcLock.Claim` works: keccak256 preimage gate passes, timelock + binding
   checks pass, and it successfully exercises the real `Allocation_ExecuteTransfer`.
2. BUT cBTC's `DvpLegAllocation` **requires the receiver to co-authorize**
   `ExecuteTransfer` (verbatim: "requires authorizers [receiver, solver] but only
   [solver] were given"). A receiver on ANOTHER participant cannot be co-signed by
   the solver → **solver-only delivery via Allocation FAILS cross-participant.**
3. (A cross-participant receiver as an *observer* of our custom DAR also fails with
   NO_SYNCHRONIZER_FOR_SUBMISSION until that participant vets the DAR — fixed by
   removing `receiver` from the HtlcLock observers.)

## What Cancore ACTUALLY does (reverse-engineered from their app bundle)
Cancore does **NOT** use `Allocation`/`ExecuteTransfer` for cBTC delivery. Evidence
from app-dev.cancore.app bundle:
- `#splice-amulet:Splice.Amulet:LockedAmulet`  ← native Amulet TIME-lock
- `TransferInstruction` + `TransferInstruction_Accept` (the delivery)
- `Preapproval` / `Preapproval_Send` / `preapproval-status`  ← AUTO-ACCEPT
- `encryptedPreimage` / `senderPreimage` stored; preimage revealed at claim
- Only 1 incidental `AllocationFactory` reference (not the delivery path)

So Cancore's Canton HTLC leg = **LockedAmulet (timelock) + TransferInstruction +
Preapproval (auto-accept)**, NOT Allocation. This is why it works cross-participant:
`TransferInstruction_Accept` is controlled by the RECEIVER, and Preapproval makes
the receiver's OWN participant auto-fire it. Nobody signs cross-participant; each
party acts on their own side. The Allocation DvP "both must co-sign" rule is never
invoked.

## The CORRECTION to our design
Our `CbtcHtlc.daml` is built on the WRONG primitive (Allocation). It must be
re-architected onto the Cancore-proven path:
- LOCK: `LockedAmulet` (native time-lock) on the holding, carrying the hashlock.
- RELEASE on Claim(preimage): create a `TransferInstruction` to the receiver.
- AUTO-ACCEPT: receiver's `Preapproval` auto-accepts → no cross-participant co-sign.

## THE ONE OPEN QUESTION (decides trustless vs trusted)
Is the **hash check enforced ON-LEDGER** (a Daml choice asserts
keccak256(preimage)==hashLock before releasing), or is it enforced **OFF-LEDGER by
Cancore's orchestrator** (LockedAmulet only gives a timelock; the backend decides
when to release based on the preimage it sees)?
- ON-LEDGER hash check → fully trustless (the ledger enforces it).
- OFF-LEDGER only → trust Cancore's backend not to release without the preimage
  (i.e. NOT fully trustless — back to a trusted orchestrator, the thing we set out
  to remove).
This must be resolved before claiming the design is trustless. LockedAmulet is a
pure TIME lock — so if the hash is enforced, it is enforced by a CUSTOM wrapper
template's choice, not by LockedAmulet itself. Need to confirm whether such a
wrapper exists in Cancore's on-ledger packages or if it's backend-gated.

## On-ledger package inspection (devnet node, 111 vetted packages)
- Cancore's package is NOT on devnet (they run on MAINNET) — can't inspect their
  exact template from here. The only HTLC packages on the node are OUR cbtc-htlc.
- BUT inspected the real `Splice.Amulet:LockedAmulet` (the CC lock). Its choices:
  `LockedAmulet_UnlockV2`, `LockedAmulet_OwnerExpireLockV2`, `unlockAndTransfer`,
  with fields `holders`, `expiresAt`, `amulet`. It is a TIME-lock with an
  OWNER/HOLDER-controlled unlock — NO native hashlock.

## KEY RESULT (CORRECTED from the authoritative Splice docs)
EARLIER MISREAD: I inferred from the binary that LockedAmulet had an owner-only
unlock. WRONG. The authoritative Splice.Amulet docs show:
- `LockedAmulet_Unlock` controller = **owner + ALL lock holders, jointly**. So
  unlocking-to-use needs the holders' signatures too — NOT owner-alone.
- `LockedAmulet_OwnerExpireLock` = owner alone, but only EXPIRES the lock back to
  the owner (a refund) — it does NOT deliver to a third party.

So CC's LockedAmulet has the SAME cross-participant signing requirement as cBTC's
Allocation: releasing a locked asset to a (cross-participant) receiver needs the
RECEIVER's signature. Neither CC nor cBTC has a pure owner-only release-to-third-
party lock.

## THE REAL, CONFIRMED CONCLUSION (all standard Canton assets)
No standard Splice/Amulet lock lets the solver UNILATERALLY release a locked asset
to a cross-participant receiver. Release always needs the receiver's signature.
This is WHY Cancore uses `Preapproval`: the receiver pre-authorizes incoming
transfers, so their OWN participant auto-supplies the required signature.

The hashlock is NOT in LockedAmulet or Allocation (neither is hash-aware) — it must
be in a CUSTOM wrapper. The open question is whether the on-ledger hash check can be
composed WITH the receiver's auto-accept (Preapproval) so the release happens only
on a valid preimage AND without the solver signing for the receiver.

## FINAL cBTC VERDICT — every path tested, no on-ledger hashlock exists
- Allocation: release (ExecuteTransfer) needs receiver co-sign → cross-participant wall. ❌
- TransferInstruction: registry REJECTS a `lock` field ("Unknown field lock"). No
  hashlock possible. (The `lock:null` in canton.ts is dead code.) ❌
- DepositAccount/WithdrawAccount: mint/redeem bridge only. No lock. ❌
=> cBTC has NO on-ledger hashlock primitive. A fully-trustless on-ledger HTLC for
   cBTC is NOT buildable with the current cBTC token.

## DECISION (final): build the cBTC model = Cancore-equivalent
- EVM leg: REAL HTLC (HTLCEscrow.sol, keccak, lock/claim/retake) — TRUSTLESS. ✅
- Canton cBTC leg: TRUST-MINIMIZED — solver locks cBTC (Allocation timeout-refund
  for safety), delivers via TransferInstruction + user Preapproval/auto-accept; the
  HASH is enforced by OUR bonded orchestrator (release only on the preimage), and
  the preimage reveal (user's Loop claim) drives the solver's EVM claim.
- This is the ceiling for cBTC and matches what Cancore actually does (their
  encryptedPreimage is stored off-chain → their cBTC hash check is orchestrator-side).
- Honest label: trustless EVM leg, trust-minimized (bonded) cBTC leg. NOT fully
  cryptographically trustless on Canton — because cBTC provides no hashlock.

## cBTC DepositAccount investigation — CONCLUSIVE (no help)
CBTCDepositAccount / CBTCWithdrawAccount are the MINT/REDEEM bridge (deposit BTC →
mint cBTC; CBTCWithdrawAccount_Withdraw → redeem BTC). NOT a lock. No hashlock, no
conditional release. cBTC has nothing beyond the standard token-standard primitives.

## Solver-model implication (what the user wants)
Solver model works the SAME way, with the solver playing the counterparty:
- Solver locks its cBTC (LockedAmulet, on solver's participant). ✅ no wall.
- Solver delivers via TransferInstruction; USER's Preapproval auto-accepts on the
  USER's participant. ✅ no cross-participant signing.
- The user's claim is their OWN participant's action (auto) — the solver never
  signs for the user. This is the fix for the wall our spike hit.
