# Swap runbook — devnet, mainnet, daemons, and wallet modes

One place to answer: **what do I start, with which env files, for which swap?**

Related docs:

| Doc | When to read |
|-----|----------------|
| [ENV.md](ENV.md) | Env file map, `.env.local` pitfalls |
| [MAINNET-DEPLOY.md](MAINNET-DEPLOY.md) | Railway topology, EVM deploy, Arbitrum vs Base notes |
| [C2C-MAINNET-LAUNCH.md](C2C-MAINNET-LAUNCH.md) | C2C API routes, mainnet smoke curls |
| [SWAP-FEE-ECONOMICS.md](SWAP-FEE-ECONOMICS.md) | Fee policy, byte breakdowns, network-fee ops, P&L |

---

## 1. Mental model (three moving parts)

```
┌─────────────────────────────────────────────────────────────┐
│  Web app (Next.js)  —  npm run dev:devnet | dev:mainnet   │
│  UI + all /api/* routes (quotes, orders, settle, HTLC)      │
└───────────────────────────┬─────────────────────────────────┘
                            │ HTTP (localhost:3000 or Railway URL)
          ┌─────────────────┴─────────────────┐
          ▼                                   ▼
┌──────────────────────┐            ┌──────────────────────────┐
│ HTLC solver daemon   │            │ C2C Loop fill daemon     │
│ npm run solver:htlc* │            │ npm run solver:canton-*  │
│                      │            │                          │
│ Cross-chain ONLY     │            │ Same-chain Loop ONLY     │
│ WBTC ↔ CBTC          │            │ CBTC ↔ CC                │
└──────────────────────┘            └──────────────────────────┘
```

| Process | npm script (devnet) | npm script (mainnet) | Needed when |
|---------|---------------------|----------------------|-------------|
| **Web app** | `npm run dev:devnet` | `npm run dev:mainnet` | Always |
| **HTLC daemon** | `npm run solver:htlc` | `npm run solver:htlc:mainnet` | Any **WBTC ↔ CBTC** swap |
| **C2C daemon** | `npm run solver:canton-swap` | `npm run solver:canton-swap:mainnet` | **CBTC ↔ CC** with **Loop wallet** only |

**Managed (email) users never need the C2C daemon** — the web backend settles atomically.

**Loop users never get app-collected Canton network fees** — Loop/validator traffic is separate (see fee section below).

---

## 2. Two stacks (never mix them)

| | **Devnet** | **Mainnet** |
|--|------------|-------------|
| Canton | WarpX devnet | WarpX mainnet |
| Loop network | `devnet` | `mainnet` |
| EVM (HTLC) | Base Sepolia (`NEXT_PUBLIC_SWAP_CHAIN=base-sepolia`) | Base mainnet (`base`) in current examples |
| Web env file | `.env.devnet` | `.env.mainnet` |
| HTLC daemon env | `swap-solver/.env.htlc-devnet` | `swap-solver/.env.htlc-mainnet` |
| Real money? | No | **Yes** |

**Invariant:** Loop network, Canton ledger, EVM chain, solver parties, and `API_BASE` must all belong to the **same** stack. A devnet Loop wallet against a mainnet web app will fail.

---

## 3. Wallet modes

| Mode | How you sign in | Canton party | Used for |
|------|-----------------|--------------|----------|
| **Managed** | Email → `/login` → `/api/parties/me` | Participant-managed on WarpX (`party_hint=participant-managed`) | C2C settle, HTLC claim/lock where backend has CanActAs |
| **Loop** | Loop browser extension connected on `/swap` | Loop wallet party | C2C user leg + counter accept; HTLC Loop claim paths |

The swap page picks mode automatically: if you have a session party, you're **managed**; otherwise **Loop**.

**One-time managed setup (C2C):** deposit CC, enable CC + CBTC auto-accept on your party (shown in the review modal).

---

## 4. Swap types × what runs

### A. Same-chain **CBTC ↔ CC** (Canton only)

| Wallet | Web | C2C daemon | HTLC daemon | User flow (short) |
|--------|-----|------------|-------------|-------------------|
| **Managed** | ✅ | ❌ | ❌ | Quote → confirm → `POST /settle` (atomic offer + fill) |
| **Loop** | ✅ | ✅ | ❌ | Quote → sign user leg in Loop → daemon **fill** → maybe accept counter in Loop |

### B. **WBTC → CBTC** (EVM → Canton, `evm-to-canton`)

| Wallet | Web | HTLC daemon | User flow (short) |
|--------|-----|-------------|-------------------|
| **Managed** | ✅ | ✅ | Lock WBTC on EVM (MetaMask) → daemon locks CBTC counter → **claim-managed** (backend) |
| **Loop** | ✅ | ✅ | Lock WBTC on EVM → daemon locks CBTC counter → **claim-counter** in Loop |

### C. **CBTC → WBTC** (Canton → EVM, `canton-to-evm`)

