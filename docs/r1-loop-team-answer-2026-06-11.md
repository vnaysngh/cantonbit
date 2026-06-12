# R1 — Loop team's definitive answer + the resulting design (2026-06-11)

## The question we asked

Can a Loop wallet exercise our custom `cbtc-htlc` `Claim` choice via explicit
disclosure (createdEventBlob + synchronizerId), or must our DAR be vetted on the
Loop participant — and how does Cancore do it?

## The answer (verbatim summary)

**No — disclosure isn't enough, and the package can't currently be vetted on Loop's
participant.**

1. **Disclosure solves visibility, NOT interpretation.** A participant can _act on_
   a contract it doesn't see in its ACS (via createdEventBlob + synchronizerId), but
   to **exercise a choice** the submitting participant **must have the package uploaded
   and vetted** to execute the DAML. `TEMPLATES_OR_INTERFACES_NOT_FOUND` is exactly the
   symptom of an unvetted package.
2. **Not just the submitter** — **every participant hosting an informee on the
   transaction** must have the package vetted to _confirm_ it.
3. **Loop policy = hard no.** The Loop SDK only supports DAML from the built-in Splice
   DARs + Utility app DARs (registry, settlement, bridge, credential, collateral,
   commercials). **No third-party DAR upload. No plan to add it.** A Loop user cannot
   exercise `Claim` on `cbtc-htlc` today — policy constraint, not routable around.

### Their three paths

- **Option 1 (the only one that works today):** Restructure so the **Loop user only
  exercises STANDARD choices**. Keep the HTLC logic on OUR participant — **our party is
  the controller of the custom choices**; the Loop user's role drops to standard CIP-56
  transfer/allocation steps accepted in their wallet. The secret-reveal/claim logic
  executes on OUR node.
- Option 2: Self-host the party (party migration) — but then they're not on Loop.
  Defeats the purpose.
- Option 3: Ask 5N to vet `cbtc-htlc` — "documented answer is no"; a roadmap
  conversation, no self-serve path. Not shippable now.

## Our design (chosen) — Option 1, mapped onto the proven path

Direction we care about: **EVM→Canton (WBTC→CBTC).** Roles:

- **Solver** = `locker` (gives CBTC) + `executor`.
- **Loop user** = `receiver` (gets CBTC).

Key insight: `Allocation_ExecuteTransfer`'s authority is **pre-delegated to the
executor** at allocation time (verified from AllocationV1.daml). So the **executor
(our node) can fire the release alone** — the receiver's signature is NOT required by
the registry's Allocation.

**Change:** `HtlcLock.Claim` from `controller receiver` → **`controller executor`**
(our node, where the DAR is vetted). Then:

- The custom `HtlcLock.Claim` is exercised entirely on OUR participant. ✅
- The Loop user is NOT an informee that must confirm the custom choice → no vetting
  needed on Loop. ✅ (must verify — see RISK)
- The secret is still verified ON-LEDGER (`keccak256(preimage)==hashLock`) before the
  asset moves. ✅ Trustlessness preserved.

So for EVM→Canton, the **Loop user signs ONLY the standard EVM lock (MetaMask)** and
receives CBTC via an on-ledger, secret-gated release our node fires. ZERO custom
Canton choices for the Loop user.

## OPEN RISK (make-or-break — verify BEFORE changing the DAR)

Does an **executor-fired `Allocation_ExecuteTransfer` to a CROSS-participant receiver**
actually confirm on-node? The receiver is still a stakeholder on the Allocation's
`transferLeg`. Per the Loop team, "every participant hosting an informee must have the
package vetted to confirm." The question: is the receiver an informee on the **registry's
Allocation_ExecuteTransfer** (a STANDARD Splice choice the Loop participant DOES have
vetted) — in which case it's fine — or does our `HtlcLock` template make the receiver an
informee on OUR package, requiring vetting on their side?

