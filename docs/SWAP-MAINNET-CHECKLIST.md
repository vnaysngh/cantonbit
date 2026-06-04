# Mainnet Pre-Requisites Checklist — WBTC(Base) → cBTC(Canton) Swap

> Before any mainnet test, EVERY item here must be ✅. Mainnet means **real WBTC
> and real cBTC** — this is custodial, two-legged (NOT atomic) settlement, so a
> bug or a missing guard means real lost funds. Do not shortcut this list.

Status legend: ✅ done · ⚠️ partial · ❌ not done / blocked

---

## A. External dependencies (NOT in our control — likely the long pole)

| # | Item | Status | Notes |
|---|---|---|---|
| A1 | **Real cBTC float on a mainnet Canton party** | ❌ | We have DevNet cBTC only. Mainnet cBTC needs BitSafe/mint access (still pending per CLAUDE.md). **No float → nothing to deliver → swap can't complete.** This is the hard blocker. |
| A2 | **Mainnet Canton m2m credentials** (KEYCLOAK_* for the mainnet ledger) | ❌ | DevNet creds won't auth against `ledger-api.validator.warpx.fivenorth.io`. Need mainnet client_id/secret + token URL from Five North/Authentik. |
| A3 | **Mainnet Canton solver party** funded with the cBTC float | ❌ | A real party id on mainnet that holds A1's cBTC. |
| A4 | **Real WBTC, in the user/test wallet** | ❌ (user supplies) | **DECISION: source chain = ARBITRUM ONE** (single chain). Arbitrum WBTC = `0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f` — **VERIFIED**: name "Wrapped BTC", symbol WBTC, **decimals 8**, **~7,063 WBTC supply** (deep liquidity), classic ERC-20 (not an OFT). Permit2 deployed. Chosen over Base (whose WBTC is a thin ~60-supply LayerZero OFT — cbBTC dominates Base instead). Cannot be minted — user supplies. |
| A5 | **Base mainnet ETH for gas** (agent + user wallets) | ❌ | Real ETH for attest + finalise + openFor gas. |
| A6 | **cBTC mainnet instrument id + registry confirmed** | ⚠️ | CLAUDE.md lists mainnet admin `cbtc-network::12205af3b949a047…` + registry `https://api.utilities.digitalasset.com`. Confirmed values, but never exercised live. Verify the instrument resolves before relying on it. |

---

## B. Code changes required (in our control — must ship before mainnet)

| # | Item | Status | File / action |
|---|---|---|---|
| B1 | **Deploy script: real-WBTC mainnet mode** | ✅ DONE | `deploy.ts` is now SWAP_NETWORK-aware: mainnet uses the real Base WBTC (default `0x0555…`, asserts decimals==8), no MockWBTC, no mint, gated behind ALLOW_MAINNET=true. Also splits oracle owner (cold) / attestor (hot) via ORACLE_OWNER / ORACLE_ATTESTOR. |
| B1b | **WBTC/Permit2 compatibility check** | ✅ DONE (static) | `check-wbtc-permit2.ts` confirms (read-only, no spend) decimals==8, ERC-20 surface, and Permit2 deployed on Base. Ran green against Base mainnet. The OFT-pull-via-Permit2 path still needs ONE live dust approve→openFor→refund before a real swap (flagged). |
| B2 | **De-hardcode the E2E/diagnostic scripts** | ❌ | `e2e-full.ts`, `live-canton.ts`, `check-float.ts` have DevNet registry URL + `cbtc-network::12202a83…` admin party as string literals. They'd silently test DevNet even under mainnet env. Make them read from env (same source as `index.ts`). |
| B3 | **Confirm `index.ts`/`env.ts` are fully env-driven** | ✅ | Already verified: the main loop reads network, RPC, escrow/oracle/wbtc, all Canton config + creds from env. No mainnet code change needed in the core runtime. |
| B4 | **`ALLOW_MAINNET=true` gate** | ✅ | Already enforced in `env.ts` — refuses mainnet unless explicitly set. Keep it. |
| B5 | **Amount-cap / max-order guard** | ❌ | Add a hard ceiling on per-order WBTC (e.g. start at 0.001 WBTC) so a bug or a malformed order can't move large sums during early mainnet runs. Not currently enforced. |
| B6 | **Float pre-flight on startup** | ⚠️ | `delivery.ts` checks float per-order, but add a startup assertion that the mainnet float is non-zero and ≥ the amount cap, so we fail loudly before accepting orders. |

---

## C. Contract deployment — ✅ DONE on ARBITRUM ONE

