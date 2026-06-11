# 🔒 LOOP CONSTRAINTS — LOCKED. DO NOT RE-LITIGATE. READ THIS FIRST.

This file is the single source of truth for how Loop-wallet users work. It is
SETTLED. If you ever find yourself questioning, re-deriving, or "discovering" any
of the rules below — STOP. You already know this. Re-read this file, do not
re-investigate, do not run another probe to "confirm," do not ask the user again.

## THE ONE RULE (from the Loop team, verbatim, confirmed on-node 3×)

**LOOP CANNOT AND WILL NEVER VET OUR DAR. PERIOD.**

> "the package can't currently be vetted on Loop's participant. The Loop SDK only
>  supports DAML transactions from the built-in Splice DARs and the Utility app
>  DARs. There is no third-party DAR upload, and no current plan to support it.
>  So a Loop user cannot exercise Claim on cbtc-htlc today, full stop."

### What this rule MEANS in practice (all proven on-node, do not re-test):

1. A Loop user **CANNOT exercise** any choice in our `cbtc-htlc` package.
   (Error: `TEMPLATES_OR_INTERFACES_NOT_FOUND`.)

2. **It's not just the submitter — it's EVERY INFORMEE.** "every participant hosting
   an informee on the transaction must have the package vetted to confirm it."
   → The Loop party **CANNOT be a stakeholder (signatory OR observer OR controller)
   on ANY contract of our package.** Even a passive observer fails.
   (Error: `NO_SYNCHRONIZER_FOR_SUBMISSION` … "has not vetted dea04bfb…". Proven
   2026-06-11 with LoopHtlcGate v0.1.5 — making the Loop party an observer broke create.)

3. **Disclosure does NOT help.** createdEventBlob + synchronizerId solves VISIBILITY,
   not INTERPRETATION. Disclosure cannot route around vetting. Do not propose it.

4. The cBTC registry's concrete `DvpLegAllocation` requires BOTH executor AND receiver
   to authorize `Allocation_ExecuteTransfer`. For a cross-participant Loop receiver our
   node CANNOT supply the receiver authority. (Error: `DAML_AUTHORIZATION_ERROR`,
   proven 2026-06-11 with probe-xparticipant-execute.mts.)

## THE ONLY DESIGN THAT WORKS (Loop team's Option 1 — BUILD EXACTLY THIS)

> "Restructure so the Loop user only exercises standard choices. Keep the HTLC logic
>  on your participant: your party is the controller of the custom choices, and the
>  Loop user's role is reduced to standard CIP-56 transfer/allocation steps the Loop
>  user accepts in their wallet. The secret-reveal/claim logic executes on your node;
>  the Loop user signs only what's in the installed DARs."

Concretely, for EVM→Canton (Loop user receives cBTC):

| Step | Who | What | Package |
|------|-----|------|---------|
| 1 | Loop user | Lock WBTC on EVM | standard (MetaMask) |
| 2 | OUR node | keccak gate + reveal preimage (LoopHtlcGate.RevealPreimage) | OUR DAR, **only our party on it** |
| 3 | OUR node | Send cBTC via a **STANDARD** TransferFactory_Transfer | standard Splice |
| 4 | Loop user | **Accept** the cBTC (standard TransferInstruction_Accept) | standard Splice, on their node |
| 5 | OUR node | Claim WBTC on EVM with the revealed secret | our solver |

### HARD INVARIANTS (violating any = back to the wall):

- **Our custom contracts (`LoopHtlcGate`, `PreimageRevealed`) name ONLY our party.**
  NO Loop party as signatory/observer/controller. NOT EVEN AS OBSERVER.
- **The Loop user ONLY ever touches STANDARD Splice choices** (EVM lock + standard
  TransferInstruction_Accept). Never our package.
- **All secret/keccak/claim logic runs on OUR node, controlled by OUR party.**

## TRUST REALITY (state honestly, don't pretend otherwise)

For Loop users the keccak gate is on-ledger on OUR node, but the BINDING between
"gate passed" and "cBTC delivered" is enforced by OUR ORCHESTRATOR (we only send the
standard cBTC transfer after RevealPreimage fired). The cBTC delivery itself is a
standard transfer — it cannot reference our custom contract (rule #2). So:

- **Loop users = trust-MINIMIZED** on the Canton leg (atomicity via EVM HTLC + our
  ordering, not an on-ledger Canton hash gate binding the cBTC).
- **Email / participant-managed users = FULLY TRUSTLESS** both legs (their party is
  LOCAL on warpx → our DAR is installed there → THE USER CLICKS CLAIM and reveals the
  secret BY claiming the HtlcLock, exactly like Cancore's UI "Claim Counter — You" step.
  Reveal-secret and unlock-cBTC are ONE ledger-enforced action. NOT silently backend-
  signed — the user acts. THIS IS DONE, PROVEN, AND FROZEN — never touch it.)
  (See [[htlc-swap-mental-model]] for the full plain-English model.)

This trust difference is a LOOP-PLATFORM CONSTRAINT, not our design choice, and not
fixable without Loop vetting our DAR (which won't happen). Do not keep trying to make
Loop fully trustless — it is physically impossible under Loop's policy.

## OTHER OPTIONS (rejected — do not revisit)

- Self-host the party → not Loop anymore, defeats the purpose. REJECTED.
- Ask 5N to vet cbtc-htlc → "documented answer is no", no self-serve path, commercial
  roadmap conversation only. Not shippable now. REJECTED for build purposes.

## DAR / LOOP PATH — FINAL DECISION (2026-06-11)

**The Loop path uses NO custom Canton DAR at all.** A custom Canton gate (LoopHtlcGate)
would only RE-check a hash that the EVM contract ALREADY checks, and it does NOT gate the
cBTC (which is a plain transfer) — so it's pure ceremony, zero added security. Dropped.

The Loop flow's hash gate lives on **EVM** (HTLCEscrow.claim re-computes keccak256(preimage)
and rejects a wrong one — mandatory, on-chain). That IS "our participant's custom logic"
per the Loop team; it just happens to be on the EVM side, which is also ours. The Loop user
only signs standard choices (EVM lock + standard cBTC accept). Satisfies Option 1 fully.

- Email path (FROZEN): `791eb59c…` (v0.1.3), `CbtcHtlc:HtlcLock`. Already uploaded. DO NOT CHANGE.
- Loop path: NO new DAR. v0.1.5/v0.1.6 (LoopHtlcGate) were built then DROPPED as unnecessary.
  Loop = lockCounterLoop (standard transfer) + prepare-accept (standard accept) +
  recordCounterClaimed (browser hands us the secret → we claim WBTC on EVM).

## IF YOU ARE READING THIS BECAUSE YOU'RE ABOUT TO RE-DERIVE THE WALL: don't.
The user has explained this many times. The rules above are final. Build Option 1.
