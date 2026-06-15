# Canton Same-Chain Swap: Intent + Atomic Settlement

Same-chain CBTC↔CC swaps use an **intent + settlement** model inspired by CoW Protocol and 1inch Fusion (signed intent → solver settlement), **not** HTLC hashlocks. HTLC remains for **cross-chain** WBTC↔CBTC only (`/api/htlc/*`, `npm run solver:htlc`).

MVP pairs: **CBTC ↔ CC** only.

---

## What we are building

| Layer | What it is |
|-------|------------|
| **Intent** | Off-ledger order in `canton_swap_orders` (amounts, quote TTL, parties) + on-ledger user authorization |
| **Settlement** | One Canton ledger submit that executes both legs or neither (atomic update) |
| **Solver** | RFQ quote, float check, fill daemon (`swap-solver/src/canton-swap-daemon.mts`) |

Cross-chain swaps need hashlocks to bind EVM and Canton legs. Same-chain swaps do **not** — the Canton ledger’s multi-command transaction **is** the atomicity primitive (see [Canton vs Web3 — DvP](https://docs.canton.network/integrations/wallets/canton-vs-web3#delivery-vs-payment-dvp)).

---

## CoW / Fusion mapping (why this shape)

| CoW / Fusion (same-chain intent) | Our Canton implementation |
|----------------------------------|---------------------------|
| User signs **intent** (not a settled transfer) | User signs **pending offer** (`TransferInstruction`), not a direct transfer that lands in solver custody |
| Winning solver submits **one settlement tx** | `fillLoopSwap` / `settleManagedSwap`: one `submitLedgerCommands` with both legs |
| Limit price / minOut at settle | `outAmount`, `minOut`, `SETTLEMENT_SLIPPAGE_BPS` in [`lib/canton-swap-quote.ts`](../lib/canton-swap-quote.ts) |
| Solver competition (future) | RFQ today; Dutch/batch auction later |

We explicitly **do not** use Fusion+ cross-chain HTLC escrows for same-chain C2C.

---

## Architecture by wallet mode

| User type | Flow | Atomic boundary |
|-----------|------|-----------------|
| **Managed (email)** | Quote → create → `POST …/settle` | **One submit**, `actAs: [user, solver]`, both legs direct inside same tx |
| **Loop wallet** | Quote → create → prepare-user-leg → Loop sign → confirm → solver fill | **Solver fill submit**: Accept user offer + deliver counter (same update) |

### Managed — true atomic (best case)

[`settleManagedSwap`](../lib/canton-swap-settle.ts) requires **direct** transfer kind on both legs **inside the same atomic submit**. Preapproval here means auto-accept within that single transaction — not early custody.

### Loop — atomic at settlement (target)

1. User signs `TransferFactory_Transfer` → creates **pending `TransferInstruction`** on settlement receiver ACS (**offer**, not settled holding).
2. Server confirms and binds `userLegOfferCid`.
3. Solver runs **one fill transaction**: `TransferInstruction_Accept` + counter `TransferFactory_Transfer`.

If the user has **CC preapproval**, counter leg is **direct** inside that same fill → fully atomic delivery of both assets at fill time.

If the user lacks CC preapproval, fill still atomically **accepts user leg + creates counter offer**; user **Accept** in Loop is a separate user-controlled step on the receive side only.

---

## What went wrong (preapproval / holding path)

When the **receiver has TransferPreapproval** (CBTC or CC), the registry returns `transferKind: direct`. The user’s Loop sign **completes the sell leg immediately**:

```
User sign (direct)  →  Solver Holding +0.001 CBTC   (custody — NOT an offer)
Solver fill         →  Deliver CC only               (cannot re-accept user leg)
```

This is **custody-first**, not atomic swap. It contradicts the intended “accept + deliver in one submit” design.

**Root cause:** Main solver party has CBTC TransferPreapproval for operational flows. User legs sent there auto-settle on sign.

**Fix:** Route swap user legs to a **settlement receiver party** (`CANTON_SWAP_SETTLEMENT_PARTY`, solver-controlled via m2m, **no** TransferPreapproval). Registry returns `transferKind: offer` → pending `TransferInstruction` → atomic fill works.

| After user Loop sign | Good (offer path) | Bad (preapproval path) |
|----------------------|-------------------|-------------------------|
| On receiver ACS | `TransferInstruction` pending | `Holding` (funds already received) |
| User CBTC status | Locked in offer until Accept | Already gone to solver |
| Fill tx | Accept + deliver (atomic) | Deliver only (trust window) |

---

## Inverted preapproval requirements (important)

| Leg | Managed (one tx, both actAs) | Loop (user signs first) |
|-----|------------------------------|-------------------------|
| User sell → receiver | **Direct** inside same submit | **Offer** — must NOT auto-settle on user sign |
| Counter → user | **Direct** inside same submit | **Direct** if user has CC preapproval; else offer + user Accept |

[`previewManagedSwapReadiness`](../lib/canton-swap-preapproval.ts) correctly requires solver preapproval for managed. Loop swap user legs must **not** use a preapproval-enabled receiver.

---

## Why no custom Oranj Daml contract for C2C

CoW uses a **Solidity settlement contract** (`GPv2Settlement`) because Ethereum has no native multi-signer atomic tx without a coordinator.

On Canton we already use **standard Token Standard Daml contracts** (not “no contracts”):

- `TransferFactory`, `TransferInstruction`, `Holding` (FOP workflow per [CIP-0056 FOP](https://deepwiki.com/canton-foundation/cips/5.1.1-fop-and-dvp-transfer-workflows))
- Atomicity via **one ledger submit** with multiple commands

We have a custom Daml package [`canton-htlc/daml/CbtcHtlc.daml`](../canton-htlc/daml/CbtcHtlc.daml) for **cross-chain HTLC** (hashlock + Allocation). We are **not** adding a custom `OranjSwap.daml` for same-chain because:

1. **Loop wallets** must exercise **standard** choices on their participant (`TransferFactory_Transfer`, `TransferInstruction_Accept`). Custom user-facing templates require our DAR on Loop’s node — same blocker documented in [`README.md`](../README.md) and [`docs/canton-to-evm-design.md`](canton-to-evm-design.md).
2. **Redundant atomicity** — Canton already all-or-nothing’s multi-command submits; a wrapper template mostly duplicates `fillLoopSwap`.
3. **`TransferInstruction` is the escrow** — pending offer holds the user leg until Accept; no separate swap contract needed for MVP.
4. **The bug was routing**, not missing templates — preapproval caused Holding instead of TransferInstruction.

Custom Daml becomes worth it later for on-ledger batch auctions or hard minOut — not for MVP atomic Loop fill.

---

## FOP vs DVP (CIP-0056) — what we use and what we don’t

[CIP-0056](https://deepwiki.com/canton-foundation/cips/5.1.1-fop-and-dvp-transfer-workflows) defines two workflows:

| Workflow | Purpose | Our C2C choice |
|----------|---------|----------------|
| **FOP** (Free of Payment) | Single-asset transfer via `TransferInstruction` | **Yes — Loop user leg + counter delivery** |
| **DVP** (Delivery vs Payment) | Multi-asset atomic settlement via **Allocations** + settlement app | **Not for MVP Loop C2C** (see below) |

### Why not DVP for Loop C2C (yet)

DVP is the canonical CIP pattern for “atomic multi-asset settlement” ([Canton wallet docs — DvP](https://docs.canton.network/integrations/wallets/canton-vs-web3#delivery-vs-payment-dvp)):

1. Settlement app publishes allocation requirements.
2. Each party **allocates** (locks) their asset.
3. Settlement app submits **one transaction** consuming all allocations.

**Theoretically ideal** for CBTC↔CC atomic swap.

**Why we are not pursuing it for Loop C2C MVP:**

| Topic | Assessment |
|-------|------------|
| **Custom DAR on Loop?** | User **allocate** sign uses **standard** `AllocationFactory_Allocate` (Splice interface) — **no Oranj DAR** on Loop for that step. |
| **Settlement execute** | [`docs/canton-to-evm-design.md`](canton-to-evm-design.md): Loop + bare `DvpLegAllocation` **failed on-node** — `ExecuteTransfer` required sender + receiver + executor at execute time across participants. Lock worked; atomic execute did not. |
| **vs HtlcLock** | Custom `HtlcLock` pre-delegates executor authority — works for **managed** email parties (DAR on WarpX), not Loop external parties. |
| **Complexity** | Full DVP needs Allocation Request API, settlement IDs, both registries (Utility CBTC + Splice CC), global synchronizer alignment per CIP. |
| **FOP offer path** | Achieves the same user trust property for Loop: **no custody until solver settlement tx**, using proven TransferInstruction + Accept. |

**Conclusion:** DVP is feasible in principle on Canton and does **not** require our custom DAR on Loop for the **user allocation sign**. It **may** still fail at **settlement execute** for Loop CBTC legs until proven otherwise — we already disproved bare allocation escrow for Loop in cross-chain work. **MVP: FOP offer + atomic fill.** DVP remains a **research spike** (prove two-leg settlement tx with Loop user offline at execute) before replacing FOP.

---

## Trust model (honest)

| Mode | User loses sell asset | User receives buy asset | Trust window |
|------|----------------------|------------------------|--------------|
| Managed settle | Same tx as receive | Same tx | **None** |
| Loop offer + CC preapproval | Solver fill tx | Same fill tx | **None** at settlement |
| Loop offer, no CC preapproval | Solver fill tx | Counter offer in fill tx; user Accepts | No sell-side custody; receive Accept is user-controlled |
| Loop preapproval (broken) | **On user sign** | Later | **Unbounded solver custody** — **blocked in redesign** |

UI must not claim “atomic” or “both legs one transaction” for Loop until `status === filled` (and must distinguish managed vs Loop).

---

## Redesign plan (implemented)

### Phase 1 — Stop broken path ✓

- Reject `transferKind: direct` at `prepare-user-leg` for Loop swaps.
- Block confirm via preapproval-settled / `userLegInboundHoldingCid` path.
- `fillLoopSwap`: always Accept + deliver; never deliver-only.
- Honest UI copy (managed vs Loop).

### Phase 2 — Settlement receiver party ✓

- Env: `CANTON_SWAP_SETTLEMENT_PARTY` (no TransferPreapproval).
- User sell leg receiver = settlement party; counter from solver float party.
- m2m `CanActAs` on settlement party for Accept in fill.

### Phase 3 — Intent hardening ✓

- Expire → `rejectUserLegOffer` for pending offers.
- Settlement slippage / float checks (existing).
- `GET /api/canton/swap/readiness` + counter-leg UX notes.

### Phase 4 — E2E verification

- User sign creates **TransferInstruction** on settlement ACS, not Holding.
- Fill update contains Accept + counter delivery.
- Managed settle regression (unit tests).

### Future (not MVP)

- Multi-solver quote competition (Fusion Dutch auction lite).
- CoW-style batch settlement (multiple orders, one submit).
- DVP spike if FOP path insufficient.

---

## Order statuses

```
open → settling → filled                    (managed)
open → user_locked → filling → filled       (loop, after user signs offer)
open | user_locked → expired | failed | cancelled
```

---

## Modules

| Path | Role |
|------|------|
| [`lib/canton-swap-types.ts`](../lib/canton-swap-types.ts) | Order types and statuses |
| [`lib/canton-swap-store.ts`](../lib/canton-swap-store.ts) | Supabase `canton_swap_orders` |
| [`lib/canton-swap-quote.ts`](../lib/canton-swap-quote.ts) | Quote + settlement slippage |
| [`lib/canton-swap-settle.ts`](../lib/canton-swap-settle.ts) | Managed + Loop fill |
| [`lib/canton-swap-service.ts`](../lib/canton-swap-service.ts) | Order lifecycle |
| [`app/api/canton/swap/*`](../app/api/canton/swap/) | HTTP API |
| [`swap-solver/src/canton-swap-daemon.mts`](../swap-solver/src/canton-swap-daemon.mts) | Poll `user_locked` / `filling` → fill + expire |

---

## Quote tolerances

- Create: client `outAmount` may be up to **+30 bps** above fresh quote (`ORDER_AMOUNT_TOLERANCE_BPS`).
- Settle/fill: fresh quote must stay within **−50 bps** of promised `outAmount` (`SETTLEMENT_SLIPPAGE_BPS`).

---

## API routes

- `POST /api/canton/swap/quote` — live quote
- `GET /api/canton/swap/readiness` — Loop pre-sign readiness (offer path + counter UX)
- `GET /api/canton/swap/assets` — CBTC + CC
- `POST /api/canton/swap` — create intent
- `POST /api/canton/swap/[id]/settle` — managed atomic settle
- `POST /api/canton/swap/[id]/prepare-user-leg` — Loop sell command (must be offer kind)
- `POST /api/canton/swap/[id]/confirm-user-leg` — bind offer CID → `user_locked`
- `POST /api/canton/swap/[id]/fill` — solver atomic fill (daemon)
- `GET /api/canton/swap/history` — user history
- `POST /api/canton/swap/expire` — expire stale orders (daemon)

---

## Loop CC receive

If the user lacks CC preapproval, solver fill creates a counter **offer**; UI shows **Accept in Loop** (`prepare-counter-accept` / `confirm-counter-accept`). User leg was still consumed atomically with counter **creation** in the fill tx.

---

## Operations

- Canton swap daemon: `npm run solver:canton-swap`
- Cross-chain HTLC daemon: `npm run solver:htlc`
- Solver party: `NEXT_PUBLIC_SOLVER_CANTON`
- Settlement party (required for Loop): `CANTON_SWAP_SETTLEMENT_PARTY`
- Daemon auth: `HTLC_DAEMON_SECRET` or `CRON_SECRET`

---

## Legacy

Old `canton-to-canton` rows in `htlc_orders` are **not migrated**. New same-chain swaps use `canton_swap_orders` only.

---

## Constraints

- Managed atomic path requires **direct** transfer kind on both legs **within one submit**.
- Loop user leg requires **offer** transfer kind on sign (settlement receiver without preapproval).
- Solver must hold sufficient counter-asset float at create and fill time.
- UTXO limit (10 holdings) — warn at 8.
- DVP multi-leg settlement requires same synchronizer across registries ([CIP-0056 global synchronizer note](https://deepwiki.com/canton-foundation/cips/5.1.1-fop-and-dvp-transfer-workflows)).
