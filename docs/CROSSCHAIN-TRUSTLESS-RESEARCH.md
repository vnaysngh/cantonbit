# Trustless Cross-Chain Swap Research — EVM ⇄ Canton

> Full research log and findings, from the 1inch Fusion+ starting point through to
> the Chainlink CCIP conclusion. Goal: a swap of any EVM asset (priority **USDC,
> WBTC**) to any Canton asset (cBTC, CC, Canton-USDC) and back, that is **trustless
> — the solver cannot steal user funds.**
>
> Status: research complete. Verdict at the end. No production code written from
> this investigation yet (a verification EVM HTLC + a Canton hashlock-support probe
> were built and run — see §4 and §6).
>
> Date: 2026-06 session. Every load-bearing claim here is either run-and-verified
> (probe output / Foundry test) or cited to a primary source.
>
> **⚠️⚠️ VERDICT OVERTURNED — read §12 FIRST. The "HTLC is impossible" conclusion
> (§6, §10) is WRONG as a general claim and is disproven by a live mainnet product
> (Cancore), confirmed from its own docs.** A custom Daml HTLC template CAN lock a
> Canton asset (CC/cBTC) under a SHA-256 hashlock, with the Canton node enforcing
> `SHA-256(preimage)==hashLock` on-ledger. The §6 probe was correct ONLY about the
> *Splice token registry* (which has no hashlock) — but the real path was always
> "write your own Daml HTLC template," which is exactly what Cancore deployed and
> what our own `canton-htlc/CbtcHtlc.daml` already drafts. See §12 for the corrected
> verdict and the proven blueprint. (§11 covers Zenith — a separate, also-valid
> shared-finality path.)

---

## 0. TL;DR (read this first)

1. We set out to clone **1inch Fusion+** (HTLC atomic swap) for EVM⇄Canton.
2. **HTLC is impossible for Canton assets** — proven by a live mainnet probe: cBTC
   (and CC, USDC — all Splice tokens) support only **time locks**, not **hashlocks**,
   and the registry exposes no preimage-gated choice. You cannot inject a hashlock
   into a token you don't issue, and Canton can't observe an EVM event.
3. So we surveyed **how production cross-chain DEXes get trustlessness WITHOUT HTLC**:
   optimistic-intent (Across, deBridge), MPC/TSS (THORChain, Chainflip), ZK light
   clients (zkIBC/Succinct), and message bridges (CCIP, LayerZero).
4. Every non-HTLC design needs **a truth source that bridges "delivery happened on
   chain B" back to chain A.** For EVM⇄Canton that truth source must NOT be us (a
   self-run watchtower is fake trustlessness — we control the slasher).
5. The only neutral truth source on the horizon is **Chainlink CCIP on Canton** —
   but verified against the docs: **CCIP on Canton is ANNOUNCED, not shipped.** Only
   inbound **Data Streams** is live today (data → Canton; cannot carry a Canton fact
   out to EVM).
6. **Conclusion:** fully steal-proof EVM→Canton is **not achievable today**. Build
   the bonded-solver model now with a pluggable "delivery proof" interface, and
   swap in CCIP attestation when it ships → trustless later, no rewrite. Engage
   Chainlink directly on CCIP-on-Canton timing.

---

## 1. The starting point — what we have, and why it isn't trustless

The existing `swap-solver` is a **custodial optimistic relay**:

1. User locks WBTC on the EVM side via Permit2 in OIF's `InputSettlerEscrow`.
2. Solver delivers cBTC to the user on Canton via a `TransferInstruction` (the user's
   wallet accepts — auto-accept is mandatory).
3. Solver calls `attest()` on its **own** `OranjAttestorOracle`, then `finalise()`
   to release the locked WBTC to itself.

**The fatal trust gap:** step 3 is the solver vouching for itself. The oracle's own
source says it plainly (`contracts/src/OranjAttestorOracle.sol`):

> "Anyone able to call `attest()` can mark an arbitrary fill as proven and thereby
> cause `finalise()` to release the locked WBTC — with or without a real Canton
> delivery. There is no on-chain check that the cBTC actually moved... This is NOT
> trustless."

Trust analysis of the current code (audited this session):

| Party | Can steal? | Why |
|---|---|---|
| User | No | WBTC only ever goes to solver (on attest) or back to user (refund). Worst case = stall → refund. |
| **Solver** | **YES** | Can `attest()`+`finalise()` to pull WBTC having delivered NO cBTC. No penalty. |

