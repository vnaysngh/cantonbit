# Deploying OranjSwap to Railway

OranjSwap is **three long-running processes**, and Railway runs **one process per
service**. So you create **3 services from this one repo**:

| # | Service | What it runs | Port | Public? |
|---|---------|--------------|------|---------|
| 1 | `oranjswap-web` | Next.js app (`next start`) | Railway-assigned `$PORT` | ✅ yes (your users) |
| 2 | `oranjswap-api` | Solver API (`serve.ts`) | `$PORT` (Railway-assigned) | 🔒 internal only |
| 3 | `oranjswap-watch` | Solver watch loop (`index.ts`) | none | ❌ no |

The **watch loop** and **API** share the order store, so they need a **shared
persistent volume**. The **web** app talks to the **API** over Railway's private
network.

---

## Prerequisites

1. A [Railway](https://railway.app) account, and the repo pushed to GitHub.
2. The Railway CLI (optional but handy): `npm i -g @railway/cli` then `railway login`.
3. Node 22 — Railway auto-detects from `engines` in `package.json` (already set).

---

## Step 0 — One-time code prep (already in the repo)

- `railway.json` files tell Railway how to build/start each service (added — see below).
- The solver scripts use `--env-file` locally; **on Railway, env vars come from the
  dashboard**, so each service has a start command WITHOUT `--env-file`.
- The API must bind to `0.0.0.0` on Railway (not loopback) — set `API_BIND_HOST=0.0.0.0`.

---

## Step 1 — Create the project + first service (web)

1. Railway dashboard → **New Project → Deploy from GitHub repo** → pick this repo.
2. Railway creates one service. Rename it **`oranjswap-web`** (Settings → Service Name).
3. Settings → **Build**: leave Nixpacks (auto). **Build command**: `npm run build`.
4. Settings → **Deploy → Start command**: `npm run start -- -p $PORT`
5. Settings → **Networking → Generate Domain** (this is your public URL).

## Step 2 — Add the solver API service

1. In the same project → **New → GitHub Repo → (same repo)**.
2. Rename it **`oranjswap-api`**.
3. Settings → **Root Directory**: `swap-solver`
4. Settings → **Build command**: *(leave blank — tsx runs TS directly, no build)*
5. Settings → **Start command**:
   `npx tsx src/serve.ts`
6. Settings → **Networking**: do **NOT** generate a public domain. Keep it private.
   Railway gives it a private hostname like `oranjswap-api.railway.internal`.

## Step 3 — Add the solver watch service

1. **New → GitHub Repo → (same repo)** again.
2. Rename it **`oranjswap-watch`**.
3. Settings → **Root Directory**: `swap-solver`
4. **Start command**: `npx tsx src/index.ts`
5. No domain, no port.

## Step 4 — Shared persistent volume (API + watch share the order store)

The order store (`STORE_PATH`) must survive restarts AND be the same file for both
the API and the watch loop.

1. On **`oranjswap-api`** → Settings → **Volumes → New Volume**.
   Mount path: `/data`
2. Set env var on **both** api + watch: `STORE_PATH=/data/orders.json`
3. Attach the **same** volume to `oranjswap-watch` (Railway → Volumes → attach
   existing). If Railway won't let two services share one volume in your plan, run
   the API + watch as a **single service** instead (see "Alternative" at the bottom).

## Step 5 — Environment variables

Set these in **each** service (Railway → service → Variables). **Never commit these.**

### `oranjswap-web` (Next.js)
```
# DO NOT set NEXT_PUBLIC_SWAP_API_URL in production — leaving it unset makes the
# browser use the same-origin proxy at /api/solver (app/api/solver/[...path]),
# which forwards server-side to the PRIVATE solver. Set instead:
SOLVER_INTERNAL_URL = http://oranjswap-solver.railway.internal:<solver $PORT>
NEXT_PUBLIC_NETWORK = mainnet
NEXT_PUBLIC_SWAP_CHAIN = arbitrum
NEXT_PUBLIC_LOOP_NETWORK = mainnet
NEXT_PUBLIC_PARTY_ID = <your party id>
# Supabase / auth / email (from your .env.local):
NEXT_PUBLIC_SUPABASE_URL = ...
NEXT_PUBLIC_SUPABASE_ANON_KEY = ...
SUPABASE_SERVICE_ROLE_KEY = ...      # secret
KEYCLOAK_TOKEN_URL = ...
KEYCLOAK_SCOPE = ...
KEYCLOAK_CLIENT_ID = ...
KEYCLOAK_CLIENT_SECRET = ...         # secret
RESEND_API_KEY = ...                 # secret
CRON_SECRET = ...                    # secret
```

> **How the browser reaches the solver (proxy model — already wired):**
> The client (`lib/swap-api.ts`) defaults to the same-origin path `/api/solver`.
> A catch-all route (`app/api/solver/[...path]/route.ts`) forwards each call
> server-side to `SOLVER_INTERNAL_URL` (the private `.railway.internal` host). So:
>   browser → `/api/solver/quote` (your domain) → Next server → private solver.
> The solver is **never exposed to the public internet** — it has a rate-limiter
> but no auth, so this is the safe model. Just set `SOLVER_INTERNAL_URL` on the web
> service and leave `NEXT_PUBLIC_SWAP_API_URL` UNSET in prod.
> (Verified locally: GET/POST proxy through, status codes pass through 200/400/404.)

### `oranjswap-api` AND `oranjswap-watch` (solver — set on BOTH)
```
# --- network / chain ---
SWAP_NETWORK = mainnet
EVM_CHAIN = arbitrum
ALLOW_MAINNET = true
ORIGIN_RPC_URL = https://arb1.arbitrum.io/rpc
WBTC_ADDRESS = 0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f
ESCROW_ADDRESS = 0x306007585469a2DdE4CA8aB47D2D6A76833815e0
ORACLE_ADDRESS = 0x77C1Cd60F79379f00dfd66a5A31e0AE92c9b7073
ESCROW_START_BLOCK = <your start block>

# --- Canton ---
CANTON_LEDGER_HOST = https://ledger-api.validator.warpx.fivenorth.io
CANTON_REGISTRY_URL = https://api.utilities.digitalasset.com
CANTON_ADMIN_PARTY = cbtc-network::1220...
CANTON_INSTRUMENT_ID = CBTC
SOLVER_CANTON_PARTY = warpx-mainnet-1::1220...
SWAP_RECIPIENT_PARTY = ...

# --- auth (Keycloak m2m) ---
KEYCLOAK_CLIENT_ID = validator-mainnet-m2m
KEYCLOAK_CLIENT_SECRET = <secret>     # ⚠️ TREASURY-GRADE

# --- treasury / payout ---
PRIVATE_KEY = 0x...                    # ⚠️ TREASURY-GRADE agent hot key
PAYOUT_ADDRESS = 0xF340588678B8cDC3d09D5D3c4a784470525411B5

# --- economics + safety knobs ---
SOLVER_FEE_BPS = 20
PER_USER_INFLIGHT_SATS = 1000000
MIN_GAS_ETH_WEI = 2000000000000000
# DEPEG_FEED = 0x0017abAc5b6f291F9164e35B1234CA1D697f9CF4   # enable de-peg breaker
# MAX_INFLIGHT_SATS = 10000000                              # optional global cap
# BANNED_USERS = 0x...,0x...                                # optional deny-list

# --- runtime ---
STORE_PATH = /data/orders.json
```

### Extra for `oranjswap-api` only
```
API_PORT = $PORT            # Railway injects $PORT; the API reads API_PORT
API_BIND_HOST = 0.0.0.0     # MUST bind public on Railway (loopback won't be reachable)
API_CORS_ORIGIN = https://<your web domain>   # lock CORS to the web app
API_RATE_RPS = 10
API_RATE_BURST = 30
```

> The API reads `API_PORT`, not `PORT`. Set `API_PORT=$PORT` (Railway variable
> reference) OR change the start command to `API_PORT=$PORT npx tsx src/serve.ts`.

## Step 6 — Deploy + verify

1. Push to `main` (or your deploy branch) → Railway auto-builds all 3 services.
2. Watch each service's **Deploy Logs**:
   - web: `✓ Ready` from Next.
   - api: `[oranj-swap-api] listening on http://0.0.0.0:<port>`
   - watch: `[preflight] cBTC float: ... cBTC` then `[watch] backfilling…`
3. **Float preflight is the key check** — the watch loop REFUSES to start on mainnet
   if the cBTC float is empty (this is the safety guard). If it exits, the float
   isn't funded or Canton creds are wrong.
4. Hit your web domain → do a tiny test swap.

## Step 7 — Health checks (recommended)

- `oranjswap-api` → Settings → **Healthcheck Path**: `/health`
- This lets Railway restart the API if it ever crashes (e.g. the EADDRINUSE class
  of problem can't happen on Railway since each service owns its port).

---

## Alternative: run API + watch as ONE service

If your Railway plan can't share a volume between two services, run both solver
processes in one service so they share the same container filesystem:

1. Keep only `oranjswap-web` and `oranjswap-solver`.
2. `oranjswap-solver` start command (root dir `swap-solver`):
   `npx tsx src/serve.ts & npx tsx src/index.ts & wait`
3. One volume at `/data`, `STORE_PATH=/data/orders.json`.
4. Expose the API port as above.

Downside: a crash in one process restarts both. Fine for v1.

---

## Security checklist before going live

- [ ] `PRIVATE_KEY` + `KEYCLOAK_CLIENT_SECRET` set ONLY in Railway Variables, never in git.
- [ ] `API_BIND_HOST=0.0.0.0` but the API is either private-network-only OR behind an
      auth gateway (it has a rate-limiter, not auth).
- [ ] `API_CORS_ORIGIN` locked to your web domain (not `*`).
- [ ] `DEPEG_FEED` set if you want the de-peg circuit breaker live.
- [ ] Volume attached so the order store persists across deploys (else in-flight
      orders are lost on redeploy — they'd still auto-refund on-chain, but tracking
      is lost).
- [ ] Agent hot key funded with enough ETH for gas (`MIN_GAS_ETH_WEI` guards against
      running dry, but it must be topped up).
- [ ] cBTC float funded (the watch loop won't start on mainnet without it).