- If the receiver is only an informee on the _standard_ Allocation choice → ✅ works.
- If exercising our `HtlcLock.Claim` makes the receiver an informee on our package →
  the receiver's Loop participant must vet our DAR → ✗ blocked, same wall.

**Mitigation in the template:** the receiver should NOT be an `observer` on `HtlcLock`
(removing them means our package's choice has no cross-participant informee). The
receiver only appears as `transferLeg.receiver` on the STANDARD Allocation, which their
participant already understands. MUST prove this on-node with a real cross-participant
receiver before shipping.

## RESOLVED ON-NODE (2026-06-11) — Shape B is IMPOSSIBLE

Ran `swap-solver/src/probe-xparticipant-execute.mts`: standard Allocation
(receiver = the devnet Loop party), then `Allocation_ExecuteTransfer` fired by the
executor (us) ALONE. Result:

```
DAML_AUTHORIZATION_ERROR — DvpLegAllocation requires authorizers
  [Loop party], [warpx party]   but only [warpx party] were given
```

**The concrete CBTC allocation (`Utility.Registry.V0.Holding.Allocation:DvpLegAllocation`)
requires BOTH the receiver AND the executor to authorize ExecuteTransfer.** The
"executor fires alone" claim in lib/htlc-onledger.ts was reading the generic Splice
_interface_ (`signatory _`), NOT the concrete registry template. swap-solver/src/canton.ts
was right ("verified live: receiver co-auth needed"). Every prior "PROVEN" run had a
receiver our JWT controls (self-swap / local CanActAs), so co-auth was free — the
cross-participant case was never tested until now.

**Consequence:** our node alone cannot fire the release; the receiver MUST authorize.
The CBTC was safely recovered via Allocation_Withdraw.

**CORRECTED READING (this is NOT a blocker — it IS Option 1):** "the receiver must
authorize" is exactly the **standard CIP-56 step the Loop user accepts in their wallet**,
per the Loop team. The probe failed only because the SOLVER acted ALONE — which was never
the Loop design. In Option 1 the Loop user supplies the receiver authorization by signing
a STANDARD choice in their wallet. That's allowed (it's a built-in Splice choice, no
custom DAR on Loop's node). My earlier "executor fires alone" assumption was wrong; the
Loop team never said that — they said the Loop user accepts a standard step.

## THE LOOP PATH = Option 1, standard receiver-accept (build this)

For EVM→Canton (Loop user receives CBTC):

1. Loop user locks WBTC on EVM (standard MetaMask sig).
2. Our node (solver) creates a **standard CBTC transfer** to the Loop user via
   `createTransfer` (TransferFactory_Transfer — `lib/transfer.ts`, already proven
   cross-participant; the offer-create succeeds even when the receiver is x-participant).
3. The **Loop user accepts** it in their wallet via **`TransferInstruction_Accept`** — a
   STANDARD Splice choice that runs on Loop's node (no custom DAR). This supplies the
   receiver authority the registry demands.
4. Our solver claims the WBTC on EVM.

The custom secret/HTLC logic stays on OUR node (we only create the CBTC transfer after the
EVM lock is confirmed; we drive the EVM claim). The Loop user signs ONLY standard choices
(EVM lock + standard CBTC accept). This is precisely the Loop team's Option 1.

Trust note: because our DAR can't run on Loop's node, the keccak gate is NOT on the Canton
ledger for Loop users — atomicity for the CBTC leg is enforced by our solver's ordering +
the EVM HTLC, not an on-ledger Canton hash gate. Fully-trustless-both-legs remains the
participant-managed (email) path. This is a Loop-platform constraint, not our design choice.

## Status

- [x] Loop answer received → Option 1 (Loop user accepts a STANDARD choice).
- [x] Verified on-node WHY: the registry demands receiver co-auth (the standard accept).
- [ ] BUILD: Loop counter-leg via createTransfer → Loop user TransferInstruction_Accept,
      as a SEPARATE additive path (the email/HtlcLock path stays frozen).