What the current code does WELL (keep these): pre-flight ordering (don't deliver
cBTC unless WBTC is locked & claimable first), the HIGH-1 refund guard (never
auto-refund a delivered order → user can't get both legs), permissionless refund
(stalled swap self-heals at `expires`), and recipient-commitment checking (solver
can't redirect cBTC). The single missing property is: **the solver can take WBTC
without delivering cBTC.**

---

## 2. The intended fix — 1inch Fusion+ (HTLC atomic swap)

### How Fusion+ actually works
Sources: [1inch Fusion+ blog](https://blog.1inch.com/1inch-introduces-fusion-plus/),
[1inch/cross-chain-swap](https://github.com/1inch/cross-chain-swap).

1. Maker signs an intent off-chain (no gas), generates a secret `s`, publishes only
   `H = keccak256(s)` (the hashlock).
2. A resolver locks the maker's asset in a **source escrow** (hashlock `H`, long
   timelock) + a safety deposit.
3. Resolver locks its own asset in a **destination escrow** (same `H`, shorter
   timelock) + safety deposit.
4. Maker reveals `s` to claim the destination asset → `s` becomes public on-chain.
5. Resolver uses the now-public `s` to claim the source asset.
6. **One secret unlocks both legs, or both refund after staggered timelocks.** No
   one can steal — worst case is a refund.

The safety deposit is NOT a slashable theft-bond — it's a **cleanup bounty**: during
public timelock windows, anyone who finishes a stalled swap takes the deposit.
Fusion+'s theft-proofness comes ENTIRELY from the HTLC secret; the deposit only
handles liveness. (Verified against the cross-chain-swap repo.)

### Why we tried to copy it
It binds the two legs cryptographically — replacing "trusted oracle attests delivery"
with "the act of claiming one asset reveals the key that claims the other." That
removes trust in the solver. The plan: EVM HTLC escrow ⇄ a Canton HTLC, sharing one
secret.

---

## 3. Can Canton do the HTLC primitives? — the desk research

Two load-bearing primitives, checked against docs:

- **Hashlock:** Daml has `DA.Crypto.Text.sha256` (and `keccak256` on recent SDKs),
  deterministic across validators. A Daml choice CAN assert `sha256 preimage ==
  hash`. ✅ in principle.
- **Timelock:** Per [Daml time semantics](https://docs.digitalasset.com/overview/3.4/explanations/ledger-model/time.html),
  `getTime` returns ledger time, synchronizer-enforced within `±skew_max`. A choice
  CAN enforce "after T" / "before T", fuzzy within skew. ✅ in principle, with the
  rule: every timelock gap must exceed `skew_max + EVM finality + buffer`.

A working Daml HTLC reference exists ([SynfiniDLT/daml-htlc](https://github.com/SynfiniDLT/daml-htlc))
using `sha256` — BUT it's built on Daml.Finance, while cBTC uses the **Splice token
standard** (a different interface family). So it's a pattern reference, not a drop-in.

At this stage HTLC looked feasible IN PRINCIPLE. The open question: can a custom
Daml template actually **lock a real cBTC holding** under a hashlock? Only the live
node answers that.

---

## 4. Verification artifact #1 — the EVM HTLC (RUN, 8/8 passing)

To prove the EVM half is sound, we built and RAN a self-contained SHA-256 HTLC escrow:

- `contracts/src/HTLCEscrow.sol`
- `contracts/test/HTLCEscrow.t.sol`

```
forge test --match-contract HTLCEscrowTest -vv   →   8 passed; 0 failed
```

| Test | Proves | Result |
|---|---|---|
| sha256 parity value | H = sha256(s) is fixed | ✅ `0xa5146db745a9b5587adf7c6bbd18b9ca4094fa4c52b2c345ed8ec8f3d0546cbb` |
| claim with correct preimage | secret releases principal | ✅ |
| claim wrong preimage reverts | no theft via wrong secret | ✅ |
| claim after timelock reverts | can't claim once refund window opens | ✅ |
| refund before timelock reverts | funder can't pull a claimable swap | ✅ |
| refund after timelock | refund works after timeout | ✅ |
| safety deposit paid to claim sender | completion incentive | ✅ |
| no double claim | terminal state closes | ✅ |

**The EVM leg works.** We chose SHA-256 (not keccak256) to match Daml's `sha256`.
The canonical `H` above is the value the Canton leg must reproduce for the same
preimage. (Note: a preimage byte-encoding must be agreed — EVM hashed 32 raw bytes;
Daml `sha256` takes Text. Pin one encoding on both sides.)

The EVM leg is reusable regardless of the final design — it's asset-agnostic (any
ERC-20: WBTC, USDC).

---

## 5. The Canton leg — Allocation is NOT a one-directional HTLC lock

A prior in-repo investigation (and the Splice standard's own structure) shows the
token-standard **Allocation** primitive is **two-party DvP**: `Allocation_ExecuteTransfer`
requires sender + receiver + executor to co-authorize the SAME transaction. A solver
delivering one-directionally to an external user can't satisfy that cross-participant
(`DAML_AUTHORIZATION_ERROR` / 403). So Allocation gives lock + timeout-refund, but
NOT a unilateral preimage-gated release. It cannot be the HTLC lock.

That left one hope: a **custom** Daml template that locks a cBTC `Holding` directly
under a hashlock. Whether that's possible is the make-or-break question — answered
in §6.

---

## 6. Verification artifact #2 — the decisive mainnet probe (the kill shot)

We wrote a **read-only** probe (`swap-solver/src/probe-hashlock-support.mts`) and ran
it against the **live cBTC mainnet registry** with the solver's own credentials. It
touches no funds.

It checked the three places a hashlock could live: registry metadata (supported
choices), a real holding's lock structure, and the registry's choice surface.

### Probe output (mainnet, verbatim highlights)

```
[1] supportedApis: {metadata-v1, transfer-instruction-v1, allocation-request-v1,
    allocation-v1, holding-v1, allocation-instruction-v1}
    hashlock-keyword hits: NONE
[2] sample holding lock field: null
    lock fields available: holders / expiresAt / expiresAfter / context
    NO hash/preimage/condition field. Only TIME conditions.
[3] EXISTS (422) transfer-instruction/v1/transfer-factory
    EXISTS (422) allocation-instruction/v1/allocation-factory
    absent (404) htlc/v1/htlc-factory
    absent (404) hashlock/v1/lock-factory
    absent (404) conditional-transfer/v1/factory

=== VERDICT ===
CONFIRMED: a 1inch-style HTLC atomic swap is NOT buildable for CBTC.
```

### What this PROVES (node-verified, not inferred)
- A cBTC lock can be conditioned **only on time** (`expiresAt`/`expiresAfter`). There
  is no hash/preimage/condition field.
- The registry exposes only transfer + allocation factories. No HTLC/hashlock/
  conditional endpoint exists.
- Cross-referenced with Splice source: CC (Amulet) locking is `LockedAmulet` with a
  `TimeLock` — time-based only, unlock controlled by `(owner) :: (holders)`. You
  cannot insert a `sha256(preimage)==H` assertion because you don't author those
  templates.

### The conclusion that reshaped everything
**HTLC atomicity is impossible for cBTC, CC, and Canton-USDC alike** — it's a property
of the Splice token standard, not a cBTC quirk. Switching assets does not escape it.
Two independent reasons, both true:
1. You can't inject a hashlock into a token you don't issue.
2. Canton can't observe an EVM event, so even a perfect Canton lock can't be
   conditioned on the EVM leg without a trusted party firing release.

Earlier guidance ("Splice has no preimage-gated release; the ceiling is Allocation +
bond") was therefore CORRECT for these assets — now proven on mainnet, not assumed.

---

## 7. The pivot — how production DEXes get trustlessness WITHOUT HTLC

If HTLC is out, what do the real cross-chain DEXes do? Four design families. Every
major protocol is one of these.

### Family 1 — Optimistic intent (Across, deBridge) ← closest fit
- [Across](https://docs.across.to/concepts/intents-architecture-in-across): user
  escrows source asset; a **bonded relayer fronts the destination asset** instantly;
  the relayer is repaid only after settlement verification via [UMA's optimistic
  oracle](https://blog.uma.xyz/articles/case-study-how-uma-secures-across-protocol).
  A relayer's claim is **assumed true but bonded** — **anyone can dispute** in a
  window; a false claim is **slashed**, disputer rewarded. Trust model: "only one
  honest actor needs to dispute."
- [deBridge DLN](https://github.com/debridge-finance/dln-taker): 0-TVL intent; solvers
  lock assets on the destination, submit proof, then source unlocks.
- **This is the same pattern the existing solver half-implements** — done properly,
  with a bond + dispute. It needs only: deliver on the destination (Canton can) +
  let observers read whether delivery happened (Canton's ledger is public).

### Family 2 — MPC/TSS custody network (THORChain, Chainflip)
- [THORChain](https://docs.thorchain.org/technical-documentation/technology/bifrost-tss-and-vaults):
  100+ bonded validators control vaults via threshold signatures; 2/3 supermajority
  to move funds; nodes bond >1.5× vault value so collusion is unprofitable.
- [Chainflip](https://docs.chainflip.io/concepts/swaps-amm/just-in-time-amm-protocol):
  150 validators, FROST threshold sigs, JIT AMM.
- **Wrong for us:** requires running a validator network with TSS — building
  THORChain, not a swap app. (THORChain was [drained for $10.7M in May 2026](https://www.theopensourcepress.com/thorchain-vault-exploit-may-2026/)
  — TSS has real attack surface.)

### Family 3 — ZK light client (zkIBC / Succinct / Polymer / IBC Eureka)
- [Succinct SP1](https://blog.succinct.xyz/ibc/) runs a Tendermint light client and
  verifies Cosmos consensus on Ethereum for ~200k gas. [IBC Eureka](https://ibcprotocol.dev/blog/zkibc-toki)
  connects Cosmos↔Ethereum↔Bitcoin via ZK. Trust = math + each chain's own validators.
- **The "perfect" answer**, but needs a **Canton consensus prover** verifiable on
  EVM — Canton isn't Tendermint, no off-the-shelf prover. Multi-month, research-grade.
  Right eventual answer, wrong first answer.

### Family 4 — Generic message bridge (Chainlink CCIP, LayerZero, Wormhole, Axelar)
- An external oracle network relays verified messages between chains. CCIP is the
  institutional standard (DON + Risk Management Network). Detailed in §8 — this is
  the thread that matters most for Canton.

### The unifying insight
Every non-HTLC design needs **a truth source that bridges "delivery happened on
chain B" back to chain A.** For EVM⇄Canton that source must NOT be us.

---

## 8. The watchtower problem — and why a self-run bond is fake trustlessness

We considered: solver posts a bond; a **watchtower** reads Canton's public ledger;
if the solver lied about delivery, the watchtower calls `challenge()` on the EVM
escrow → slash → user made whole.

**The hole (correctly identified):** if WE run the only watchtower AND resolve
disputes, the bond is theater — we can simply not-challenge ourselves or delete the
watchtower. That's the SAME trust as today, dressed in contract clothing.

A bond only means something if **the slasher is not us.** Three ways to get that:
1. **The user is the slasher** — they always know if they got their cBTC. But with
   mandatory auto-accept the user is passive, AND even the user's challenge needs to
   prove a Canton fact to EVM (the same wall).
2. **A neutral oracle network resolves** (Across's UMA token-holders; a Chainlink
   DON). Not us. This is the real path — see §9.
3. **Math resolves** (ZK light client). Fully trustless, big build.

**Conclusion of §8:** there is NO way to make EVM⇄Canton trustless without either a
neutral Canton→EVM truth bridge (oracle/ZK) or accepting bounded trust. Bonds,
watchtowers, and challenge windows are fake trustlessness if we control the slasher.

---

## 9. The neutral truth source — Chainlink (CCIP / CRE / Data Streams) on Canton

This is the institutional answer and the most important section. Aggressively
verified against the live docs and raw HTML.

### Background facts (verified)
- Canton + Chainlink **strategic partnership** (Sept 2025). Chainlink Labs is a
  Canton **Super Validator**. ([Canton press release](https://www.canton.network/canton-network-press-releases/canton-network-and-chainlink-enter-into-strategic-partnership-to-accelerate-institutional-blockchain-adoption-))
- A real cross-chain **DvP** (Delivery-vs-Payment) between **Kinexys (J.P. Morgan),
  Ondo Finance, and Chainlink** was orchestrated by **CRE** — "atomic exchange of
  assets and payments across disparate networks." ([Chainlink Q2 2025](https://blog.chain.link/chainlink-digital-asset-insights-q2-2025/))
  This proves the institutional cross-chain settlement pattern exists — but as a
  CRE-orchestrated engagement, not a self-serve public primitive.

### What is LIVE on Canton today (verified in the docs)
- **Data Streams** — INBOUND only. A Daml `Verifier` contract checks Chainlink's
  `f+1` OCR signatures **on-ledger**. ([Canton Integration Guide](https://docs.chain.link/data-streams/canton-integration))
  This PROVES Canton can cryptographically trust a Chainlink-signed message without
  trusting us — but the data flows INTO Canton, not out.
- **Proof of Reserve / SmartData** — live (Feb 2026 per announcements).
- **Data-provider (outbound) option** — the docs mention a Canton app CAN publish its
  data as a Chainlink stream "so other parties can consume it with cryptographic
  guarantees" — BUT the docs do **NOT** confirm those parties can be EVM chains, and
  give no EVM verification path. It's a "contact Chainlink" line, not a shipped,
  documented EVM-verifiable primitive.

### What is NOT live on Canton (verified by crawling the directories)
- **CCIP** (cross-chain tokens + messaging — the tool that would let an EVM escrow
  learn a Canton delivery fact from a neutral DON): **NOT a Canton lane.** The
  [CCIP directory](https://docs.chain.link/ccip/directory) lists EVM, Solana, Aptos,
  TON, Hedera, XRPL, Stellar, Tron. **Canton's only appearance is a nav link back to
  the Data Streams page** (confirmed in raw HTML: `{label:"Canton Integration",
  href:"data-streams/canton-integration"}`). Announcements say CCIP "will go live on
  Canton in the near future" — ANNOUNCED, not shipped.
- **CRE** — same; Canton not in the [CRE supported-networks](https://docs.chain.link/cre/supported-networks)
  list (only a nav link).
- CCIP itself DOES support non-EVM families (Solana/Aptos/TON), so "non-EVM" is not
  the blocker — Canton simply isn't a lane yet.

### What CCIP would give us once live on Canton
CCIP does arbitrary cross-chain **messaging** + token transfer, where a contract on
chain A triggers a verified action on chain B, secured by DONs + a Risk Management
Network — **not us**. ([CCIP docs](https://docs.chain.link/ccip)) That is exactly the
neutral Canton→EVM truth source §8 requires. When it ships on Canton, the EVM escrow
could release WBTC only on a **CCIP message attesting Canton delivery**, signed by
Chainlink's DON — genuinely trustless-of-us, and it's the same family as Across's
UMA-secured optimistic settlement but institutional-grade and Canton-native.

### Direction asymmetry (important nuance)
- **EVM→Canton (priority):** needs a Canton fact → EVM. Requires CCIP outbound on
  Canton = **NOT live.** Stuck for full trustlessness today.
- **Canton→EVM (reverse):** needs an EVM fact → Canton. The live inbound `Verifier`
  could release a Canton-side lock on a Chainlink-signed "WBTC settled on Ethereum"
  report **IF** such a report/feed exists. Better near-term story.

---

## 10. Final verdict

### What's possible today (no spin)
- **Fully steal-proof EVM→Canton: NOT achievable today.** Neither HTLC (Canton can't
  — §6, mainnet-proven) nor a neutral attester (CCIP-on-Canton not shipped — §9,
  docs-verified) is available right now.
- The current model is can't-steal for the user (always refundable) but NOT
  can't-steal for the solver (can take WBTC without delivering). Cryptography can't
  fix this for these assets; only a neutral truth source can.

### Recommended path (ships now, trustless later, no rewrite)
**Build the bonded-solver / optimistic-intent model (Across/deBridge family) now,
with the "delivery proof" as a pluggable interface** with two implementations:
- `SelfAttested` (today — honest, bounded trust; be truthful that it's not trustless).
- `CCIPAttested` (drop-in when CCIP-on-Canton ships → the slasher/attester becomes
  Chainlink's DON, not us → genuinely trustless).

Also harden the current model regardless (these are real and independent of the
above): tie the cBTC offer's `executeBefore` to `min(now+TTL, fillDeadline−margin)`
so a too-late accept can't strand a swap (auto-accept makes this safe), and bind the
WBTC `destination` into whatever proof releases it so a compromised key can't reroute.

### Highest-leverage next action
Not more doc-reading. **Ask Chainlink/Canton directly:** "Is CCIP outbound from Canton
callable, on what timeline, and can the Data Streams data-provider path be consumed/
verified on an EVM chain?" Everything downstream depends on that one answer.
Chainlink is a Canton Super Validator and our WBTC/USDC↔Canton case is squarely their
RWA thesis — this is a partnership conversation worth having.

---

## Appendix A — Artifacts produced this session
- `contracts/src/HTLCEscrow.sol` + `contracts/test/HTLCEscrow.t.sol` — EVM HTLC, 8/8 passing (§4).
- `swap-solver/src/probe-hashlock-support.mts` — mainnet hashlock-support probe, VERDICT: not buildable (§6).
- `canton-htlc/daml/CbtcHtlc.daml` + `CbtcHtlcTest.daml` — custom Splice HTLC template + Daml Script (the design the probe then proved can't lock a real holding).
- `canton-htlc/VERIFY.md`, `canton-htlc/BONDED-SWAP-SPEC.md` — earlier specs (superseded in part by §9–§10).

## Appendix B — Primary sources
- 1inch Fusion+: https://blog.1inch.com/1inch-introduces-fusion-plus/ · https://github.com/1inch/cross-chain-swap
- Daml time semantics: https://docs.digitalasset.com/overview/3.4/explanations/ledger-model/time.html
- Daml HTLC reference: https://github.com/SynfiniDLT/daml-htlc
- Across: https://docs.across.to/concepts/intents-architecture-in-across · https://blog.uma.xyz/articles/case-study-how-uma-secures-across-protocol
- deBridge DLN: https://github.com/debridge-finance/dln-taker
- THORChain: https://docs.thorchain.org/technical-documentation/technology/bifrost-tss-and-vaults
- Chainflip: https://docs.chainflip.io/concepts/swaps-amm/just-in-time-amm-protocol
- ZK-IBC / Succinct: https://blog.succinct.xyz/ibc/ · https://ibcprotocol.dev/blog/zkibc-toki
- Chainlink CCIP: https://docs.chain.link/ccip · https://docs.chain.link/ccip/directory
- Chainlink CRE: https://docs.chain.link/cre · https://docs.chain.link/cre/supported-networks
- Chainlink Data Streams on Canton: https://docs.chain.link/data-streams/canton-integration
- Canton×Chainlink partnership: https://www.canton.network/canton-network-press-releases/canton-network-and-chainlink-enter-into-strategic-partnership-to-accelerate-institutional-blockchain-adoption-
- Chainlink CRE DvP (JPM/Ondo): https://blog.chain.link/chainlink-digital-asset-insights-q2-2025/

---

## 11. ADDENDUM — Live competitors + Zenith change the picture (revises §6, §10)

Late in the session we checked rho.trading, which led to discovering a cluster of
**live mainnet products doing exactly EVM↔Canton settlement.** This materially
revises the earlier "trustless is impossible today" verdict. Honest correction
included.

### 11.1 The three products
- **CantonSwap** — Canton↔Canton only. "First CC→cBTC atomic swap" (Oct 2025) is
  BOTH assets on Canton, one Daml transaction, all-or-nothing via the global
  synchronizer. **No EVM, no HTLC.** This CONFIRMS §6: Canton's native atomicity is
  internal-only. (https://www.cantonswap.com/)
- **Cancore** — Canton↔EVM. Claims trustless P2P **HTLC** atomic swaps of Canton
  assets ↔ EVM stablecoins (USDC/USDT/DAI on Ethereum/Polygon/Arbitrum), plus
  liquidity pools. "No custody, no relays, no bridge validators." Live on mainnet,
  Canton Network featured app. **Marketing only so far — no technical doc found;
  the HTLC/trustless claims are UNVERIFIED at the mechanism level.** (https://cancore.io/)
- **Rho Relay** — Canton↔EVM. Private RFQ cross-chain swaps, "native EVM access to
  Canton Coin," claims "atomic settlement" + "non-custodial." Announced May 2026.
  Also marketing-level; mechanism not disclosed. (https://docs.rho.trading/)

### 11.2 The real unlock: Zenith (this is the important part)
**Zenith** (launched Mar 2026) is **"the Ethereum execution environment natively
integrated with Canton Network" — explicitly "a native execution environment, NOT a
bridge."** EVM transactions on Zenith **settle atomically to Canton**; it shares
Canton's finality. The **`external_call()` primitive** lets Solidity contracts
"interact seamlessly and atomically with Daml smart contracts."
(https://www.theblock.co/post/394288 · Zenith launch PR)

**Why this matters — it dissolves the wall this whole doc is built on.** Our core
blocker was "EVM can't see Canton, so the EVM escrow can't verify a Canton delivery
without a trusted relay." But in Zenith, **the EVM environment and Daml are ONE
ledger with ONE atomic commit** — there is no cross-chain gap to bridge. An EVM
contract and a Daml transfer can be in the same atomic transaction. So:
- HTLC isn't even needed in the Zenith model — you get **CIP-56-style all-or-nothing
  DvP atomicity** that now spans an EVM contract AND a Daml token, because they're on
  the same synchronizer. That's genuinely trustless and atomic.
- Our §6 probe was NOT wrong — it proved the *Splice token registry* has no hashlock,
  which is true. But it tested the wrong layer for this: the unlock isn't a hashlock,
  it's **shared-finality co-execution** (Zenith), a path that didn't exist / wasn't
  examined when we ran the probe.

### 11.3 The CRITICAL unresolved question (do not skip)
**Does "Ethereum" in Zenith mean real Ethereum L1, or an EVM env hosted on Canton?**
The launch PR **deliberately does not say** whether real Ethereum-mainnet assets
(USDC/WBTC on L1) can be atomically swapped, or whether the EVM asset must live
*inside* the Zenith-on-Canton environment first. It says L1 interop is "enabled
through Chainlink and LayerZero integrations" — which implies **a bridge is still
needed to reach real Ethereum L1**, and the clean atomicity is between
**Zenith-EVM-on-Canton ↔ Canton-Daml**, NOT real-L1-Ethereum ↔ Canton.

If that reading is right (needs confirmation):
- **Asset already on Canton/Zenith ↔ Canton asset:** trustless + atomic TODAY (one
  ledger). ✅
- **Real Ethereum-L1 USDC/WBTC ↔ Canton asset (OUR priority):** still needs a bridge
  (Chainlink/LayerZero) to get the L1 asset into Zenith first → the bridge is the
  trust point, same wall, just moved to a reputable bridge instead of us. ⚠️

### 11.4 Revised verdict
- §6 stands for the token registry, but **§10's "trustless impossible today" is too
  strong.** For assets **on Canton/Zenith**, trustless atomic EVM↔Canton settlement
  **exists today** via Zenith's shared-finality co-execution (no HTLC, no relay).
- For **real-Ethereum-L1 assets** (USDC/WBTC on mainnet — the priority), the open
  question is whether you still need a bridge into Zenith. If yes, the trust reduces
  to the bridge (Chainlink/LayerZero), not you — still a big improvement, and not a
  self-run watchtower.
- **Biggest strategic shift:** you may not need to BUILD the cross-chain trust layer
  at all — **build your swap app ON Zenith** (deploy your Solidity escrow into
  Zenith's EVM env, atomically settle against Canton tokens via `external_call()`),
  and let Zenith provide the atomicity. This could be dramatically simpler than
  everything in §1–§10.

### 11.5 Next research steps (decisive, not yet done)
1. **Zenith real-L1 question (§11.3)** — does atomic swap reach Ethereum mainnet
   assets, or only Zenith-hosted EVM assets? This decides whether your USDC/WBTC
   priority is solved or still needs a bridge.
2. **Cancore/Rho actual mechanism** — get their technical docs/contracts. Is it
   Zenith-based, genuine HTLC, or a bonded/trusted relay behind "trustless" marketing?
3. **How to build on Zenith** — SDK, deploy model, how `external_call()` binds an
   EVM escrow to a Daml token transfer atomically; whether cBTC/CC/USDC are
   addressable from Zenith EVM.

### 11.6 Sources (addendum)
- Rho Relay: https://docs.rho.trading/ · https://www.globenewswire.com/news-release/2026/05/15/3296003/0/en/rho-labs-announces-rho-relay-bringing-private-cross-chain-settlement-to-the-canton-network.html
- Cancore: https://cancore.io/ · Canton Network featured-app posts
- CantonSwap: https://www.cantonswap.com/ · https://www.canton.network/ecosystem/cantonswap
- CIP-56 spec (Canton-internal atomicity, no hashlock): https://github.com/canton-foundation/cips/blob/main/cip-0056/cip-0056.md
- Zenith (native EVM layer on Canton): https://www.theblock.co/post/394288/zenith-links-canton-ethereum-through-atomic-swaps · https://www.prnewswire.com/news-releases/zenith-launches-as-the-evm-layer-for-canton-network-merging-ethereums-developer-ecosystem-into-wall-streets-blockchain-302705132.html
- Canton×Ethereum unifying blog (external_call): https://www.canton.network/blog/ethereum-and-canton-unifying-public-innovation-with-institutional-scale

---

## 12. ⭐ CORRECTED VERDICT — HTLC IS buildable for EVM↔Canton (Cancore proves it)

This supersedes §6's and §10's "HTLC impossible" conclusion. Verified directly from
**Cancore's own documentation** (https://docs.cancore.io/usecases/en), not search
summaries.

### 12.1 What Cancore runs on mainnet (their docs, quoted)
A textbook **HTLC cross-chain atomic swap**, real EVM ↔ Canton:
- "HTLC (Hash Time-Locked Contract) is the cryptographic primitive that makes
  trustless cross-chain atomic swaps possible."
- Alice computes `hashLock = SHA-256(preimage)`, locks Token A on Network 1; Bob
  locks Token B on Network 2 with the **same hashLock, shorter timeout**; Alice
  reveals preimage to claim B → Bob uses revealed preimage to claim A; timeout →
  both refund. (Pure Fusion+.)

**Canton side (the part §6 said was impossible):**
- "the platform creates an **HTLC Proposal** on the Canton ledger. This **Daml
  contract** locks Alice's tokens under the **hashLock** and sets the timeout."
- "Bob → **Counter-Proposal** locks Bob's tokens with the same hashLock, shorter timeout."
- "Alice claims by revealing the preimage. **The Canton node verifies
  `SHA-256(preimage) == hashLock`** and atomically transfers both locked amounts."

**EVM side:** standard `approve` (ERC-20) → `Lock` in an HTLC smart contract →
`Claim` (preimage) / `Refund` (timeout), via MetaMask. The docs reference
**Etherscan** for manual refund → it is **real EVM**, not Zenith.

### 12.2 Why §6 was wrong (precise correction)
The §6 probe tested the **Splice token-standard registry HTTP API** (transfer-factory
/ allocation-factory) and correctly found NO hashlock there. The error was
generalizing that to "no Canton mechanism can hashlock the token." **A CUSTOM Daml
template CAN** — it locks the holding and gates release on
`assertMsg (sha256 preimage == hashLock)`, enforced by the Canton node. The standard
registry doesn't expose it; you write your own. Cancore did exactly this.

**Our own `canton-htlc/daml/CbtcHtlc.daml` (built earlier this session) is precisely
this design.** It was correct all along; the probe result was mis-scoped.

### 12.3 The trust caveat (important, from their docs)
Trustless at the PROTOCOL level (locks + preimage are real on both chains), but the
DEFAULT UX is custodial-convenience: *"the Canton participant node signs transactions
on your behalf... the platform handles Canton signing transparently"* and *"Platform
auto-claims."* Self-custody is the opt-in **"Loop mode"** (user's own Canton Ed25519
key via browser extension). So the HTLC prevents THEFT regardless, but in default mode
the platform's node executes the user's Canton legs. This is a viable UX model for us
(smooth default + self-custodial opt-in).

### 12.4 The proven blueprint (what to build)
| Leg | Mechanism | Our existing artifact |
|---|---|---|
| EVM | HTLC contract: `approve`→`lock(hashLock,timeout)`→`claim(preimage)`/`refund()` | `contracts/src/HTLCEscrow.sol` — built, **8/8 tests pass** |
| Canton | Custom Daml HTLC template (Proposal/Counter-Proposal); node verifies `sha256(preimage)==hashLock`; refund on timeout | `canton-htlc/daml/CbtcHtlc.daml` — drafted; was the RIGHT design |
| Bind | One SHA-256 secret unlocks both; staggered timeouts (Canton shorter) | Fusion+ model (§2) |

This is genuinely trustless (no oracle, no bond, no watchtower, no relayer) — the
secret reveal binds the legs cryptographically. The earlier "best achievable is
bonded/trusted" conclusion was a consequence of the mis-scoped probe; with a custom
Daml HTLC, full Fusion+-style atomicity is achievable.

### 12.5 Open items (small, not blockers)
1. **Which EVM networks/addresses** Cancore deploys to (docs don't name them) — inspect
   their deployed HTLC contract or ask. Decides USDC/WBTC L1 vs L2.
2. **The preimage byte-encoding** must match on both legs (EVM hashes raw bytes; Daml
   `sha256` takes Text) — pin one encoding (see canton-htlc/VERIFY.md).
3. **Locking a third-party token (CC/cBTC) into a custom template** — Cancore does it
   via the HOLDER authorizing the lock into the HTLC Daml contract (the user locks
   their OWN holding; not the solver locking someone else's). Confirm this maps to our
   flow (in a swap, each side locks their own asset — it does).

### 12.6 Net
**Build the Fusion+ HTLC design** (EVM HTLC ⇄ custom Daml HTLC, shared SHA-256 secret).
It is trustless, atomic, needs no third party, and is PROVEN in production by Cancore.
Our two artifacts (`HTLCEscrow.sol` + `CbtcHtlc.daml`) are the correct foundation —
the remaining work is the Daml template locking a real holding + the
encoding/timeout/UX details, not a research unknown.

### 12.7 Sources (§12)
- Cancore use-case docs (HTLC mechanism, Canton hashlock, EVM/MetaMask/Etherscan, wallet/trust modes): https://docs.cancore.io/usecases/en
