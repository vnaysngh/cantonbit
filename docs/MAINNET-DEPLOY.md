# Mainnet / Devnet deployment guide

How to run OranjSwap HTLC swaps on **WarpX devnet + Base Sepolia** vs **WarpX mainnet + Arbitrum**, either as **one stack at a time** (toggle) or **two stacks in parallel**.

Env templates (no secrets):

| File | Purpose |
|------|---------|
| [`.env.devnet.example`](../.env.devnet.example) | Web app — devnet |
| [`.env.mainnet.example`](../.env.mainnet.example) | Web app — mainnet |
| [`swap-solver/.env.htlc-devnet.example`](../swap-solver/.env.htlc-devnet.example) | HTLC solver daemon — devnet |
| [`swap-solver/.env.htlc-mainnet.example`](../swap-solver/.env.htlc-mainnet.example) | HTLC solver daemon — mainnet |

---

## Critical invariant

These must all match on a single stack:

- `NEXT_PUBLIC_NETWORK` / Loop wallet network (`devnet` vs `mainnet`)
- `NEXT_PUBLIC_SWAP_CHAIN` / solver `EVM_CHAIN` (`base-sepolia` vs `arbitrum`)
- Solver Canton party + CBTC float on that ledger
- `API_BASE` on the solver → the web app built for the **same** network

A devnet Loop user cannot swap against a mainnet solver (`UNKNOWN_INFORMEES`).

---

## Deployment topologies

### Option A — Toggle (one stack)

Single Railway project or local `.env.local`. Change env, **rebuild web**, restart solver.

1. Set all vars for target network (see matrix below)
2. Redeploy **web** (`npm run build` — `NEXT_PUBLIC_*` baked in)
3. Update solver env + redeploy/restart
4. Smoke-test one small swap

### Option B — Parallel (recommended for mainnet rollout)

Four Railway services (or two Environments × web + solver):

| Service | Example URL | `NEXT_PUBLIC_NETWORK` | EVM |
|---------|-------------|------------------------|-----|
| web-devnet | `dev.example.com` | `devnet` | Base Sepolia |
| solver-devnet | internal | — | Base Sepolia RPC |
| web-mainnet | `app.example.com` | `mainnet` | Arbitrum |
| solver-mainnet | internal | — | Arbitrum RPC |

- **Separate Supabase project** per network (recommended)
- **Separate solver EVM hot keys** and CBTC float
- Each solver `API_BASE` → its paired web URL
- `HTLC_DAEMON_SECRET` unique per stack if both are live

---

## Environment variable matrix

### Master switch (web build)

| Variable | Devnet | Mainnet |
|----------|--------|---------|
| `NEXT_PUBLIC_NETWORK` | `devnet` | `mainnet` |
| `NEXT_PUBLIC_LOOP_NETWORK` | `devnet` | `mainnet` |
| `NEXT_PUBLIC_SWAP_CHAIN` | `base-sepolia` | `arbitrum` |

### Web — Canton + auth

| Variable | Devnet | Mainnet |
|----------|--------|---------|
| `KEYCLOAK_CLIENT_ID_DEVNET` | `validator-devnet-m2m` | unset |
| `KEYCLOAK_CLIENT_SECRET_DEVNET` | dev secret | unset |
| `KEYCLOAK_CLIENT_ID` | optional | `validator-mainnet-m2m` |
| `KEYCLOAK_CLIENT_SECRET` | — | mainnet secret |
| `CBTC_HTLC_PKG_ID` | dev package id | mainnet package id |

### Web — EVM / HTLC

| Variable | Devnet | Mainnet |
|----------|--------|---------|
| `NEXT_PUBLIC_HTLC_ESCROW` | `0x1b19a764…` (Sepolia) | Arbitrum deploy address |
| `NEXT_PUBLIC_WBTC_ADDRESS` | mock `0x8d587e55…` | `0x2f2a2543…` (Arbitrum WBTC) |
| `NEXT_PUBLIC_SOLVER_EVM` | dev solver address | mainnet solver address |
| `NEXT_PUBLIC_SOLVER_CANTON` | `warpx-devnet-1::…` | `warpx-mainnet-1::…` |
| `SOLVER_EVM` / `SOLVER_CANTON_PARTY` | same (server validation) | mainnet values |

### HTLC solver daemon

| Variable | Devnet | Mainnet |
|----------|--------|---------|
| `SWAP_NETWORK` | `devnet` | `mainnet` |
| `ALLOW_MAINNET` | unset | `true` |
| `EVM_CHAIN` | `base-sepolia` | `arbitrum` |
| `API_BASE` | dev web URL | mainnet web URL |
| `ORIGIN_RPC_URL` | `https://sepolia.base.org` | `https://arb1.arbitrum.io/rpc` |
| `HTLC_ESCROW_ADDRESS` | Sepolia escrow | Arbitrum escrow |
| `NEXT_PUBLIC_HTLC_ESCROW` | same (if service runs `npm run build`) | same |
| `SOLVER_EVM_PK` | dev hot key | **new** mainnet hot key |
| `HTLC_DAEMON_SECRET` | shared with web stack | unique if parallel |