| Wallet | Web | HTLC daemon | User flow (short) |
|--------|-----|-------------|-------------------|
| **Managed** | ✅ | ✅ | **lock-main** (backend locks your CBTC) → daemon locks WBTC on EVM → you claim WBTC on EVM → solver **claim-main** |
| **Loop** | ✅ | ✅ | Sign CBTC transfer to venue in Loop → daemon locks WBTC → you claim WBTC on EVM → solver records completion |

> Reverse **managed** is email-only in v1 (`lock-main` rejects Loop `counterMode`).

---

## 5. First-time local setup

From repo root:

```bash
# 1. Web stack templates
cp .env.devnet.example .env.devnet
cp .env.mainnet.example .env.mainnet

# 2. HTLC daemon templates
cp swap-solver/.env.htlc-devnet.example swap-solver/.env.htlc-devnet
cp swap-solver/.env.htlc-mainnet.example swap-solver/.env.htlc-mainnet
```

Fill secrets (see §7). **Do not** put `NEXT_PUBLIC_NETWORK`, `HTLC_DAEMON_SECRET`, or `CRON_SECRET` in `.env.local` unless you know why — duplicate keys cause **401 on daemon routes**. Details: [ENV.md](ENV.md).

### Devnet-only: C2C settlement vault

C2C swaps need `CANTON_SWAP_SETTLEMENT_PARTY` in `.env.devnet` (offer-path vault, **no** TransferPreapproval):

```bash
npm run provision-settlement:devnet
# → copy printed party id into .env.devnet:
# CANTON_SWAP_SETTLEMENT_PARTY=<oranj-settle-devnet::1220…>
```

Fund vault CBTC/CC float:

```bash
npm run party-balances:devnet -- '<vault-party>'
npm run fund-swap-vault:devnet -- --dry-run
```

Mainnet vault: use `oranj-settle-mainnet::1220…` from [C2C-MAINNET-LAUNCH.md](C2C-MAINNET-LAUNCH.md) (same as farm fleet).

### Supabase

Run migrations through **025** (`network_fee` + HTLC fee columns) on the Supabase project paired with that stack.

---

## 6. Local run — copy/paste sessions

Replace terminal commands — **do not** edit env files when switching stacks.

### Devnet — managed user, C2C only

```bash
# Terminal 1
npm run dev:devnet
# Browser: /login → /swap → CBTC↔CC
```

### Devnet — Loop user, C2C

```bash
# Terminal 1
npm run dev:devnet

# Terminal 2
npm run solver:canton-swap
# Connect Loop (devnet) on /swap
```

### Devnet — any HTLC (managed or Loop)

```bash
# Terminal 1
npm run dev:devnet

# Terminal 2
npm run solver:htlc
# Fill SOLVER_EVM_PK in swap-solver/.env.htlc-devnet
# Connect EVM wallet to Base Sepolia + Loop or email login as needed
```

### Devnet — everything at once (full desk)

```bash
# Terminal 1 — web
npm run dev:devnet

# Terminal 2 — HTLC cross-chain
npm run solver:htlc

# Terminal 3 — C2C Loop fills
npm run solver:canton-swap
```

### Mainnet (real funds)

Same pattern with `:mainnet` scripts:

```bash
npm run dev:mainnet              # terminal 1
npm run solver:htlc:mainnet      # terminal 2 — HTLC
npm run solver:canton-swap:mainnet   # terminal 3 — Loop C2C only
```

Set `ALLOW_MAINNET=true` in `swap-solver/.env.htlc-mainnet`. Use a **dedicated** mainnet `SOLVER_EVM_PK`.

---

## 7. Minimum env checklist

### Web — `.env.devnet` / `.env.mainnet`

| Variable | Purpose |
|----------|---------|
| `NEXT_PUBLIC_NETWORK` | `devnet` or `mainnet` |
| `NEXT_PUBLIC_LOOP_NETWORK` | Same as above |
| `NEXT_PUBLIC_SWAP_CHAIN` | `base-sepolia` (devnet) or `base` (mainnet examples) |
| `KEYCLOAK_*` | WarpX m2m JWT for ledger reads/writes |
| `NEXT_PUBLIC_SUPABASE_*` + `SUPABASE_SERVICE_ROLE_KEY` | Order persistence |
| `HTLC_DAEMON_SECRET` | Bearer token for daemon API routes (`fill`, `pending`, HTLC daemon callbacks) |
| `NEXT_PUBLIC_SOLVER_CANTON` / `SOLVER_CANTON_PARTY` | HTLC solver Canton party + float |
| `NEXT_PUBLIC_HTLC_ESCROW` / `NEXT_PUBLIC_WBTC_ADDRESS` | EVM contract addresses |
| `CBTC_HTLC_PKG_ID` | On-ledger HTLC package |
| **`CANTON_SWAP_SETTLEMENT_PARTY`** | **Required for C2C** (settlement vault) |

Generate a long random `HTLC_DAEMON_SECRET` and use the **same value** in the matching daemon env file.

### HTLC daemon — `swap-solver/.env.htlc-*`

