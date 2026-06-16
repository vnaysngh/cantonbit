# CBTC Swap Farming (mainnet-only, standalone)

Drive **real CC↔CBTC swap volume** on Canton mainnet for BitSafe reward share. This is a **standalone CLI toolkit** — no Next.js deploy, no Supabase, no HTTP farm API.

Every swap moves **CBTC on-ledger** (~50/50 direction randomization):

- **CBTC→CC:** farm trader sends CBTC → settlement vault sends CC  
- **CC→CBTC:** farm trader sends CC → settlement vault sends CBTC  

## Architecture

```
scripts/farm/cli.mts          ← entry (provision | quote | swap | run | status | audit)
scripts/farm/lib/             ← script-safe quote, 2-tx settle, pacing
.farm-fleet.mainnet.json      ← fleet party ids (gitignored)
farm-swap.log                 ← optional JSONL audit log (gitignored)
```

**Two ledger transactions per swap** (same as production managed C2C):

1. **Tx1** — `actAs: [trader]` → user-leg **offer** to settlement vault  
2. **Tx2** — `actAs: [vault]` → **accept offer + deliver counter** (atomic)

Settlement vault must stay **preapproval-free**. Farm traders need **CC + CBTC preapproval** enabled.

Env: `.env.mainnet` via `scripts/with-env.sh mainnet` (Keycloak m2m, treasury, vault party).

**Party roles (do not merge for “rewards”):**

| Party | Role | Preapproval |
|-------|------|-------------|
| `warpx-mainnet-1` | Treasury + validator operator | CC/CBTC on (normal ops) |
| `oranj-settle-mainnet` | Settlement vault | **OFF** (required for offer-path C2C) |
| `oranj-user-*` | Farm traders | CC + CBTC **ON** |

All three sit on the **same WarpX participant**. Changing settlement to `warpx-mainnet-1` does not increase validator rewards; it breaks atomic swap semantics.

---

## CC economics (validator vs farm)

This section is about **Canton Coin validator income** on `warpx-mainnet-1`. It is **separate** from **BitSafe CBTC farming share** (the reason we run this bot).

### How validator rewards work

Canton mints CC in **10-minute rounds**. Activity creates **coupons** in round *N*; validator automation **mints** them into the operator wallet in round *N+1* (Splice wallet shows **“Validator Rewards” from Automation**).

Two validator-side coupon types:

| Coupon | Created when | Paid to |
|--------|--------------|---------|
| **`ValidatorRewardCoupon`** | CC is **burned**, or an **`AmuletRules_Transfer`** runs | Validator operator hosting the acting party |
| **`ValidatorLivenessActivityRecord`** | Validator is live that round | Same (uptime faucet, capped ~$2.85 USD eq. / validator / round) |