---

## External prerequisites (mainnet)

Complete before pointing production env at mainnet:

### 1. Deploy HTLCEscrow on Arbitrum

```bash
cd contracts && forge build
cd ../swap-solver

# Copy and fill secrets (deployer needs Arbitrum ETH)
cp .env.htlc-mainnet.example .env.htlc-mainnet
cp ../.env.mainnet.example ../.env.mainnet
# Set PRIVATE_KEY or SOLVER_EVM_PK, ALLOW_MAINNET=true, ORIGIN_RPC_URL

npx tsx --env-file=.env --env-file=../.env.mainnet --env-file=.env.htlc-mainnet src/htlc-deploy.mts
```

Record output address → `HTLC_ESCROW_ADDRESS` and `NEXT_PUBLIC_HTLC_ESCROW`.

### 2. Upload cbtc-htlc DAR to mainnet WarpX participant

1. Build: `cd canton-htlc && daml build`
2. Upload `canton-htlc/.daml/dist/cbtc-htlc-hardened-*.dar` via Five North dashboard to **mainnet** participant
3. Record package id from upload → `CBTC_HTLC_PKG_ID` on web env

### 3. Fund solver

| Asset | Party / wallet | Notes |
|-------|----------------|-------|
| CBTC float | `warpx-mainnet-1::1220517b…` | On-ledger transfers + HtlcLock |
| ETH | Solver EVM hot key | Arbitrum gas for lock/claim |
| CC (Amulet) | Solver Canton party | Ledger write fees |

### 4. Supabase

- Create **mainnet** Supabase project (if parallel)
- Run all migrations through `010_htlc_orders_rls_lockdown.sql` in SQL Editor
- Set web env Supabase keys to mainnet project

### 5. Keycloak

- Mainnet web: `KEYCLOAK_CLIENT_ID=validator-mainnet-m2m` + mainnet secret
- Do **not** set `_DEVNET` vars on mainnet web service

---

## Local run

See **[docs/ENV.md](ENV.md)** for the full file map. Short version:

```bash
cp .env.devnet.example .env.devnet
cp .env.mainnet.example .env.mainnet
cp swap-solver/.env.htlc-devnet.example swap-solver/.env.htlc-devnet
cp swap-solver/.env.htlc-mainnet.example swap-solver/.env.htlc-mainnet

# Devnet
npm run dev:devnet
npm run solver:htlc

# Mainnet (real funds — after prerequisites below)
npm run dev:mainnet
npm run solver:htlc:mainnet
```

Fill secrets in `.env.devnet` / `.env.mainnet` and `swap-solver/.env.htlc-*`. Use `.env.local` only for optional overrides.

---

## Railway runbook

Configure everything in the **Railway dashboard** — there is no `railway.json` in this repo.

### Web app service (root directory `/`)

| Setting | Value |
|---------|-------|
| Build | `npm ci && npm run build:prod` |
| Start | `npm run start -- -p $PORT` |
| Healthcheck path (optional) | `/swap` |

Set **all** `NEXT_PUBLIC_*` vars in Railway **before** build (they are baked into the client).
Network is chosen by variables (`NEXT_PUBLIC_NETWORK=devnet` vs `mainnet`), not by
`npm run build:devnet`.

### HTLC solver service (root directory `swap-solver`)

| Setting | Value |
|---------|-------|
| Build | `npm ci` |
| Start | `npx tsx src/htlc-solver-daemon.mts` |

Do **not** point a solver service at repo root — it would pick up the Next.js app by mistake.

### Toggle procedure

1. Update web Railway Variables for target network
2. Redeploy web (rebuild)
3. Update solver variables (`ORIGIN_RPC_URL`, escrow, `API_BASE`, keys, `ALLOW_MAINNET`)
4. Redeploy/restart solver

### Parallel procedure

1. Duplicate web + solver services (or use Railway Environments)
2. Attach devnet env set to dev pair; mainnet env set to main pair
3. Separate Supabase per network; apply migration 010 on each
4. Point each solver `API_BASE` at its web URL
5. Deploy devnet first; validate; then mainnet

---

## Verification checklist

Per network after deploy:

- [ ] Web build succeeds with network-specific `NEXT_PUBLIC_*` at build time
- [ ] `/api/parties/balance` returns CBTC + CC for a Loop party on that network
- [ ] MetaMask prompts for correct chain (84532 Sepolia vs 42161 Arbitrum)
- [ ] HTLC swap: create → accept → lock → claim → daemon settles
- [ ] Supabase anon REST returns 401 on `htlc_orders`
- [ ] Loop wallet on matching network (`devnet.cantonloop.com` vs `cantonloop.com`)
- [ ] Mainnet: `ALLOW_MAINNET=true`; small-notional test swap completed

---

## Record sheet (fill after mainnet deploy)

| Item | Value |
|------|-------|
| Arbitrum HTLCEscrow | `0x…` |
| `CBTC_HTLC_PKG_ID` | `…` |
| Solver EVM address | `0x…` |
| Solver Canton party | `warpx-mainnet-1::…` |
| Web URL | `https://…` |
| Supabase project | `…` |
| Deploy date | |
