# Atomic / No-Pre-Lock Swap Design (WBTC ↔ CBTC)

## CANTON-SIDE AUDIT (2026-06-05) — "is our design the best for EVM→Canton?"

Verified from primary sources (Canton token-standard docs, Canton's own
cross-chain "fine print" blog, the CIP DvP/Allocation workflow):

- **Canton has NO trustless/atomic settlement with EXTERNAL chains.** Atomicity is
  *strictly internal*: *"all input contracts in a Daml transaction must be assigned
  to the same synchronizer; no external chain coordination."* Canton's
  "atomic cross-subnet" marketing is Canton-domain↔Canton-domain, NEVER
  Canton↔Ethereum/Arbitrum.
- **Every EVM→Canton swap therefore REQUIRES a trusted executor/solver.** The
  Allocation/DvP primitive: *"no mechanism for external events (an Ethereum tx)
  triggering Canton allocations. Release requires a Canton party — the settlement
  app — to execute. Cross-chain swaps need an intermediary relayer/solver... NOT a
  trust-minimized atomic protocol."* So the trusted-solver model is **unavoidable**,
  not a shortcoming of our design.
- **BUT our current Canton leg is weaker than it needs to be.** Today we do a
  **plain fire-and-forget `TransferInstruction`** (solver float → user) and bind it
  with **our own oracle** (solver attests to itself). The **Allocation primitive**
  gives the Canton leg **native conditional-lock + automatic timeout-refund** — the
  institutional DvP safety properties — instead of our hand-rolled oracle trust.
  CantonSwap used standard interfaces for the first CC↔cBTC atomic swap (Oct 2025).
- **CCIP / Chainlink-Canton** = message passing / data, NOT atomic swap settlement;
  not mature for this. Canton's own "fine print" blog doesn't even cite it.

**Verdict:** Our current implementation is NOT the best version — the *model*
(trusted solver) is forced by Canton's limits and can't be improved away, but the
*Canton-leg mechanism* can: replace plain-transfer + own-oracle with the
**Allocation primitive (lock/release/refund)**. Best achievable EVM→Canton design =
trusted-solver (unavoidable) + Allocation on the Canton leg + CoW-style pre-flight +
tight timeout-refund on the EVM leg. All shipped/audited primitives; no fork.

---


> **Question from the team:** "Can we do it exactly like CoW Swap — don't pre-lock
> the user's funds — and HTLC-bind the two legs so they can't desync? And why
> can't we just fork CoW's contracts *if needed*?"
>
> **Short answer:** We can get *most* of the way to CoW's UX, and HTLC atomicity
> is **technically feasible** because Canton can run a SHA-256 hash-timelock (a
> Daml HTLC exists and cBTC is a Daml-Finance token). But we **cannot literally
> fork CoW's contracts** — their cross-chain is itself two-legged and its bridge
> leg (Across) *does* lock funds; nothing they ship settles atomically across an
> EVM↔Canton boundary. The realistic target is: **stop per-swap pre-locking
> (switch to a resource-lock / standing-deposit model) and, optionally, bind the
> two legs with an HTLC for true atomicity.**

Date: 2026-06-05. Author: design spike. Status: proposal — no code yet.

## VERIFIED (multi-source audit, 2026-06-05)

Confirmed across CoW's own docs, SDK source, and community research — not inferred:

- **CoW's own engineers state cross-chain atomicity is IMPOSSIBLE.** From the
  CoW cross-chain research thread (ethresear.ch/t/cross-chain-cowswap/16319):
  *"in a cross-chain context, we can't atomically execute transactions, and
  cannot verify if a user actually has sent tokens."*
- That thread evaluates exactly four mechanisms and their verdicts:
  - **HTLC** — *"vulnerable to front-running."* (Why we don't default to it.)
  - **AMB (message passing)** — two messages, *"high bridge fees."*
  - **Centralized watcher** — users *"deposit tokens with order id in a smart
    contract,"* watcher matches + releases. **← This is our solver model.**
  - **Intents (SUAVE/Anoma)** — research phase.
  - Risk: *"Users face solver risk; the system relies on solver honesty during
    non-atomic execution"* → mitigation: *"solvers must have stake in both chains"*
    with slashing.
- **CoW's SHIPPED cross-chain** (docs/cow-protocol/.../swap-and-bridge.mdx, read in
  full): atomic same-chain swap into an *intermediate token* → a signed **post-hook**
  routes it through the user's **Account Proxy (CoW Shed)** → deposits into
  **Across/Bungee** (all in one source-chain tx) → bridge delivers on dest chain.
  *"The bridge step will only start after a successful swap... If your order
  expires/cancels/fails, bridging will not start — your funds remain in your
  wallet."* On bridge failure: *"Across provider usually refunds after ~3 hours."*
