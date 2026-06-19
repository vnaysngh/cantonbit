# Swap fee economics & network fees

Single reference for **managed (email / participant-hosted)** swap fees: platform spread, Canton network (traffic) fees, byte breakdowns, ops enablement, and P&L planning.

Companion to [SWAP-RUNBOOK.md](SWAP-RUNBOOK.md).

**Scope:** Managed C2C (CBTC↔CC) and managed HTLC cross-chain (WBTC↔CBTC on Base). Loop wallet paths use a different custody model and are not covered here.

---

## 1. Two fee types (never conflate)

| Fee | Asset | Purpose | Who receives |
|-----|-------|---------|--------------|
| **Platform fee** | CBTC / CC / WBTC (output spread) | Platform margin | Spread (not a separate ledger line) |
| **Network fee** | CC | Pass-through for Canton traffic on **user-charged** submits | `NETWORK_FEE_RECEIVER_PARTY` (WarpX node party) |

- Platform fee default: **1%** output-side (`PLATFORM_FEE_BPS=100`).
- Network fee: prepare-measured traffic bytes → USD → CC, plus quote buffer (`NETWORK_FEE_BUFFER_BPS`, default **1000** = +10%).
- **Quote vs order (critical):** the **60s RFQ TTL** applies only to **pre-order** price previews (`/api/htlc/quote`, review modal). Once the user creates an order, **`networkFeeCc` is bound on the order** and execution re-estimates bytes but **never charges above that cap** — there is **no separate fee expiry mid-swap**. If the swap is still valid (legs locked, before timelock), claim/settle must not fail with “quote expired.”
- Settlement vault (`CANTON_SWAP_SETTLEMENT_PARTY` = `oranj-settle-*`) handles swap float. **Only** network fees go to the node party — not the vault.

---

## 2. Unified network-fee policy (all products)

One rule everywhere:

> **Quote user network fee on business-command bytes only.**  
> **Never include the CC fee-transfer command in the byte meter.**  
> **Platform absorbs:** fee-collection traffic, vault/solver legs not listed below, and EVM solver gas.

| Flow | User-charged bytes (quoted) | Typical quoted fee (+10% buffer) | Fee collected on (atomic) |
|------|----------------------------|----------------------------------|---------------------------|
| **C2C** CBTC↔CC | User offer + vault accept | **~6–7 CC** | Vault fill submit (accept + deliver + fee CC) |
| **HTLC forward** (WBTC→CBTC) | `HtlcLock.Claim` only | **~3.5–4 CC** | Claim submit (claim + fee CC) |
| **HTLC reverse** (CBTC→WBTC) | User `allocate` + `Create HtlcLock` | **~5–6 CC** | Create submit (create + fee CC) |

**Absorbed by platform (shown in ops logs, not in user quote):**

| Flow | Platform-absorbed Canton legs |
|------|------------------------------|
| C2C | Vault deliver counter; fee CC transfer bytes |
| HTLC forward | Vault allocate + create HtlcLock; solver EVM WBTC claim; fee CC transfer bytes |
| HTLC reverse | Solver `HtlcLock.Claim`; fee CC transfer bytes |

Implementation: `lib/canton-network-fee.ts` → `priceUserChargedTrafficBytes()`.

---

## 3. How bytes → CC

1. **Measure:** `POST /v2/interactive-submission/prepare` → `costEstimation.totalTrafficCostEstimation` (bytes per command).
2. **Price:** `bytes / 1_000_000 × extraTrafficPriceUsdPerMb / amuletPriceUsd` (read live from Scan).
3. **Buffer:** `× (1 + NETWORK_FEE_BUFFER_BPS / 10_000)` — default **+10%**.
4. **Min balance:** `networkFeeCc + NETWORK_FEE_RESERVE_CC` (default **+5 CC** reserve).

Devnet list price (June 2026 probe): **~$60/MB**, **~$0.156/CC**. Devnet often burns **$0** traffic (WarpX subsidy); use list price for mainnet planning.

WarpX cannot prepare multi-command batches — C2C and HTLC reverse sum **per-command** prepares.

---

## 4. End-to-end transaction breakdowns (devnet prepare)

Amount does **not** materially change bytes. Values below are live devnet prepares (managed party `party-de08bc18-…`, vault `oranj-settle-devnet::1220…`).

### 4.1 C2C — CBTC→CC (~$100 reference)

**Chronology:** (1) user offer → vault, (2) vault atomic fill (accept + deliver + optional fee CC).

