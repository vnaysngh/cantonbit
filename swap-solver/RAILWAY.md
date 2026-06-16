# Railway — canton-swap + HTLC solver services

**Do not use the web app build command here.** These are worker services.

## Required settings (both `canton-swap-*` and `htlc-solver-*`)

| Setting | Value |
|---------|-------|
| **Deploy branch** | `feat/trustless-bonded-swap` ( **`main` has no `swap-solver/`** ) |
| **Root directory** | `swap-solver` |
| **Build command** | `npm ci` |
| **Start command** | see below |

If Root directory is `swap-solver`, **do not** `cd swap-solver` in the build — you are already inside it.

## canton-swap-mainnet / canton-swap-devnet

**Same start command for both networks.** Network is chosen by env vars + which web service you point at — not by `:mainnet` / devnet npm scripts.

| Setting | Value |
|---------|-------|
| Root directory | `swap-solver` |
| Build | `npm ci` |
| Start | `npm run canton-swap-daemon:prod` |

Alternative start (equivalent): `npx tsx src/canton-swap-daemon.mts`

### Wrong start commands (crash with `.env.local` / `.env.devnet` / `.env.mainnet` not found)

| Do not use | Loads missing files |
|------------|---------------------|
| `npm run solver:canton-swap` | `../.env.local`, `../.env.devnet` |
| `npm run solver:canton-swap:mainnet` | `../.env.local`, `../.env.mainnet` |
| `npm run canton-swap-daemon` | same as devnet row |
| `npm run canton-swap-daemon:mainnet` | same as mainnet row |

Local-only scripts — for `npm run dev:mainnet` on your laptop, not Railway.

### Env (minimum)

- `HTLC_DAEMON_SECRET` — same as paired web service
- `CANTON_SWAP_API_URL` — internal web URL (`http://`, include port):
  - **devnet:** `http://oranjswap-web-devnet.railway.internal:8080`
  - **mainnet:** `http://oranjswap-web-mainnet.railway.internal:8080`

## htlc-solver-mainnet / htlc-solver-devnet

| Setting | Value |
|---------|-------|
| Start | `npm run htlc-daemon:prod` |

Same rule: do not use `htlc-daemon:mainnet` on Railway (it expects local `.env` files).

See `docs/MAINNET-DEPLOY.md` for HTLC env vars.

## Wrong (causes `cd: can't cd to swap-solver`)

```
Root directory: / 
Build: npm ci && cd swap-solver && npm ci
Branch: main
```

Either the branch lacks `swap-solver/`, or Root directory is already `swap-solver` and the extra `cd` fails.