- **No CoW cross-chain CONTRACT exists** — the whole thing is the cow-sdk
  `packages/bridging` delegating to Across/Bungee, which are **EVM-only** (no
  Canton spoke). So there is nothing to fork for the Canton leg.
- **Same-chain "no pre-lock" is an atomicity property**, not a cross-chain one
  (coinstancy, mixbytes): funds stay in-wallet because settle() is one atomic tx.

**Conclusion:** our non-atomic, solver-bounded, timeout-refund design IS the model
CoW themselves identify for cross-chain (their "watcher / solver-with-stake" path).
Being non-atomic is not falling short of CoW — CoW is non-atomic cross-chain too,
by their own statement. Safety comes from: pre-flight before delivery + tight
timeout + bounded solver exposure (see docs/COW-CLONE-SAFETY-SPEC.md).

---

## 1. What we have today (and why it strands funds)

Forward swap, live on mainnet:

1. **Lock** — solver calls `openFor` on OIF's `InputSettlerEscrow` (Arbitrum).
   The user's WBTC is **pulled into escrow immediately**, before anything is
   delivered. *(This is leg 1.)*
2. **Deliver** — solver sends cBTC to the user's Canton party.
3. **Attest** — solver attests the fill to our oracle.
4. **Finalise** — escrow releases the WBTC to the treasury.

The trust/risk: between legs 1 and 4 the WBTC is **really locked**, and the two
legs are bound only by *a trusted solver + an optimistic oracle attestation*, not
by cryptography. If the solver dies between legs (exactly what stranded the
0.00001 order), the funds sit locked until the `expires` timeout and a refund.

Two distinct weaknesses, which map to the team's two asks:

| Weakness | CoW-style fix | Atomicity fix |
|---|---|---|
| **Pre-lock**: WBTC leaves the wallet at order creation | Don't escrow per-swap; use a resource lock / standing deposit, pulled only after the output is proven | (orthogonal) |
| **Desync**: legs bound by trusted solver + oracle | (orthogonal) | HTLC: one SHA-256 secret unlocks *both* sides, or both refund |

The team's stated priority is **don't pre-lock**. We cover that first, then HTLC.

---

## 2. How CoW *actually* does cross-chain (so we stop guessing)

Primary sources, not memory:

- **CoW same-chain** is genuinely atomic: a batch settles in one tx; if no solver
  fills, your funds never moved.
  ([cow.fi/learn/how-cow-protocol-actually-works](https://cow.fi/learn/how-cow-protocol-actually-works))
- **CoW cross-chain ("Swap & Bridge")** is **two-legged, not one atomic
  cross-chain tx**: *"The bridge step will only start after a successful swap. If
  your order expires, is canceled, or fails, bridging will not start — your funds
  remain in your wallet."*
  ([docs.cow.fi/.../swap-and-bridge](https://docs.cow.fi/cow-protocol/tutorials/cow-swap/swap-and-bridge))
- CoW does **not run its own bridge** — it **aggregates** Bungee (Socket) and
  **Across**. ([cow.fi/learn/cow-dao-unveils-seamless-cross-chain-swaps](https://cow.fi/learn/cow-dao-unveils-seamless-cross-chain-swaps))
- **Across** (the actual settlement layer) **DOES lock the user's funds in escrow
  on the origin chain** — the relayer fronts the destination asset, then is repaid
  from the origin escrow after optimistic verification. *"your funds are locked
  in escrow on the origin chain's smart contract."*
  ([docs.across.to/concepts/intent-lifecycle-in-across](https://docs.across.to/concepts/intent-lifecycle-in-across))

**Implication #1 — "fork CoW's contracts" is the wrong target.** There is no
"CoW cross-chain contract." Cross-chain = CoW's batch settler (EVM) **+** a 3rd-
party bridge (Across/Bungee), and **none of those touch Canton**. Across, Bungee,
Hop, Stargate, Celer are all EVM/known-chain bridges with no Canton spoke. Forking
them buys nothing because the destination we care about (Canton/cBTC) isn't a
chain any of them support. The cBTC ledger isn't an EVM chain with a SpokePool.

**Implication #2 — the "no pre-lock" magic is at the *swap* layer, not the
bridge.** CoW keeps funds in-wallet because *same-chain* swaps are atomic. The
moment value crosses chains (the bridge leg), a lock reappears (Across escrow). So
even CoW does not give you "cross-chain with zero lock." The realistic bar is:
**don't lock *per swap, up front, in a bespoke escrow* — use a resource lock.**

---

## 3. The "don't pre-lock" path: OIF already ships it

We are using OIF's `InputSettlerEscrow` — the *pre-lock* variant. **OIF also ships
`InputSettlerCompact`**, the resource-lock variant, in the same audited repo
([oif-contracts/src/input/compact/InputSettlerCompact.sol](https://github.com/openintentsframework/oif-contracts)).
Its own natspec:

> *"This Input Settler implementation uses **The Compact** as the deposit scheme.
> It is an **Output-first** scheme that allows users with a deposit inside The
> Compact to execute transactions that will be **paid after the outputs have been
> proven**. … failed orders can be quickly retried. These orders are **entirely
> gasless** since neither valid nor failed transactions require any transactions
> to redeem."*

**The Compact** (Uniswap's resource-lock standard) is a singleton vault: a user
makes **one standing deposit**, then signs per-intent allocations against it. The
settler pulls funds **only after** the destination output is proven. So:

- ✅ No bespoke per-swap escrow tx; no funds pulled until the fill is proven.
- ✅ Gasless, instantly retryable failed orders.
- ⚠️ **Not literally "in your wallet"** — it's a standing deposit in The Compact
  vault. For a *first-time, one-off* swapper this is arguably *worse* UX than our
  current flow (they must fund the vault first). The win is for *repeat* swappers
  and for *not stranding* funds mid-swap.

**This is the smallest, lowest-risk step toward CoW UX**: swap one audited OIF
settler for another. It removes the per-swap pre-lock without us writing or
auditing new EVM code. *It does not, by itself, make the two legs atomic* — the
Canton delivery is still bound by our oracle/solver. (See §5.)

---

## 4. Can Canton be one leg of a real HTLC? **Yes.**

The make-or-break unknown was whether Canton/Daml can do a hash-timelock that
*coordinates with Ethereum*. It can:

- A working **Daml HTLC exists**:
  [SynfiniDLT/daml-htlc](https://github.com/SynfiniDLT/daml-htlc). Reading the
  source (`model/main/src/Synfini/HTLC.daml`):
  - **Hash lock** — `HTLC_Claim` requires `sha256 preImage == hash`. **SHA-256**,
    the *same* primitive available on the EVM side. This is the crux: **one secret
    unlocks both chains.**
  - **Time lock** — `HTLC_Claim` only `now < unlockTime`; `HTLC_Unlock` (refund to
    sender) only `now >= unlockTime`. Canonical HTLC semantics.
  - It locks a **Daml-Finance `Holding`** via `Holding.Acquire`/`Semaphore` and
    releases via `Holding.Release` + `Transferable.Transfer`. **cBTC is a
    Daml-Finance token**, so this composes with real cBTC holdings.
- We already validated the cBTC token standard's **`Allocation`** primitive
  (lock / conditional-release / refund-on-timeout) on the **live mainnet
  registry** (see `docs/REVERSE-SWAP-FEASIBILITY.md`). Allocation gives us the
  lock+timeout half natively; an HTLC adds the *hash* condition that binds it to
  the EVM secret.

So a classic two-HTLC atomic swap is **technically feasible**:

```
secret s, H = sha256(s)
1. Solver locks cBTC on Canton in an HTLC(hash=H, unlock=T_canton, claimant=user)
2. User locks WBTC on Arbitrum in an HTLC(hash=H, unlock=T_evm  , claimant=solver)   [T_evm < T_canton]
3. User claims cBTC by revealing s on Canton           → s is now public
4. Solver uses the revealed s to claim WBTC on Arbitrum
   If either side stalls, both refund after their timelocks. Never one-sided.
```

This is the **only** model here where neither party can be cheated and funds
*cannot* desync — atomicity is enforced by `s`, not by trusting our solver.

---

## 5. Why HTLC is powerful but *not* a free lunch for *this* product

Honest trade-offs, because they decide whether it's worth it:

1. **HTLC requires the *user* to act on *both* chains.** Classic atomic swaps are
   peer-to-peer: the user locks on chain A, claims on chain B. That means the user
   needs a funded, signing presence on **both** Arbitrum **and** Canton, and must
   do a lock + a claim (revealing the secret). That is *more* steps and *worse* UX
   than today's "sign once, solver does the rest." It directly **conflicts with the
   "feels like CoW / one signature" goal.**
2. **Who generates the secret matters.** Whoever knows `s` first has free option
   value (they can choose to complete or walk after seeing the other side locked).
   Standard mitigations (receiver-generated hash, fee bonds) add protocol weight.
3. **Timelock safety needs `T_evm` << `T_canton`** and clock-skew margin across
   two very different ledgers (Arbitrum block time vs. Canton record time). Get the
   ordering wrong and you reintroduce a steal vector.
4. **It throws away the solver's main value** — fronting liquidity so the user
   gets the output *fast*. A pure HTLC is a *swap of locks*, not an *instant fill*.

**Net:** HTLC maximises trust-minimisation but is a different product (P2P atomic
swap), not "intent + solver fills instantly." It's the right tool if the goal is
*trustless*; it's the wrong tool if the goal is *CoW-like one-tap UX*.

---

## 6. Recommendation (matched to the stated priority: "don't pre-lock")

A staged path, lowest-risk first. Each stage is independently shippable.

**Stage A — Resource lock instead of per-swap escrow (CoW-style "no pre-lock").**
Swap our `InputSettlerEscrow` integration for OIF's audited
`InputSettlerCompact` + The Compact. WBTC is no longer pulled per-swap; the
settler pulls only after the Canton output is proven. Keeps our existing
solver/oracle flow on the Canton side. **No new audited contracts from us.**
*This is the direct answer to "do it like CoW."* Effort: medium (integrate The
Compact deposit UX + swap settler + re-point the solver's open/finalise calls).
Main UX cost: first-time users must deposit into The Compact once.

**Stage B — Already done (this session): bound the damage on the current escrow.**
Tight windows (10m fill / 20m expire) + **automatic** refund-on-expiry. Makes the
*existing* pre-lock model fail safe and self-heal while Stage A is built.

**Stage C — Optional, only if the goal becomes *trustless*: HTLC atomic mode.**
Use the Daml HTLC (`Holding.Acquire` + `sha256`) on Canton ⟷ a SHA-256 HTLC on
Arbitrum, sharing one secret. Offer it as an *advanced / trust-minimised* path
alongside the fast solver path — not the default, because it costs the one-tap UX.
Effort: high (new Daml HTLC workflow + EVM HTLC contract + careful timelock
ordering + secret-management protocol). This is the only path that makes the two
legs *cryptographically* atomic.

**What we are NOT doing, and why:** forking CoW/Across/Bungee. None settle to
Canton; cBTC is not an EVM SpokePool chain. Forking them is wasted effort — the
reusable pieces (resource lock = The Compact; conditional lock on Canton =
Allocation/HTLC) are *already available to us directly*, without a fork.

---

## 7. Open questions before committing to Stage A

1. Does The Compact have a deployment / canonical address on **Arbitrum One**? (It
   does on mainnet/several L2s — confirm Arbitrum specifically.)
2. The Compact deposit UX for a **first-time** swapper — is the one-time deposit
   acceptable, or does it negate the UX win for our (currently one-off) users?
3. Our Canton delivery still uses oracle attestation in Stage A — do we want to
   *also* move the Canton leg to Allocation-with-timeout now (mirrors the EVM
   refund), or leave it until Stage C?
4. For Stage C: receiver-generated-secret variant to remove solver option value —
   confirm the Daml HTLC supports the receiver setting `hash` (the SynfiniDLT
   template has the *sender* set it; we'd adapt).

---

## 8. One-line answers to the exact questions asked

- **"Do it exactly like CoW, don't pre-lock"** → Stage A: switch to OIF
  `InputSettlerCompact` (The Compact resource lock). That *is* the CoW model.
  Caveat: even CoW's *cross-chain* leg (Across) locks; zero-lock cross-chain
  doesn't exist.
- **"HTLC-bind the legs"** → Feasible: Daml HTLC (SHA-256) ⟷ EVM HTLC. Stage C.
  Cost: it becomes a P2P atomic swap (user acts on both chains), losing the
  one-tap solver UX.
- **"Why not just fork their contracts if needed?"** → Because the contract that
  would touch Canton **doesn't exist in their stack**. CoW cross-chain = EVM batch
  settler + Across/Bungee, all EVM-only. The forkable/reusable primitives we'd
  actually want (The Compact, Daml HTLC, cBTC Allocation) are already available to
  us *without* forking anything.
```