| # | Submit | actAs | Bytes | In user quote? | ~List CC |
|---|--------|-------|-------|----------------|----------|
| 1 | User sell offer | `[user]` | 8,834 | **Yes** | ~3.4 |
| 2 | Vault accept user offer | `[user, vault]` | 5,578 | **Yes** | ~2.1 |
| 2b | Vault deliver CC (direct) | `[user, vault]` | 8,135 | No (platform) | ~3.1 |
| — | Fee CC → node party | `[user]` | ~8,000 | No (platform) | ~3.1 |
| **User quote total** | | | **14,412** (fallback sum) | | **~6–7 CC** |

CC→CBTC: offer **8,285** + accept **8,090** = **16,375** bytes → **~6–7 CC** quoted.

### 4.2 HTLC forward — WBTC→CBTC (0.0001 WBTC example)

| Phase | Tx | Bytes | In user quote? | ~List CC |
|-------|-----|-------|----------------|----------|
| EVM | User WBTC approve + lock | n/a | n/a (ETH gas) | — |
| Canton | Vault allocate CBTC | 8,545 | No | ~3.3 |
| Canton | Vault create HtlcLock | ~3,500 | No | ~1.4 |
| Canton | **User claim CBTC** | **~8,545** | **Yes** | **~3.3** |
| Canton | Fee CC → node | ~7,900 | No | ~3.0 |
| EVM | Solver WBTC claim | n/a | No (platform) | — |
| **User quote** | | **~8,545** | | **~3.5–4 CC** |

Platform fee on 0.0001 WBTC: gross ~0.00009983 CBTC → 1% ≈ **0.000001 CBTC** deducted from receive.

### 4.3 HTLC reverse — CBTC→WBTC

| Phase | Tx | Bytes | In user quote? | ~List CC |
|-------|-----|-------|----------------|----------|
| Canton | **User allocate CBTC** | **~8,910** | **Yes** | ~3.4 |
| Canton | **User create HtlcLock** | **~3,010** | **Yes** | ~1.1 |
| Canton | Fee CC → node | ~7,900 | No | ~3.0 |
| EVM | Solver WBTC lock | n/a | No | — |
| EVM | User WBTC claim (reveal) | n/a | User (ETH) | — |
| Canton | Solver claim CBTC | ~8,400 | No | ~3.2 |
| **User quote** | | **~11,920** | | **~5–6 CC** |

---

## 5. Platform P&L

```
Platform net ≈ platform_fee_usd
             + buffer_surplus_on_user_network_fee
             − absorbed_canton_list_usd
             − evm_solver_ops_usd
```

User network fee CC is **pass-through** to `NETWORK_FEE_RECEIVER_PARTY` (node traffic). It is not platform revenue. The **10% quote buffer** surplus (after traffic is paid) plus **1% platform fee** fund absorbed vault/solver legs.

### ~$100 notional (planning, list price, network fee ON)

| Flow | Platform spread | User network fee (quoted) | Total Canton list (all legs) | Platform keeps (approx) |
|------|-----------------|---------------------------|------------------------------|-------------------------|
| C2C CBTC→CC | $1.00 | ~$1.00 (6–7 CC) | ~$1.35 | **~$0.65+** (fee pass-through + spread − absorbed deliver/fee cmd) |
| C2C CC→CBTC | $1.00 | ~$1.05 | ~$1.47 | **~$0.58+** |
| HTLC forward | $1.00 | ~$0.55 (3.5–4 CC) | ~$1.19 | **~$0.36+** (spread − absorbed solver legs) |
| HTLC reverse | $1.00 | ~$0.75 (5–6 CC) | ~$1.22 | **~$0.53+** |

At **~$6 notional**, 1% spread ≈ $0.06 — platform subsidizes traffic unless network fee is ON. **Min notional ~$100** (future policy) makes spread cover absorbed HTLC solver legs.

---

## 6. User journey (Review modal)

```
You pay           <amount> <asset>
Platform fee      1% (~X in receive asset)
Network fee       ~Y CC
You receive       <out>
```

- Platform fee = deducted from receive amount (spread).
- Network fee = separate CC charge on user-charged Canton submit(s).
- EVM gas row when cross-chain (MetaMask; not Canton CC).

Prepaid gate: user CC ≥ `networkFeeCc + NETWORK_FEE_RESERVE_CC` or swap blocked with top-up message.

---

## 7. Environment variables

| Variable | Purpose |
|----------|---------|
| `NETWORK_FEE_ENABLED=1` | Collect CC on charged submit |
| `NEXT_PUBLIC_NETWORK_FEE_ENABLED=1` | Show fee in UI |
| `NETWORK_FEE_QUOTE_PREVIEW=1` | Show quotes without collecting (dev) |
| `NETWORK_FEE_RECEIVER_PARTY` | Node party for fee CC (`warpx-*`) |
| `CANTON_SWAP_SETTLEMENT_PARTY` | Vault for swap float (`oranj-settle-*`) |
| `NETWORK_FEE_BUFFER_BPS` | Quote buffer (default 1000 = +10%) |
| `NETWORK_FEE_RESERVE_CC` | Min CC reserve beyond fee (default 5) |
| `PLATFORM_FEE_BPS` | Output spread (default 100 = 1%) |