| Variable | Purpose |
|----------|---------|
| `API_BASE` | Web app URL (`http://localhost:3000` locally) |
| `HTLC_DAEMON_SECRET` | Must match web stack |
| `SOLVER_EVM_PK` | Solver hot key for EVM lock/claim |
| `ORIGIN_RPC_URL` | EVM RPC (Sepolia Base / Base mainnet) |
| `HTLC_ESCROW_ADDRESS` | Escrow contract |
| `EVM_CHAIN` | `base-sepolia` or `base` |
| `ALLOW_MAINNET` | `true` on mainnet only |

### C2C daemon — uses web env only

Loads `../.env.devnet` or `../.env.mainnet` + optional `../.env.local`.

| Variable | Purpose |
|----------|---------|
| `HTLC_DAEMON_SECRET` | Auth for `/api/canton/swap/pending`, `/fill`, `/expire` |
| `CANTON_SWAP_API_URL` or `NEXT_PUBLIC_APP_URL` | Default `http://localhost:3000` |

Optional: `CANTON_SWAP_POLL_MS` (default 5000).

---

## 8. Fees (what users see vs what you configure)

| Fee | Config | Charged how |
|-----|--------|-------------|
| **Platform fee** | `PLATFORM_FEE_BPS` / `NEXT_PUBLIC_FEE_BPS` (default 1%) | Baked into quote output — not a separate transfer |
| **Canton network fee** | `NETWORK_FEE_ENABLED=1` (+ `NEXT_PUBLIC_*` for UI) | Extra **CC** on managed paths only; off by default |
| **EVM gas** | — | User pays ETH on Base/Sepolia for HTLC lock/claim |
| **Loop Canton traffic** | — | Loop wallet / validator; not collected by app |

When network fees are enabled, apply migrations **023–025** and run `npm run probe-network-fee:devnet` before production. See [SWAP-FEE-ECONOMICS.md](SWAP-FEE-ECONOMICS.md) §8.

---

## 9. Production (Railway)

Recommended: **parallel services per stack** (don't toggle one service between devnet and mainnet).

| Service | Root dir | Start command | Pairs with |
|---------|----------|---------------|------------|
| Web devnet | `/` | `npm run build:devnet && npm start` | solver devnet |
| Web mainnet | `/` | `npm run build:mainnet && npm start` | solver mainnet |
| HTLC daemon | `swap-solver` | `npm run htlc-daemon:prod` | same-stack web URL in `API_BASE` |
| C2C daemon | `swap-solver` | `npm run canton-swap-daemon:prod` | same-stack web (Loop C2C only) |

Set all `NEXT_PUBLIC_*` in Railway **before** build. Use separate Supabase projects and **separate** `HTLC_DAEMON_SECRET` per stack if both run live.

Full matrix: [MAINNET-DEPLOY.md](MAINNET-DEPLOY.md).

---

## 10. Quick troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Daemon 401 Unauthorized | `HTLC_DAEMON_SECRET` mismatch or stale `.env.local` | Align secret web ↔ daemon; remove duplicate from `.env.local` |
| C2C "settlement party not configured" | Missing `CANTON_SWAP_SETTLEMENT_PARTY` | Run `provision-settlement:*`, fund vault |
| Loop C2C stuck at `user_locked` | C2C daemon not running | Start `solver:canton-swap` |
| HTLC stuck after EVM lock | HTLC daemon not running / no `SOLVER_EVM_PK` | Start `solver:htlc`, check solver CBTC float + EVM ETH |
| `UNKNOWN_INFORMEES` / wrong ledger | Mixed devnet/mainnet env | Match web + Loop + daemon to one stack |
| Managed C2C fails preapproval | User party setup | Deposit CC, enable CC + CBTC auto-accept |
| Reverse CBTC→WBTC fails for Loop | v1 managed-only lock-main | Use email login for reverse, or Loop seller path on `/orders` |

Useful commands:

```bash
npm run party-balances:devnet -- '<party>'
npm run check-swap-preapprovals:devnet
npm run probe-network-fee:devnet
curl -sS "$APP/api/canton/swap/pending?status=user_locked" \
  -H "Authorization: Bearer $HTLC_DAEMON_SECRET"
```

---

## 11. Legacy note: `npm run dev:all`

`scripts/dev-all.sh` starts the **old OIF solver** (`swap-solver` API on :8787 + watch loop) plus the web app. That is **not** the HTLC daemon and **not** the C2C fill daemon. For current OranjSwap flows, use §6 instead.

---

## 12. Cheat sheet (one line per scenario)

| I want to test… | Terminals |
|-----------------|-----------|
| Devnet C2C, email user | `dev:devnet` |
| Devnet C2C, Loop | `dev:devnet` + `solver:canton-swap` |
| Devnet WBTC↔CBTC | `dev:devnet` + `solver:htlc` |
| Devnet everything | `dev:devnet` + `solver:htlc` + `solver:canton-swap` |
| Mainnet C2C managed | `dev:mainnet` |
| Mainnet C2C Loop | `dev:mainnet` + `solver:canton-swap:mainnet` |
| Mainnet HTLC | `dev:mainnet` + `solver:htlc:mainnet` |

Always use the matching `.env.devnet` or `.env.mainnet` — pick the **script**, not a manual network toggle.
