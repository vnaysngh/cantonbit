# Branch diff: `c2c-swaps` vs `cbtc-farming`

Recorded when consolidating farm docs and preparing web C2C mainnet launch on **`c2c-swaps`**.

## Relationship

```
cbtc-farming = c2c-swaps + scripts/farm/** + Dockerfile.farm + farm npm scripts
```

Canton swap libs (`lib/canton-swap-*`) and API routes (`app/api/canton/swap/**`) are **identical** between branches. No settle/API porting required.

## Non-farm files on `cbtc-farming` (not on `c2c-swaps` before this pass)

| File | Action on `c2c-swaps` |
|------|------------------------|
| `docs/FARM-OPERATIONS-HANDBOOK.md` | Added (new) |
| `docs/CBTC-FARMING.md` | Updated + handbook links |
| `docs/FARM-RAILWAY.md` | Added/updated |
| `docs/C2C-MAINNET-LAUNCH.md` | Added (new) |
| `.env.farm.railway.example` | Copied (farm Railway reference only) |
| `AGENTS.md` | Farm + C2C doc pointers |
| `.gitignore` | `.farm-fleet.mainnet.json`, `farm-swap.log` |
| `scripts/with-env.sh` | Repo-local `node_modules/.bin/dotenv` |
| `scripts/fund-swap-vault.mts` | Mainnet party-balances + minor TS fix in `extractTransferFromCreate` |
| `package.json` | `party-balances:mainnet`, `fund-swap-vault:mainnet` only |
| `tsconfig.json` | Exclude `scripts` from Next.js typecheck (CLI run via tsx) |

## Intentionally **not** ported to `c2c-swaps`

| Item | Reason |
|------|--------|
| `scripts/farm/**` | Farm deploys from `cbtc-farming` branch only |
| `Dockerfile.farm` | Railway `cbtc-farming` service |
| `farm:*:mainnet` npm scripts | Optional; not needed for web/API |
| `FARM_FLEET_JSON_B64`, fleet JSON | Production secrets on farm Railway volume |
| `package-lock.json` delta | Farm branch lock sync; run `npm install` if needed locally |

## Cherry-pick commands (reference)

If re-applying from `cbtc-farming`:

```bash
git checkout c2c-swaps
git show cbtc-farming:.gitignore          # farm gitignore lines
git show cbtc-farming:scripts/with-env.sh
git show cbtc-farming:scripts/fund-swap-vault.mts
# package.json: only party-balances:mainnet + fund-swap-vault:mainnet
```

## Verify after merge

```bash
npm run build:mainnet
npm run party-balances:mainnet -- oranj-settle-mainnet::1220517bfd86ef5732610705a35b7b2d56e36112550d6a2b778971dbd099a3d36e99
```

See [`C2C-MAINNET-LAUNCH.md`](C2C-MAINNET-LAUNCH.md) for API smoke and Railway deploy.