Deployed `2026-06` via `deploy.ts` (SWAP_NETWORK=mainnet EVM_CHAIN=arbitrum
ALLOW_MAINNET=true DEPLOY_ENV_PATH=.env.mainnet WBTC_ADDRESS=0x2f2a2543…).
Verified on-chain (code present; oracle owner==attestor==agent).

| Contract | Arbitrum One address |
|---|---|
| **InputSettlerEscrow** | `0x306007585469a2dde4ca8ab47d2d6a76833815e0` |
| **OranjAttestorOracle** | `0x77c1cd60f79379f00dfd66a5a31e0ae92c9b7073` |
| **WBTC** (real) | `0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f` |
| Start block | `470011441` |
| Owner = attestor = deployer | `0x0B95ec…5A08` |

Addresses live in **`swap-solver/.env.mainnet`** (separate from devnet `.env`).

> ⚠️ **ENV LOAD ORDER (mainnet ops):** the devnet `.env` has a `WBTC_ADDRESS`
> (the devnet mock) that will SHADOW the mainnet address. Always load
> `.env.mainnet` AFTER `.env` for any mainnet command:
> `node --env-file=.env --env-file=.env.mainnet …` — so the Arbitrum addresses
> win. (Loading only `.env` points the solver at the dead devnet mock.)
| C4 | **(Recommended) Verify contracts on Basescan** | ❌ | So the escrow/oracle are auditable by anyone before users lock funds. |
| C5 | Set `ORIGIN_RPC_URL` to a reliable Base mainnet RPC | ❌ | Prefer a private/keyed RPC over a public one for finalise reliability. |

---

## D. Trust / key / safety setup (custodial — do NOT skip)

| # | Item | Status | Notes |
|---|---|---|---|
| D1 | **Separate hot (attestor) and cold (owner) keys** | ❌ | Today owner == attestor == one key (`0x0B95ec…`, a MetaMask test key). For mainnet, owner should be a cold/multisig that can rotate a dedicated hot attestor key. |
| D2 | **Fresh mainnet agent key** (not the test MetaMask key) | ❌ | The current key was used all over testnet. Mainnet should use a clean, treasury-grade key. |
| D3 | **Token-split for the Canton credential** | ❌ | The m2m token is ParticipantAdmin-grade (can act as warpx + every party). For mainnet, scope it down / isolate it to a backend-only service. (Roadmap follow-up #4.) |
| D4 | **Refund/expiry path validated live** | ⚠️ | Proven in Foundry, never on a live network. Validate on testnet FIRST (lock, don't finalise, let expire, user refunds) before mainnet. |
| D5 | **Manual two-step accept validated live** | ⚠️ | Only the auto-accept branch ran live. Validate the real accept-record-time branch on testnet first. |
| D6 | **Monitoring + alerting wired for real** | ⚠️ | `monitor.ts`/`cli.ts` exist; ensure someone actually watches `[ALERT]`/critical output during mainnet runs (at-risk = real money mid-flight). |

---

## E. Pre-mainnet validation gate (do these on TESTNET first)

These are cheap on testnet and de-risk mainnet. **Mainnet should not run until all pass.**

| # | Item | Status |
|---|---|---|
| E1 | Happy-path swap (already done 2×) | ✅ |
| E2 | Refund/expiry E2E on live testnet (D4) | ❌ |
| E3 | Manual two-step accept on live testnet (D5) | ❌ |
| E4 | Insufficient-float path (solver refuses, marks failed, no half-delivery) | ⚠️ unit-tested, not live |
| E5 | Amount-cap guard rejects an over-cap order (B5) | ❌ |
| E6 | Solver crash/restart mid-flight → resumes from store, no double-deliver | ⚠️ store is crash-safe; not explicitly drilled |

---

## Bottom line

**Config-only?** No. The core runtime is env-driven and ready (B3/B4 ✅), but
mainnet is blocked on:

1. **The hard external blocker:** real mainnet **cBTC float + mainnet Canton
   creds** (A1–A3) — pending BitSafe/Five North. Without cBTC to deliver, no
   swap can complete regardless of code.
2. **Real-money code gaps:** real-WBTC deploy mode (B1), de-hardcoding the test
   scripts (B2), and an amount cap (B5).
3. **Custodial safety:** key separation (D1/D2) and the two un-validated paths
   (refund D4, manual accept D5) — both must pass on **testnet** first.

**Recommended order:** finish E2/E3/E4 on testnet → ship B1/B2/B5 → sort keys
(D1/D2) → THEN, once A1–A3 land from BitSafe, deploy to mainnet (C1–C5) and run a
single tiny capped swap.
