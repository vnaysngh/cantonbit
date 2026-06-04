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
| A4 | **Real WBTC on Base mainnet, in the user/test wallet** | ❌ | Canonical Base WBTC = `0x0555E30da8f98308EdB960aa94C0Db47230d2B9c`. Cannot be minted — must be bought/bridged and held. |
| A5 | **Base mainnet ETH for gas** (agent + user wallets) | ❌ | Real ETH for attest + finalise + openFor gas. |
| A6 | **cBTC mainnet instrument id + registry confirmed** | ⚠️ | CLAUDE.md lists mainnet admin `cbtc-network::12205af3b949a047…` + registry `https://api.utilities.digitalasset.com`. Confirmed values, but never exercised live. Verify the instrument resolves before relying on it. |

---

## B. Code changes required (in our control — must ship before mainnet)

| # | Item | Status | File / action |
|---|---|---|---|
| B1 | **Deploy script: real-WBTC mainnet mode** | ❌ | `swap-solver/src/deploy.ts` hardcodes MockWBTC + free mint. Add a branch: on mainnet, skip MockWBTC, take `WBTC_ADDRESS` from env (the real `0x0555…`), do NOT mint. |
| B2 | **De-hardcode the E2E/diagnostic scripts** | ❌ | `e2e-full.ts`, `live-canton.ts`, `check-float.ts` have DevNet registry URL + `cbtc-network::12202a83…` admin party as string literals. They'd silently test DevNet even under mainnet env. Make them read from env (same source as `index.ts`). |
| B3 | **Confirm `index.ts`/`env.ts` are fully env-driven** | ✅ | Already verified: the main loop reads network, RPC, escrow/oracle/wbtc, all Canton config + creds from env. No mainnet code change needed in the core runtime. |
| B4 | **`ALLOW_MAINNET=true` gate** | ✅ | Already enforced in `env.ts` — refuses mainnet unless explicitly set. Keep it. |
| B5 | **Amount-cap / max-order guard** | ❌ | Add a hard ceiling on per-order WBTC (e.g. start at 0.001 WBTC) so a bug or a malformed order can't move large sums during early mainnet runs. Not currently enforced. |
| B6 | **Float pre-flight on startup** | ⚠️ | `delivery.ts` checks float per-order, but add a startup assertion that the mainnet float is non-zero and ≥ the amount cap, so we fail loudly before accepting orders. |

---

## C. Contract deployment to Base mainnet (the "variables" you asked about)

| # | Item | Status | Notes |
|---|---|---|---|
| C1 | Deploy **InputSettlerEscrow** to Base mainnet | ❌ | Via the (B1-updated) deploy script with `SWAP_NETWORK=mainnet`. |
| C2 | Deploy **OranjAttestorOracle** to Base mainnet | ❌ | owner = cold key, attestor = hot key (see D2). |
| C3 | Wire deployed addresses into mainnet `.env` | ❌ | `ESCROW_ADDRESS`, `ORACLE_ADDRESS`, `ESCROW_START_BLOCK`, `WBTC_ADDRESS=0x0555…`. |
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
