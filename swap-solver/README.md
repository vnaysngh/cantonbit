# Oranj Swap Solver

Single-solver, custodial cross-chain swap: **WBTC on Base → cBTC on Canton**.

Built on the OpenIntents Framework (OIF) **input** contracts only. We reuse the
audited `InputSettlerEscrow` on Base and a small custom attestor oracle; we do
**not** use OIF's EVM `OutputSettler` or the Rust reference solver (both are
EVM-hardcoded). The "output" leg is delivered on Canton by the existing Oranj
app, and a trusted off-chain agent attests the fill back to Base.

## Settlement model (read this)

This is **two-legged, optimistic/trust-based settlement** — NOT atomic.

1. User locks WBTC in `InputSettlerEscrow` on Base.
2. Solver delivers cBTC on Canton (reusing `../lib/canton.ts`, `../lib/mint.ts`).
3. Solver attests the fill on the custom oracle (Base).
4. Solver calls `finalise()` → escrow staticcalls the oracle → WBTC released.

There is a gap between (2) and (4). The **solver bears completion risk**: deliver
cBTC only after the Base lock is final and there is margin to attest+finalise
before the order deadline. The user is protected by `refund()` after expiry.

The agent/oracle key can release any locked WBTC by attesting — treat it like a
treasury secret (server-only, never logged, ideally a dedicated signer).

## Layout

- `../contracts` — Foundry project. Imports `oif-contracts` (forge dep) so we
  deploy `InputSettlerEscrow` unchanged and build our custom oracle on top of
  `BaseInputOracle`.
- `swap-solver/src` — the TS service (viem). Maps to the task plan:
  - watch `Open` events on Base → deliver on Canton → attest → finalise.

## Dev

```bash
# contracts
cd ../contracts && forge build && forge test

# solver
cd ../swap-solver && npm install && npm run typecheck && npm run dev
```
