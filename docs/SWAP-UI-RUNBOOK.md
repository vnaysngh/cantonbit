# Swap UI Runbook — testnet end-to-end

How to run a full WBTC(Base Sepolia) → cBTC(Canton DevNet) swap through the
browser UI. Three processes must run together.

## 1. Start the three processes

```bash
# A) Solver API (serves /quote + submits openFor) — from swap-solver/
node --env-file=../.env.local --env-file=.env --import tsx src/serve.ts
#    → listening on http://localhost:8787

# B) Solver loop (deliver → attest → finalise) — from swap-solver/
node --env-file=../.env.local --env-file=.env --import tsx src/index.ts
#    → [watch] live ; [health] [ok]

# C) Oranj app — from repo root/
npm run dev
#    → http://localhost:3000
```

> ENV LOAD ORDER: `../.env.local` FIRST, `.env` LAST (so the 20-char DevNet
> KEYCLOAK_CLIENT_ID wins). env.ts also auto-selects KEYCLOAK_CLIENT_SECRET_DEVNET
> on devnet, so auth "just works" if both files are present.

A) and B) share the same order store (`.oranj-swap/orders.json` by default), so
an order created in the browser is picked up by the loop automatically.

## 2. Do the swap in the browser

1. Open http://localhost:3000 and **log in** (allocates your Canton party).
2. Click **Swap** in the top nav.
3. **Canton (destination)** row auto-fills from your session.
4. **EVM (source)** row → **Connect** → approve MetaMask. Be on **Base Sepolia
   (84532)** — the page warns if not.
5. Enter amount (default `0.0001`), **Get quote**, review, **Confirm swap**.
6. MetaMask: **approve WBTC** (first time only), then **sign** the swap.
7. Watch the live steps: WBTC locked → Delivering → Delivered → Attested →
   Complete ✓.

## 3. Caveat — wallet auto-accept

If the destination wallet has **auto-accept ON**, the cBTC offer is accepted
instantly and the flow races straight through (this is fine — the swap still
completes). To watch the *manual* accept step, turn auto-accept OFF; the offer
then waits in the wallet for you to accept before the solver settles.

## 4. Config knobs

| Env (swap-solver/.env) | Meaning | Default |
|---|---|---|
| `API_PORT` | Solver API port | 8787 |
| `MAX_WBTC_PER_ORDER` | Per-order WBTC cap (base units, 8dp) | 100000 (0.001) |
| `STORE_PATH` | Shared order store | `.oranj-swap/orders.json` |

| Env (app .env.local) | Meaning | Default |
|---|---|---|
| `NEXT_PUBLIC_SWAP_API_URL` | Where the UI finds the solver API | http://localhost:8787 |

## 5. What the UI proves that the scripts didn't

The CLI E2E (`e2e-full.ts`) drove the swap with a private key in Node. The UI
proves the *real user path*: browser wallet connect, Permit2 approve, EIP-712
`signTypedData_v4` in MetaMask, the cross-origin API calls, and live status
polling — the integration surface scripts never touched.
