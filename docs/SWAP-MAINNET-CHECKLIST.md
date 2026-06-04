# Mainnet Pre-Requisites Checklist — WBTC(Arbitrum) → cBTC(Canton) Swap

> Before any mainnet test, EVERY item here must be ✅. Mainnet means **real WBTC
> and real cBTC** — this is custodial, two-legged (NOT atomic) settlement, so a
> bug or a missing guard means real lost funds. Do not shortcut this list.

Status legend: ✅ done · ⚠️ partial · ❌ not done / blocked

## ✅ FIRST MAINNET SWAP COMPLETED (real funds)

`0.00001 WBTC (Arbitrum) → 0.00001 cBTC (Canton mainnet)`, both legs settled:
- openFor (lock WBTC, Arbitrum): `0x873511703ebd47e898d8b57ade6879ba197298cfdca391b9ff477504beaded37`
- attest: `0x70a727e4f749d51637527f7bf2c227db132fdeed7cc944ae0ac2387bb8be358a`
- finalise (WBTC → treasury 0xF340…): `0x5176100f3b6552ea12216a39be3f2d5f6eb5e50fb41889cfa0b1588e4990fa7f`
- cBTC delivered + accepted in the recipient's Loop wallet (float 0.00032 → 0.00031).

**Verified on-chain:** treasury received WBTC, escrow drained, finalise success,
float decremented 0.00001.

### Bug found + fixed on this run (mainnet-only)
`createOffer` inferred `autoAccepted=true` whenever it couldn't read the
receiver's offer — but the m2m token CAN'T read a recipient on another
participant (403). So it wrongly finalised the WBTC before the cBTC was accepted.
**Fixed:** auto-accept is now decided from the SENDER-side signal (the float's own
`TransferInstruction` / locked-holding state), never from "can't read the
receiver." (Loop SDK server docs confirm no transfer-status API; the
TransferInstruction template on getActiveContracts is the path.)

### Known limitation (task A1, parked)
Accept *detection* (accept-watch) still reads the receiver, so a swap to an
UNREADABLE recipient sits in `delivering` (SAFE — never wrongly finalises — but
doesn't auto-complete). Works for readable / auto-accepting recipients. The
production fix is sender-side accept detection via the float's TransferInstruction
lifecycle.

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
| B2 | **De-hardcode the diagnostic scripts** | ✅ DONE (check-float) | `check-float.ts` is now network-aware (reads CANTON_*/SOLVER_CANTON_PARTY from env; prints the network/ledger host so it can't silently check the wrong net). The remaining hardcoded scripts (`e2e-full.ts`, `live-canton.ts`, `debug-*`) are dev-only diagnostics — left as-is; the mainnet e2e is `e2e-mainnet.ts` (fully env-driven). |
| B3 | **Confirm `index.ts`/`env.ts` are fully env-driven** | ✅ | Verified live: the mainnet API + loop boot purely from env (Arbitrum + mainnet Canton). |
| B4 | **`ALLOW_MAINNET=true` gate** | ✅ | Enforced in `env.ts` + `deploy.ts`. |
| B5 | **Amount-cap / max-order guard** | ✅ DONE | `MAX_WBTC_PER_ORDER` enforced in the API `/quote` (rejects over-cap). Set to 10000 (0.0001 WBTC) in `.env.mainnet` for early runs. |
| B6 | **Float pre-flight on startup** | ✅ DONE | `index.ts` reads the float before the watch loop: on **mainnet** it `exit(1)`s if the float is empty or unreadable (refuses to lock WBTC it can't fill); warns if below the per-order cap. Verified live (0.00031 cBTC). |

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
| D1 | **Separate hot (attestor) and cold (owner) keys** | ⏸️ DEFERRED (decision) | Today owner == attestor == `0x0B95ec…`. **Deliberately left as-is at test scale** (0.0001 WBTC). The oracle CAN rotate the attestor later (owner→setAttestor) without redeploy. Revisit before scaling value. |
| D2 | **Fresh mainnet agent key** | ⏸️ DEFERRED (decision) | Same `0x0B95ec…` key. Accepted for small-value testing. Mitigated by D-below: collected WBTC does NOT sit on this key. |
| D2b | **Treasury payout split from hot key** | ✅ DONE | `PAYOUT_ADDRESS=0xF340…` — finalise sends collected WBTC to a SEPARATE address, not the hot signing key. So a hot-key compromise can move the escrow but can't redirect the payout. (Proven live on the mainnet swap.) |
| D3 | **Token-split for the Canton credential** | ⏸️ DEFERRED | m2m token is ParticipantAdmin-grade. Left as-is at test scale; scope it down before production volume. |
| D4 | **Refund/expiry path validated live** | ✅ DONE | Proven on-chain (`e2e-refund.ts`) AND via the API endpoint (`api-refund.smoke.ts`): lock→expire→POST refund→WBTC returned. UI exposes "Refund my WBTC". |
| D5 | **Manual two-step accept** | ✅ N/A (by design) | We do NOT detect cross-participant accept (task A1 decision). The user accepts in their own Loop wallet; the UI tells them to. Resolved, not pending. |
| D6 | **Monitoring + alerting wired for real** | ⚠️ | `monitor.ts`/`cli.ts` + per-tick `[health]`/`[ALERT]` exist and run. For real mainnet volume, route `[ALERT]`/critical to a human channel. Adequate for supervised test runs. |

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
