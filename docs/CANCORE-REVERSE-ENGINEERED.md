# Cancore — Reverse-Engineered Architecture (the blueprint to copy)

> Extracted from Cancore's own production app bundle (`app-dev.cancore.app`,
> `/assets/index-DKbDvUEB.js`) + their docs (`docs.cancore.io/usecases/en`).
> This is the live HTLC EVM↔Canton atomic-swap design — the proof that our
> Fusion+ design works, with their concrete parameters. 2026-06 session.

## TL;DR
Cancore = **real HTLC atomic swap, real EVM chains ↔ Canton**, with a custom Daml
HTLC (Proposal/Counter-Proposal) on the Canton side and a standard EVM HTLC contract
on the other. It is exactly the §1–§9 design in CROSSCHAIN-TRUSTLESS-RESEARCH.md.
Their backend orchestrates the flow but the **HTLC math (one SHA-256 secret) is what
prevents theft** — the orchestrator handles liveness/UX, not custody.

## Chains supported (from the bundle — chainId constants)
| chainId | network | role |
|---|---|---|
| 1 | Ethereum mainnet | EVM leg |
| 11155111 | Sepolia | EVM testnet leg |
| 42161 | Arbitrum One | EVM leg |
| 421614 | Arbitrum Sepolia | EVM testnet leg |
| 56 | BNB Chain | EVM leg |
| 97 | BNB testnet | EVM testnet leg |
| — | **Base** (heavily referenced) | EVM leg |
| — | Canton | the other leg |

**Confirmed: real EVM L1/L2 (Ethereum, Arbitrum, Base, BNB), NOT Zenith.** Assets =
USDC/USDT/DAI. So this directly covers your USDC/WBTC-on-EVM priority.

## Known deployed addresses (testnet, from the bundle)
- **HTLC contract (example in their API schema):** `0x58D154441Fd7efEd22E49Eda369909DdbE54cC0a`
- **USDC Sepolia:** `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`
- (Multicall3 `0xca11…ca11` present = standard tooling.)
These give you a live contract to inspect on Etherscan (read the verified source =
their exact EVM HTLC ABI).

## The EVM HTLC contract (ABI shape, from the bundle)
A classic HTLC, fields confirmed: `sender`, `receiver`, `amount`, `token`,
`contractId`, `preImage`, `hashLock`, `timeout`. Functions/events: **Lock, Claim,
Refund, Withdraw** (+ `Claimed`/`Refunded`/`Withdraw` events). This matches our
`contracts/src/HTLCEscrow.sol` almost field-for-field — ours is already 8/8 passing
and is a valid drop-in equivalent.

## The Canton side (custom Daml HTLC)
From docs + bundle DTOs: **HTLC Proposal** (locker's tokens under `hashLock` + timeout)
and **Counter-Proposal** (counterparty's tokens, same `hashLock`, shorter timeout).
Claim reveals preimage; **Canton node verifies `SHA-256(preimage)==hashLock`** and
atomically releases. Refund on timeout. This is our `canton-htlc/daml/CbtcHtlc.daml`
pattern. Bundle DTOs naming it: `HtlcContractId`, `HtlcSigningSession`,
`accept-main-proposal`, `accept-counter-proposal`, `build-counter-init-request`.

## The orchestration backend (the part that makes it usable)
REST API surface (from the bundle) — this is the off-chain coordinator:
- `POST /htlc/init-request/command` + `/init-request/created` — start a swap, create the proposal
- `/htlc/loop-command/accept-proposal`, `accept-main-proposal`, `accept-counter-proposal` — drive the Canton legs
- `/htlc/loop-command/build-counter-init-request`, `build-transfer-to-venue` — counterparty side
- `claimEvmHtlc`, `ClaimUpdateId`, `ClaimTxHash`, `RefundTxHash` — settlement tracking
- `/htlc/admin/reset-stuck-deliveries`, `{id}/force-withdraw`, `{id}/mark-delivered`,
  `{id}/retry-delivery` — **admin recovery endpoints (telling: even an HTLC system needs
  an operator to nudge stuck swaps — liveness, not custody)**

Key DTO fields tying it together: `hashLock`, `preimage`, `timeout`, `expiresAt`,
`amount`, `tokenAddress`, `chainId`, `htlcContractId`, **`UpdateId`** (the Canton
proof-of-transfer we discussed — they persist it as `ClaimUpdateId`).

## The trust model (precise, from their docs)
- **Protocol = trustless HTLC.** One SHA-256 secret unlocks both legs or both refund.
  No party can steal. ✅
- **Default UX = custodial-convenience:** "the Canton participant node signs
  transactions on your behalf… platform auto-claims." Their backend orchestrates
  proposal/counter-proposal/claim. The HTLC math still prevents theft; the node just
  executes the user's own legitimate legs.
- **Self-custody = "Loop mode"** (user's own Canton Ed25519 key via extension).
- **Admin endpoints exist** for stuck deliveries → confirms the residual risk is
  liveness (someone must push claims/refunds), exactly the irreducible HTLC assumption.

## What this means for OUR build (the punchline)
Cancore validates the entire design AND hands us the parameters:
1. **EVM leg:** our `HTLCEscrow.sol` ≈ their contract. Done. (Optionally inspect their
   verified Sepolia source at `0x58D1…cC0a` to match exactly.)
2. **Canton leg:** our `CbtcHtlc.daml` is the right pattern (Proposal/Counter-Proposal,
   sha256 hashlock, timeout refund). Still must be RUN on the WarpX node (the one true
   unbuilt spike).
3. **Orchestrator:** our `swap-solver` rewires to their proven API shape (init-request →
   proposal → counter-proposal → reveal/claim → settle), persisting `UpdateId`.
4. **Chains/assets:** Ethereum/Arbitrum/Base/BNB + USDC/USDT/DAI — real L1/L2, matches
   your priority.
5. **Trust:** trustless HTLC protocol + optional custodial-signing UX + admin recovery
   for liveness. This is the shippable model.

## Still-open (small)
- Inspect the verified EVM HTLC source on Etherscan (exact ABI) — `0x58D1…cC0a` Sepolia.
- The Daml template locking a REAL third-party holding (cBTC/CC) on YOUR node — the
  make-or-break spike, unchanged.
- Preimage encoding parity (SHA-256 over same bytes) + timeout/skew params.

## Sources
- Cancore app bundle: https://app-dev.cancore.app/assets/index-DKbDvUEB.js
- Cancore docs: https://docs.cancore.io/usecases/en
- (Rho audits checked — they cover Rho's rates/vault protocol, NOT the cross-chain
  swap; no HTLC/Canton content. See CROSSCHAIN-TRUSTLESS-RESEARCH.md §11–12.)
