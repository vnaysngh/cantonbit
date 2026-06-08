# 1inch-Fusion+-style HTLC swap — Arbitrum WBTC ↔ Canton cBTC

The trust-minimized upgrade path: keep our solver-fronting, add HTLC escrows on
both chains so **no one can steal principal**, shrink the residual trust to
secret-timing (exactly what 1inch Fusion+ openly does). This doc specs the real
architecture mapped to our actual code + token standards.

## The model, in one picture

```
            ARBITRUM (EVM)                         CANTON (Splice)
   ┌──────────────────────────┐         ┌──────────────────────────────┐
   │  EscrowSrc (HTLC)         │         │  cBTC HTLC lock (Splice)      │
   │  holds the USER's WBTC    │         │  holds the SOLVER's cBTC      │
   │  hashlock H, timelock T1  │         │  hashlock H, timelock T2      │
   └──────────────────────────┘         └──────────────────────────────┘
        user locks WBTC                       solver locks cBTC
              │                                       │
              │   secret s (H = sha256(s)) revealed only AFTER both locks exist
              ▼                                       ▼
   solver claims WBTC with s              user claims cBTC with s
   (reveals s on Arbitrum)        ◄────── (s now public, anyone can relay it)
```

**Both-or-neither:** the SAME secret `s` unlocks both legs. Reveal it → both
complete. Never reveal it → both refund after their timelocks. No third party can
take principal. That's the HTLC guarantee.

## Roles (mapped from 1inch → us)

| 1inch Fusion+ | Us | Notes |
|---|---|---|
| Maker (user) | User | signs the intent; provides/holds the secret |
| Resolver | **our solver** (already fronts cBTC) | deposits the destination leg, claims the source leg |
| Relayer (1inch service) | **our orchestrator** | verifies both escrows exist, then gates secret reveal |
| EscrowSrc / EscrowDst | Arbitrum HTLC contract / Splice cBTC lock | the two hashlocked escrows |
| Safety deposit | safety deposit (new) | punishes a solver who locks then abandons |

## The flow (who reveals the secret, and when — the part everyone gets wrong)

