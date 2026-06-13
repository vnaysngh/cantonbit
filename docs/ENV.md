# Environment files

OranjSwap runs two independent stacks locally: **devnet** and **mainnet**. Each stack has its own env file — you do **not** edit one file and flip `NEXT_PUBLIC_NETWORK` by hand.

## File map

| File | Purpose | Committed? |
|------|---------|------------|
| `.env.devnet.example` | Template for devnet web app | Yes |
| `.env.mainnet.example` | Template for mainnet web app | Yes |
| **`.env.devnet`** | Your devnet web secrets + addresses | No (gitignored) |
| **`.env.mainnet`** | Your mainnet web secrets + addresses | No |
| **`.env.local`** | Optional **overrides only** (same machine, both stacks) | No |
| `swap-solver/.env` | Legacy OIF solver (Canton/RPC keys for api/watch) | No |
| `swap-solver/.env.htlc-devnet` | HTLC daemon — devnet | No |
| `swap-solver/.env.htlc-mainnet` | HTLC daemon — mainnet | No |
| `swap-solver/.env.htlc-*.example` | Templates | Yes |

### What is `.env.local`?

Next.js loads `.env.local` automatically. We still support it, but **network-specific values belong in `.env.devnet` or `.env.mainnet`**, not in `.env.local`.

Use `.env.local` only for things that are the same regardless of stack, or personal machine overrides (e.g. `ALLOW_TOKEN_LEAK=true`, a custom `NEXT_PUBLIC_PARTY_ID` for scripts).

If a key exists in both `.env.devnet` and `.env.local`, **`.env.development.local` wins** when you use `npm run dev:*` (we mirror the network file there on each start).

**Important:** remove `CRON_SECRET`, `HTLC_DAEMON_SECRET`, and `NEXT_PUBLIC_NETWORK` from `.env.local` if you still have them — they cause intermittent **401** on daemon routes when Next workers read the wrong secret.

The HTLC daemon (tsx) loads in order — **later files win**:

```
../.env.local → ../.env.devnet → .env.htlc-devnet     (devnet)
../.env.local → ../.env.mainnet → .env.htlc-mainnet   (mainnet)
```

So `NEXT_PUBLIC_NETWORK` comes from `.env.devnet` / `.env.mainnet`, not stale values in `.env.local`.

## Commands

```bash
# First-time setup (copy examples → gitignored env files; skip if already present)
cp .env.devnet.example .env.devnet
cp .env.mainnet.example .env.mainnet
cp swap-solver/.env.htlc-devnet.example swap-solver/.env.htlc-devnet
cp swap-solver/.env.htlc-mainnet.example swap-solver/.env.htlc-mainnet

# Web app
npm run dev:devnet      # WarpX devnet + Base Sepolia
npm run dev:mainnet     # WarpX mainnet + Base (real funds)

npm run build:devnet
npm run build:mainnet

# HTLC solver daemon (pair with matching web stack)
npm run solver:htlc           # devnet
npm run solver:htlc:mainnet   # mainnet
```

Default `npm run dev` → **devnet** (unchanged safe default).

## Typical local session

**Devnet swap test**

```bash
# Terminal 1
npm run dev:devnet

# Terminal 2
npm run solver:htlc
```

**Mainnet smoke test**

```bash
# Terminal 1
npm run dev:mainnet

# Terminal 2
npm run solver:htlc:mainnet
```

No file editing between sessions — pick the script for the stack you want.

## What each stack file must contain

### `.env.devnet` / `.env.mainnet` (web)

Master switches, Supabase, Keycloak, HTLC addresses, solver party IDs, `CBTC_HTLC_PKG_ID`, daemon secrets. See the matching `.example` file.

### `swap-solver/.env.htlc-devnet` / `.env.htlc-mainnet`

Solver-only: `SWAP_NETWORK`, `EVM_CHAIN`, `ORIGIN_RPC_URL`, `HTLC_ESCROW_ADDRESS`, `SOLVER_EVM_PK`, `API_BASE`, `HTLC_DAEMON_SECRET`. Mainnet also needs `ALLOW_MAINNET=true`.

The daemon loads **`.env.local` → web stack → htlc stack** (tsx: later files win):

```
../.env.local → ../.env.devnet → .env.htlc-devnet     (devnet)
../.env.local → ../.env.mainnet → .env.htlc-mainnet   (mainnet)
```

## Production (Railway)

Railway does not use these files. Paste the same variables from `.env.devnet.example` or `.env.mainnet.example` into the service Variables UI. Build web with the correct `NEXT_PUBLIC_*` set before `npm run build`.

## Migration from old workflow

If you previously used a single `.env.local` for everything, copy it to `.env.devnet`
(when `NEXT_PUBLIC_NETWORK=devnet`), fill `.env.mainnet` from `.env.mainnet.example`, then
trim `.env.local` to overrides only (or delete network keys from it so they do not surprise you).
