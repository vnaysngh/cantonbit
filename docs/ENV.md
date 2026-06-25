# Environment files

**Start here for running swaps:** [SWAP-RUNBOOK.md](SWAP-RUNBOOK.md) — devnet/mainnet terminals, daemons, wallet modes, and troubleshooting.

OranjSwap runs two independent stacks locally: **devnet** and **mainnet**. Each stack has **one** env file — you do **not** duplicate keys across `.env.local` and `.env.devnet`.

## Source of truth

| Stack | File | Commands |
|-------|------|----------|
| **Devnet** | **`.env.devnet`** | `npm run dev:devnet`, `npm run solver:htlc`, `npm run solver:canton-swap` |
| **Mainnet** | **`.env.mainnet`** | `npm run dev:mainnet`, `npm run solver:htlc:mainnet`, `npm run solver:canton-swap:mainnet` |

`scripts/with-env.sh` loads **only** the selected stack file. It mirrors that file to `.env.development.local` on each `dev:*` start so Next.js/Turbopack workers match the stack.

## File map

| File | Purpose | Committed? |
|------|---------|------------|
| `.env.devnet.example` | Template for devnet | Yes |
| `.env.mainnet.example` | Template for mainnet | Yes |
| `.env.local.example` | Optional machine-only overrides (empty by default) | Yes |
| **`.env.devnet`** | Your devnet secrets + addresses | No (gitignored) |
| **`.env.mainnet`** | Your mainnet secrets + addresses | No |
| **`.env.local`** | Optional — **do not** put stack config here | No |
| `.env.development.local` | Auto-generated from stack file on `dev:*` | No |
| `swap-solver/.env.htlc-devnet` | HTLC daemon extras (EVM key, RPC, API_BASE) | No |
| `swap-solver/.env.htlc-mainnet` | HTLC daemon extras (mainnet) | No |

### What about `.env.local`?

Next.js **always** loads `.env.local` if it exists. Duplicate stack keys there cause **401** on daemon routes and wrong-network bugs.

**Rule:** all stack config in `.env.devnet` or `.env.mainnet` only. Delete `.env.local` or keep it empty (see `.env.local.example`).

```bash
./scripts/consolidate-env.sh   # warns on duplicate keys
```

### HTLC / C2C daemons

Later `--env-file` wins:

```
../.env.devnet → .env.htlc-devnet     (devnet HTLC)
../.env.mainnet → .env.htlc-mainnet   (mainnet HTLC)
../.env.devnet                        (devnet C2C)
../.env.mainnet                       (mainnet C2C)
```

Shared secrets go in the web stack file. Solver-only vars (`SOLVER_EVM_PK`, `API_BASE`) go in `swap-solver/.env.htlc-*`.

## Commands

```bash
cp .env.devnet.example .env.devnet
cp .env.mainnet.example .env.mainnet
cp swap-solver/.env.htlc-devnet.example swap-solver/.env.htlc-devnet
cp swap-solver/.env.htlc-mainnet.example swap-solver/.env.htlc-mainnet

npm run dev:devnet
npm run solver:htlc
```

Default `npm run dev` → **devnet**.

## Production (Railway)

Railway does not use these files. Paste variables from `.env.devnet` / `.env.mainnet` into the service Variables UI. HTLC workers also need `swap-solver/.env.htlc-*` vars (`SOLVER_EVM_PK`, `API_BASE`, etc.).