Docs: [Canton Coin Tokenomics](https://docs.canton.network/overview/reference/canton-coin-tokenomics), [Tokenomics of the GS](https://docs.canton.network/overview/reference/tokenomics-of-gs), [Preapprovals](https://docs.canton.network/appdev/modules/m7-canton-coin-preapprovals).

Minting is **not 1:1 with spend**. Burning ~7.4 CC on five EnableCC preapprovals can mint back ~0.5 CC in the next round — proportional to global activity that round, not a rebate.

### What burns CC vs what only moves CC

| Action | CC effect | Validator coupon? |
|--------|-----------|-------------------|
| **EnableCC preapproval** (× per trader) | **Burns** ~1.5 CC/party/90d (provider = `warpx-mainnet-1`) | **Yes** — strong signal |
| **Traffic purchase** (auto top-up) | **Burns** CC for bytes | **Yes** |
| **CC transfer** (fund vault/traders) | Moves CC; no fee post–CIP-0078 | Weak / nominal via `AmuletRules_Transfer` only |
| **CBTC swap legs** | Token Standard offers; not Amulet burns | **No** app/validator activity from swap volume itself |
| **Farm swap traffic** | Consumes **traffic bytes** (may trigger CC burn if bucket topped up) | Indirect — only if traffic purchase burns CC |

**Practical takeaway:** Provisioning preapprovals is the big one-time validator-reward driver you saw (+0.59 CC after ~−1.48 CC × 5). **Routine farm swaps do not burn CC per swap** — they consume **traffic**. Validator coupons from farming come mainly from **traffic top-up burns**, not from moving CBTC/CC between parties.

**App rewards** (separate bucket): if `warpx-mainnet-1` is the preapproval **provider**, inbound 1-step CC to traders can earn **`AppRewardCoupon`** — not the same line as “Validator Rewards”.

### What this means for farm ops

- **Do not** point `CANTON_SWAP_SETTLEMENT_PARTY` at `warpx-mainnet-1` for CC rewards.
- **Do** monitor Lighthouse traffic (`/api/validators/<warpx-party>`) — pacing is traffic-based, not CC-burn-based.
- **BitSafe reward share** = on-ledger **CBTC swap volume**, not CC validator minting.

---

## Prerequisites

1. **Mainnet config** — `CANTON_SWAP_SETTLEMENT_PARTY`, `NEXT_PUBLIC_SOLVER_CANTON`, Keycloak mainnet creds  
2. **BitSafe gate** — written confirmation that bot-driven swap volume counts; then set `BITSAFE_FARMING_ELIGIBLE=1` or pass `--bitsafe-eligible-confirmed` for continuous run  
3. **Tradecraft** — quotes from `api.tradecraft.fi` (same as production swaps)

Validate config:

```bash
npm run farm:audit:mainnet
```

---

## 1. Provision fleet (one-time)

Allocates 5 hosted parties (`oranj-user-<uuid>` hints), grants m2m `CanActAs`, funds each from **`warpx-mainnet-1` (treasury)**, then enables CC+CBTC preapproval.

Default: **120 CC + 0.0003 CBTC per trader** from treasury (600 CC + 0.0015 CBTC total at 5 parties). Vault is **not** funded during provision; use `fund-swap-vault:mainnet` separately.

```bash
npm run farm:provision:mainnet -- --i-understand-mainnet
```

Flags:

| Flag | Default | Meaning |
|------|---------|---------|
| `--traders` | 5 | Number of farm trader parties |
| `--cc` | 120 | CC **per trader** from treasury |
| `--cbtc` | 0.0003 | CBTC **per trader** from treasury |
| `--fund-vault` | off | Also fund settlement vault from treasury |
| `--vault-cc` | 0 | CC to vault when `--fund-vault` |
| `--vault-cbtc` | 0 | CBTC to vault when `--fund-vault` |
| `--skip-fund` | off | Allocate only, no transfers |
| `--skip-preapproval` | off | Skip EnableCC / CBTC preapproval |

Writes **`.farm-fleet.mainnet.json`** (gitignored).

Verify:

```bash
npm run farm:status:mainnet
```

---

## 2. Smoke test (single swap)

Before scaling to full fleet size:

```bash
npm run farm:swap:mainnet -- \
  --i-understand-mainnet \
  --trader=0 \
  --from=CBTC \
  --to=CC \
  --in=0.000847
```

Quote only:

```bash
npm run farm:quote:mainnet -- --from=CBTC --to=CC --amount=0.001
```

---

## 3. Run farm bot

```bash
# Dry-run — log picks + sleep intervals, no ledger writes
npm run farm:run:mainnet -- \
  --i-understand-mainnet \
  --bitsafe-eligible-confirmed \
  --dry-run \
  --max-swaps=5

# Measure bytes (5 real swaps), then continuous
npm run farm:run:mainnet -- \
  --i-understand-mainnet \
  --bitsafe-eligible-confirmed \
  --max-swaps=0
```

Requires **`--i-understand-mainnet`** and BitSafe gate (`BITSAFE_FARMING_ELIGIBLE=1` or **`--bitsafe-eligible-confirmed`**).

---

## Swap frequency & pacing

Cadence targets **~92% of free traffic bucket refill** (default `--target-utilization=0.92`), not 100%.

| Parameter | Default |
|-----------|---------|
| Free bucket refill | ~333 B/s |
| Bytes per swap | **24,500** (ledger-measured on mainnet; override with `--bytes-per-swap`) |
| Mean interval | ~**80s** @ 24.5 KB and 92% util |
| Min sleep | 20s (after subtracting swap execution time) |

**Formula:**

```
mean_interval_s = bytes_per_swap / (333 × target_utilization)
sleep = max(min_interval, mean_interval - swap_duration)
```

**Why ~10 min for 5 swaps before:** almost all wall time was **intentional sleep** (~106s × 5) from the old 30 KB / 85% defaults plus jitter — not random delays in swap code. Ledger submits are ~10–20s each.

**Measured mainnet sizes (2 txs/swap):**

| Direction | ~Bytes/swap |
|-----------|-------------|
| CBTC→CC | ~27 KB |
| CC→CBTC | ~20 KB |
| Average | **~24.5 KB** |

Lighthouse `total_consumed` is currently **0** on warpx — bot falls back to ledger estimate and saves it to `.farm-fleet.mainnet.json` after a run.

Pacing flags: `--target-utilization`, `--bytes-per-swap`, `--calibrate-every`, `--min-interval`, `--max-interval`, `--cbtc-in`, `--cc-in`.

Default swap inputs: **0.00001 CBTC** (CBTC→CC) and **10 CC** (CC→CBTC). Override with `--cbtc-in=` / `--cc-in=`.

### Float drift (why plan fails after many swaps)

If the two legs are **not notionally matched** (CC in vs CC out per cycle), traders or vault slowly drain one asset. Smaller sizes extend runway but do not remove drift if inputs are asymmetric.

**Symptoms:** `✗ plan failed: no viable swap` with `traders=0 … CC need 10+10` or `vault=low CBTC`.

**Fix now:** fund from treasury; tune `--cbtc-in` / `--cc-in` to match Tradecraft quotes if drift appears.

```bash
npm run fund-swap-vault:mainnet -- --cbtc=0.05 --cc=500
# Re-fund traders if CC depleted (provision --skip-preapproval or manual CC transfer)
npm run farm:status:mainnet
```

---

## Swap planner (balance-aware)

The bot no longer picks random trader + direction. Each tick:

1. Loads **trader + vault balances**
2. Quotes vault deliverable for both directions
3. **Alternates direction** — no two consecutive swaps in the same direction (CBTC→CC then CC→CBTC)
4. **Same trader cannot repeat the same direction** back-to-back
5. Picks among viable candidates by **rebalance score** (move toward ~120 CC / ~0.0003 CBTC per trader)
6. Skips parties below reserve (`+0.00005 CBTC` / `+10 CC` above swap size) or UTXO cap

---

## CC burn audit

Farm swaps (Token Standard offers) should **not** burn CC post–CIP-0078. CC burns come from **preapproval setup** and **traffic top-ups**, not swap volume.

After each swap the bot scans offer+fill update trees for fee/burn choices (`TransferPreapproval`, `AmuletRules` burn, etc.) and logs `ccBurnSuspected` to `farm-swap.log`.

Retro-audit all logged swaps:

```bash
npm run farm:audit-burns:mainnet
```

---

## Monitoring

```bash
npm run farm:status:mainnet
npm run party-balances:mainnet -- <party-id>
```

- Lighthouse traffic drawdown  
- Trader/vault balances (50/50 direction should not drain one side)  
- UTXO counts — warn at 8, cap at 10 per party  
- `farm-swap.log` — one JSON line per swap  

Each **swap** line includes:

| Field | Meaning |
|-------|---------|
| `swapDurationSec` | Ledger time (offer + fill) |
| `sleepAfterSec` | Planned wait before next swap |
| `wallIntervalSec` | Actual seconds since previous swap log (sleep + plan + swap) |

Every **5 swaps** (or at run end), a **`run_summary`** line is appended with totals and averages.

Example `run_summary`:

```json
{"type":"run_summary","runId":"…","swapCount":5,"totalWallSec":397.1,"avgSwapDurationSec":48.4,"avgSleepAfterSec":36,"avgWallIntervalSec":99.3}
```

Top up float from treasury (`fund-swap-vault:mainnet`) if a trader or vault runs low.

---

## In-process API (for scripts)

```typescript
executeSwap({
  jwt,
  fleet,
  traderParty,
  fromAsset: "CBTC" | "CC",
  toAsset: "CBTC" | "CC",
  inAmount: string,
  outAmount?: string,  // omit → Tradecraft quote
  swapId?: string,
})
```

Implemented in `scripts/farm/lib/execute-swap.ts`.

---

## What this is NOT

- DevNet farming commands  
- Web app / `/api/farm/*` routes  
- Supabase order rows  
- Ping-pong transfers  
- Loop wallet mode (managed m2m only)

---

## Implementation checklist

- [x] `npm run farm:audit:mainnet` passes  
- [x] BitSafe written eligibility OK  
- [x] `farm:provision:mainnet` + vault funded (`fund-swap-vault:mainnet`)  
- [x] `farm:status:mainnet` healthy  
- [x] Smoke swaps both directions (`CBTC→CC`, `CC→CBTC`)  
- [ ] `farm:run:mainnet --dry-run --max-swaps=5` — verify picks + pacing  
- [ ] `farm:run:mainnet --max-swaps=5` — measure Lighthouse bytes/swap  
- [ ] `farm:run:mainnet --max-swaps=0` — continuous (tmux/screen; monitor balances)  