---

## 8. Ops enable checklist

### Phase 0 — probe (before mainnet)

```bash
bash scripts/with-env.sh devnet npx tsx scripts/probe-network-fee.mts
bash scripts/with-env.sh devnet npx tsx scripts/audit-network-fee.mts
bash scripts/with-env.sh devnet npx tsx scripts/audit-htlc-bytes-once.mts 0.0001 0.00009887
bash scripts/with-env.sh devnet npx tsx scripts/audit-c2c-bytes-once.mts
bash scripts/with-env.sh devnet npx tsx scripts/test-c2c-network-fee-estimate.mts
```

Verify:

| Check | Pass |
|-------|------|
| Prepare returns `totalTrafficCostEstimation` > 0 | ✓ |
| Scan `extraTrafficPriceUsdPerMb` + `amuletPriceUsd` parse | ✓ |
| `NETWORK_FEE_RECEIVER_PARTY` has CC TransferPreapproval | ✓ |
| Vault funded on `CANTON_SWAP_SETTLEMENT_PARTY` | ✓ |
| Devnet E2C: C2C + HTLC quotes match §2 targets | ✓ |

### Track A — validator auto-top-up

Enable `TARGET_TRAFFIC_THROUGHPUT` with Five North / WarpX so paid traffic is purchased when the free bucket empties. Without this, swaps may fail with `SEQUENCER_REQUEST_FAILED` under load even when users pay app-layer fees.

### Track B — app enable

1. Set env (§7) on web + HTLC solver (`CANTON_SWAP_SETTLEMENT_PARTY` on solver too).
2. Apply Supabase migration `023_network_fee.sql` (+ later fee ledger migrations).
3. Devnet E2E: C2C settle + HTLC forward/reverse — Review shows network fee → CC collected atomically.
4. Staging → mainnet with `ALLOW_MAINNET=true` on solver.

### Reconciliation (no per-swap actual API)

Compare over N swaps:

- Lighthouse validator `total_consumed` delta (mainnet only; devnet not indexed)
- Sum of `network_fee_ledger.fee_cc` (treasury inflow)

Occasional spot-check: participant DEBUG logs grep `EventCost` + submission trace-id.

---

## 9. Audit scripts

```bash
# HTLC forward byte + fee audit
bash scripts/with-env.sh devnet npx tsx scripts/audit-htlc-bytes-once.mts [wbtcIn] [cbtcOut]

# HTLC post-swap (order id)
bash scripts/with-env.sh devnet npx tsx scripts/audit-htlc-swap-fees.mts <orderId>

# C2C per-leg bytes
AUDIT_USER_CANTON_PARTY='party-…' bash scripts/with-env.sh devnet npx tsx scripts/audit-c2c-bytes-once.mts

# Scan + pricing smoke
bash scripts/with-env.sh devnet npx tsx scripts/probe-network-fee.mts
```

Log prefixes: `[network-fee]` (user quotes), `[solver-node-traffic]` (vault counter-lock ops), `[htlc-onledger]` (on-ledger submits).

---

## 10. Design notes (Canton traffic)

- Traffic is metered **per validator node**, not per party. All hosted parties share one bucket.
- CC burns: **TransferPreapproval** setup + **traffic top-up** (`BuyTrafficRequest`). Swap legs themselves burn zero CC (CIP-0078); cost is traffic bytes.
- User pays CC → `NETWORK_FEE_RECEIVER_PARTY`; operator separately funds node traffic top-up. The two are not linked on-ledger.
- Prepare estimate ≠ settled bytes (topology can shift). Use aggregates for reconciliation.
- Fee collection is **atomic** with the swap leg (same submit) — no fee-charged-but-swap-failed window.

---

## 11. Caveats

1. **HTLC forward quotes lower than C2C** — one user Canton submit vs two; structural, not a bug.
2. **Loop wallet** — different paths; not covered.
3. **Sepolia EVM gas** — negligible; re-measure on mainnet Base.
4. **Devnet traffic** often $0 actual burn — list price used for planning.
5. **CanActAs custody** — backend signs for email users; traffic still bills the participant node.

---

## 12. Related

- [SWAP-RUNBOOK.md](SWAP-RUNBOOK.md) — daemons, env, deploy
- `lib/canton-network-fee.ts` — quote + collection implementation
- `components/FeeBreakdown.tsx` — Review modal display
