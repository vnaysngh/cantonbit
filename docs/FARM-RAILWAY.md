# CBTC Farm — Railway deployment

Standalone **worker service** (not the Next.js app). Runs `scripts/farm/railway-start.mts` continuously on mainnet.

Use a **separate git branch** and **separate Railway service** from `oranjswap-web-mainnet`.

---

## 1. Create Railway service

| Setting | Value |
|---------|-------|
| **Root directory** | `/` (repo root) |
| **Builder** | **Dockerfile** (not Nixpacks/Railpack default) |
| **Dockerfile path** | `Dockerfile.farm` |
| **Start command** | *(from Dockerfile — do not override)* |

If deploy logs show `npm ci` / `EUSAGE` / `picomatch`, the service is using an old cached build layer or wrong Dockerfile. Confirm **Dockerfile path** = `Dockerfile.farm`, then **Redeploy → Clear build cache**. The farm Dockerfile uses `npm install` (not `npm ci`) and copies `.npmrc`.

### Volume (recommended)

Mount **1 GB** volume at `/data`:

- Persists `.farm-fleet.mainnet.json` (calibration updates)
- Persists `farm-swap.log` across restarts

Set variable: `FARM_DATA_DIR=/data`

Without a volume, fleet + log reset on each deploy (bot still runs; calibration re-seeded from env).

---

## 2. Required environment variables

Copy from [`.env.farm.railway.example`](../.env.farm.railway.example). Minimum:

| Variable | Purpose |
|----------|---------|
| `NEXT_PUBLIC_NETWORK` | `mainnet` |
| `KEYCLOAK_*` | WarpX m2m JWT |
| `CANTON_SWAP_SETTLEMENT_PARTY` | `oranj-settle-mainnet::…` |
| `SOLVER_CANTON_PARTY` or `NEXT_PUBLIC_SOLVER_CANTON` | Treasury `warpx-mainnet-1::…` |
| `BITSAFE_FARMING_ELIGIBLE` | `1` |
| `FARM_FLEET_JSON` or `FARM_FLEET_JSON_B64` | Trader + vault party ids |
| `FARM_DATA_DIR` | `/data` if using volume |

Optional: `CC_REGISTRY_URL`, `PLATFORM_FEE_BPS`, `TRADECRAFT_API_URL`

**Do not** need Supabase, EVM keys, or `CRON_SECRET` for farming.

---

## 3. Fleet JSON on Railway

Fleet file is gitignored. Export from your machine:

```bash
# Minified JSON (paste into FARM_FLEET_JSON in Railway)
cat .farm-fleet.mainnet.json | jq -c .

# Or base64 (paste into FARM_FLEET_JSON_B64)
base64 < .farm-fleet.mainnet.json | tr -d '\n'
```

On first boot the worker writes `/data/.farm-fleet.mainnet.json` and updates calibration there.

---

## 4. Deploy

1. Push farm branch to GitHub
2. Connect branch to Railway service
3. Set variables + volume
4. Deploy

Logs: Railway **Deployments → Logs**. Each swap prints:

```
✓ swap N: CBTC→CC … swap=41s sleep=43s
```

Every 5 swaps a `run_summary` line is appended to `/data/farm-swap.log` (and stdout via file tail if you add one).

---

## 5. Local continuous run (no Railway)

```bash
npm run farm:run:mainnet -- \
  --i-understand-mainnet \
  --bitsafe-eligible-confirmed \
  --max-swaps=0
```

Use `tmux` / `screen` so SSH disconnect does not kill the bot.

---

## 6. Monitoring

| What | How |
|------|-----|
| **Live logs** | Railway dashboard, or `railway logs -f` |
| **Swap audit file** | Download `/data/farm-swap.log` from volume, or tail locally |
| **Balances** | `npm run farm:status:mainnet` (local with `.env.mainnet`) |
| **CC burns** | `npm run farm:audit-burns:mainnet` |
| **Traffic** | [Lighthouse warpx validator](https://lighthouse.cantonloop.com/api/validators/warpx-mainnet-1%3A%3A1220517bfd86ef5732610705a35b7b2d56e36112550d6a2b778971dbd099a3d36e99) |

### What to watch

- `✗ swap failed` / `✗ plan failed` — usually float or transient network; bot retries
- `trader insufficient` / `vault insufficient` — fund from treasury (`fund-swap-vault:mainnet`)
- `UTXO at cap` — merge holdings or pause trader
- `traffic rejection` — bot backs off automatically

### Expected throughput

~**430–500 s per 5 swaps** (~90 s between completions) → roughly **~170–190 swaps/day** at current pacing.

---

## 7. Stopping

- **Railway:** scale replicas to 0 or pause service
- **Local:** `Ctrl+C` in tmux session

---

## 8. Merging back to C2C branch

Reusable pieces for mainnet C2C:

- `scripts/farm/lib/settle.ts` — 2-tx managed swap
- `scripts/farm/lib/planner.ts` — balance-aware direction pick
- `lib/canton-swap-*` patterns (offer path, vault fill)

Farm-specific: pacing, fleet JSON, Railway worker — stay on farm branch or extract later.