1. **Intent + secret.** User generates a random secret `s`, computes `H = sha256(s)`, signs a swap order committing to `H`, amounts, recipient, and the two timelocks. **The user keeps `s` private for now.**
2. **Source lock.** User locks WBTC into the Arbitrum HTLC escrow with hashlock `H`, timelock `T1`. (This is the analogue of our current `openFor` — but now hashlocked.)
3. **Destination lock.** The solver (resolver), seeing the source lock, locks cBTC into a Splice HTLC lock to the user, same `H`, timelock `T2`, with **`T2 < T1`** (critical — see below).
4. **Verify-then-reveal.** The orchestrator confirms BOTH escrows exist on-chain with the same `H` and correct amounts/recipients. **Only then** does the user (or orchestrator on the user's behalf) reveal `s`.
5. **Claim, destination first.** The user claims cBTC on Canton by submitting `s` → **`s` is now public on the Canton ledger.**
6. **Claim, source second.** The solver reads the now-public `s` from Canton and claims the WBTC on Arbitrum with it.
7. **Failure → refund.** If `s` is never revealed: after `T2` the solver reclaims its cBTC; after `T1` the user reclaims its WBTC. Nobody loses principal.

## The one rule that makes it safe: timelock ordering `T2 < T1`

The chain where the secret is revealed **first** (Canton, by the user claiming
cBTC) must have the **shorter** timelock. Why:

- The user reveals `s` on Canton to get cBTC. This must happen *before* the solver
  can refund its cBTC (so the user can't be denied) AND must leave the solver
  enough time to then claim WBTC on Arbitrum before the user can refund it.
- So: **`T2` (Canton/destination) < `T1` (Arbitrum/source)**, with a comfortable
  gap (e.g. T2 = now+2h, T1 = now+4h). Get this backwards and a party can refund
  one leg while the other is still claimable → theft. This is THE dangerous bug
  in every HTLC swap; it must be enforced in both contracts and asserted at intake.

## What's trustless vs. the residual trust (be honest)

| Property | Guaranteed by | Trust? |
|---|---|---|
| No one steals WBTC | Arbitrum HTLC: only `s` or post-`T1` refund releases it | ✅ trustless |
| No one steals cBTC | Splice lock: only `s` or post-`T2` refund releases it | ✅ trustless |
| User gets cBTC OR refund | hashlock + timelock | ✅ trustless |
| Solver gets WBTC OR refund | hashlock + timelock | ✅ trustless |
| **Secret revealed only after both locks verified** | **the orchestrator** | 🟡 **trusted (timing only)** |
| Liveness / no griefing | safety deposit + timelocks | 🟡 economic |

**The residual trust is ONLY secret-timing** — and even that can't cause *theft*,
only a stuck swap that refunds. This is precisely the trust 1inch admits
(*"security is affected by the off-chain distribution of the user's secret"*).
It is categorically smaller than our current model, where a single key can
release ANY escrow with no proof. **Theft-impossible vs. theft-via-one-key.**

The free-option problem (the user, holding `s`, can choose not to claim if the
price moves) is mitigated the 1inch way: a **safety deposit** the non-completing
party forfeits, so griefing costs money.

## What we already have vs. what's new

| Piece | Status |
|---|---|
| Solver fronts the cBTC | ✅ already do this |
| Solver watches both chains (orchestrator) | ✅ have the watch loop + canton client |
| Splice lock primitive (`{holders, expiresAt, context}`) | ✅ exists — cBTC holdings already lock/unlock (`canton.ts`); context-tag = the hashlock |
| Arbitrum HTLC escrow | 🔴 NEW — standard hashlock+timelock contract (audited templates exist); replaces today's OIF escrow for this flow |
| Canton-side HTLC choice (claim-on-preimage / unlock-after-T2) | 🔴 NEW — must be written for the **Splice** standard, NOT Daml.Finance |
| Hashlock commitment in the signed order | 🔴 NEW — add `H` + two timelocks to the order |
| Verify-both-then-reveal orchestration | 🔴 NEW — the secret-timing gate |
| Safety deposit | 🔴 NEW |

## ⚠️ The blocker you'd hit mid-build (caught now)

**The Synfini `daml-htlc` library does NOT drop in.** It's built on
`Daml.Finance.Interface.Holding` / `Transferable`. Our cBTC uses the **Splice
token standard** (`Splice.Api.Token.HoldingV1` / `TransferInstructionV1` /
`AllocationV1`) — a different interface family. So Synfini is a **reference for the
pattern** (acquire-with-context → claim-on-preimage → release-after-timeout), but
the actual Canton-side HTLC choice must be authored against Splice's `Holding`
lock + a transfer, or layered on the `Allocation` primitive we already use.

Good news: Splice's lock already carries a **`context`** field (verified live:
`lock = {holders, expiresAt, context}`) — that `context` is exactly where the
hashlock `H` goes, and `expiresAt` is the timelock. So the primitive exists; it
needs a thin Daml template exposing `claim(preImage)` and `unlock()` choices over
a Splice holding, mirroring Synfini's two choices.

## Realistic build sequence (if you choose this path)

1. **Decide the asset on Arbitrum.** Today WBTC is locked in the OIF escrow. For
   HTLC you replace that with a hashlock escrow. (Or keep WBTC where it is and
   wrap the OIF escrow's `finalise`/`refund` behind a hashlock — needs analysis.)
2. **Write the Canton-side Splice HTLC template** (claim-on-preimage + unlock-
   after-T2) — the genuinely new Daml, modeled on Synfini but over Splice holdings.
3. **Write/adopt the Arbitrum HTLC** (standard, audited templates exist).
4. **Add `H` + `T1`/`T2` to the signed order**, enforce `T2 < T1` on-chain in both.
5. **Build the verify-both-then-reveal orchestrator** (extends our watch loop).
6. **Safety deposits** on both legs.
7. **Test the failure matrix exhaustively**: each party going silent at each step,
   secret revealed late, clock skew between Canton ledger-time and EVM
   block.timestamp (a real gotcha — Canton time ≠ EVM time).

## Honest cost/benefit

- **Benefit:** removes our single biggest risk — the attestor key can no longer
  steal. Funds become theft-proof; the worst case is a refund.
- **Cost:** materially more complex (two HTLC contracts, secret orchestration,
  timelock ordering, safety deposits, capital locked during the window), and a
  worse UX (the user holds/reveals a secret; capital is locked for the timelock).
- **The pragmatic alternative** (bonded optimistic-oracle on the existing model)
  gets ~80% of the safety — solver can't steal, only halt — with ~20% of this
  complexity and no UX change. Choose HTLC only if "theft-impossible, even by us"
  is a hard requirement; choose the bond if "we can't rug users" is enough.
