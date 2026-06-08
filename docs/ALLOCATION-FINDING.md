# Allocation primitive — investigated, rejected for delivery (2026-06)

**Question:** can we deliver cBTC via the Splice `Allocation` primitive (lock →
execute) instead of the current `TransferInstruction` (transfer → receiver
accepts), to get a contract-guaranteed escrow + refund and remove the receiver's
accept step?

**Answer: NO. Allocation is the wrong primitive for one-directional delivery.**
Proven by live mainnet e2e, not theory.

## What the e2e proved (real mainnet, agent funds, net-zero)

Ran `swap-solver/src/probe-allocation-mainnet.mts` against the live cBTC registry:

| Step | Result |
|---|---|
| `allocate` (lock cBTC) | ✅ works — float drops, holdings lock |
| `withdrawAllocation` (refund to solver) | ✅ works — float restored, net-zero |
| `executeAllocation` (release to receiver) | ❌ **FAILS** |

The execute failed with:
```
DAML_AUTHORIZATION_ERROR: ...DvpLegAllocation requires authorizers
[receiver, solver], but only [solver] were given
```
and, when we tried to co-act as the receiver, a `403` security error — the
solver's m2m JWT has no authority over a receiver party on another participant.
The probe's safety net auto-withdrew every time, so no funds were ever at risk.

## Why — the root cause

The cBTC allocation template is **`DvpLegAllocation`** — DvP = **Delivery-versus-
Payment**. `Allocation` is the standard's primitive for **two-party atomic
settlement**: both parties allocate a leg (e.g. I allocate cBTC, you allocate
USDC) and an executor settles them atomically, which is why
`Allocation_ExecuteTransfer` **requires both parties to co-authorize the same
transaction**.

Our flow is **one-directional**: the solver delivers cBTC *to* a user, with no
payment leg back on Canton (the WBTC is on Arbitrum). So:
- There's no second leg for the user to allocate.
- The execute's both-parties requirement can't be met cross-participant (the
  solver can't act for the user's Loop party).

The Splice standard's own guidance confirms it: **`TransferInstruction` is the
correct primitive for sender→receiver delivery; `Allocation` is for coordinated,
atomic multi-leg DvP settlement.** We were using a DvP primitive for a non-DvP
purpose.

## Decision

- **Keep the current `TransferInstruction` (createOffer) delivery path** — it
  works end-to-end (proven: a live UI swap settled in 26s).
- The `allocate` / `executeAllocation` / `withdrawAllocation` methods remain in
  `canton.ts` (lock + withdraw are correct and tested live) **but are NOT used for
  delivery**. They'd only be relevant if a true two-party DvP flow is ever built
  (e.g. if cBTC were swapped against another Canton asset atomically).
- The `executeAllocation` / `withdrawAllocation` choice-context fix made during
  this investigation is kept (the previous empty-context versions would have
  failed live — now they fetch the registry choice-context correctly).

## What this means for the "trustless" goal

This closes another door: even the Canton-native settlement primitive (Allocation)
doesn't give us atomic one-directional delivery to an external user — it's built
for two consenting parties. Combined with the earlier finding (Splice has no
preimage-gated release), the conclusion stands: **for Arbitrum→external-cBTC-user,
the realistic trust-minimization is the bonded-optimistic-oracle on the WBTC side,
not a Canton-side atomic mechanism.** The cBTC delivery is, and remains, a
`TransferInstruction` the user accepts (or auto-accepts).
