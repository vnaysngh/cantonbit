# Canton Same-Chain Swap: Intent + Atomic Settlement

Same-chain CBTC↔CC swaps use an **intent + settlement** model instead of HTLC hashlocks.

Cross-chain WBTC↔CBTC swaps remain on the existing HTLC stack (`/api/htlc/*`, `npm run solver:htlc`).

## Architecture

| User type | Flow | Atomicity |
|-----------|------|-----------|
| **Managed (email)** | Quote → create order → `POST …/settle` | Both legs in one ledger submit (`actAs: [user, solver]`) |
| **Loop wallet** | Quote → create → prepare-user-leg → Loop sign sell → confirm-user-leg → solver fill | User sell is one tx; solver **fill** is one atomic submit (accept user leg + deliver counter) |

MVP pairs: **CBTC ↔ CC** only.

## Modules

| Path | Role |
|------|------|
| `lib/canton-swap-types.ts` | Order types and statuses |
| `lib/canton-swap-store.ts` | Supabase `canton_swap_orders` |
| `lib/canton-swap-quote.ts` | Tradecraft quote wrapper |
| `lib/canton-swap-settle.ts` | Managed + Loop fill settlement |
| `lib/canton-swap-service.ts` | Order lifecycle |
| `lib/canton-swap-holdings.ts` | Multi-asset holdings helper |
| `app/api/canton/swap/*` | HTTP API |
| `swap-solver/src/canton-swap-daemon.mts` | Polls `user_locked` → fill + expire |

## Order statuses

```
open → settling → filled          (managed)
open → user_locked → filled       (loop, after user signs sell)
open | user_locked → expired | failed | cancelled
```

## API routes

- `POST /api/canton/swap/quote` — live quote
- `GET /api/canton/swap/assets` — CBTC + CC
- `POST /api/canton/swap` — create intent
- `POST /api/canton/swap/[id]/settle` — managed atomic settle
- `POST /api/canton/swap/[id]/prepare-user-leg` — Loop sell command
- `POST /api/canton/swap/[id]/confirm-user-leg` — verify user offer → `user_locked`
- `POST /api/canton/swap/[id]/fill` — solver atomic fill (daemon)
- `GET /api/canton/swap/history` — user history
- `POST /api/canton/swap/expire` — expire stale orders (daemon)

## Loop CC receive

If the user lacks CC preapproval, the solver fill may create a pending transfer instruction. The UI shows an **Accept in Loop** step (`prepare-counter-accept` / `confirm-counter-accept`).

## Operations

- Run canton swap daemon: `npm run solver:canton-swap`
- Cross-chain HTLC daemon unchanged: `npm run solver:htlc`
- Solver party: `NEXT_PUBLIC_SOLVER_CANTON`
- Daemon auth: `HTLC_DAEMON_SECRET` or `CRON_SECRET`

## Legacy HTLC c2c orders

Old `canton-to-canton` rows in `htlc_orders` are **not migrated**. Users wait for timelock + manual refund or abandon. New same-chain swaps use `canton_swap_orders` only.

## Constraints

- Managed atomic path requires **direct/auto-accept** transfer kind on both parties (preapproval).
- Solver must hold sufficient **counter-asset float** at create and fill time.
- UTXO limit (10 holdings) — warn at 8.
