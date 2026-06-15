# CBTC Swap-Farming Fleet — Guide

A runbook for generating **legitimate CBTC usage volume** on our own Canton validator by
running a fleet of parties that continuously execute **real CC↔CBTC swaps** through the
production atomic-settle engine (`settleManagedSwap`). Every swap moves CBTC, so every swap
counts as a "farming" transaction.

> This guide is the standalone farming runbook. The broader Canton-swap/HTLC design lives in
> the plan file (`~/.claude/plans/typed-tinkering-crab.md`) — not here.

---

## 0. Why & the honest caveats (read first)

**Why:** BitSafe shares part of the network reward they earn from CBTC being used. More real
CBTC swap volume → more reward to share.

**⚠️ Eligibility (the real risk — confirm before mainnet scale):** self-generated swap volume
must be **eligible** for the BitSafe reward share. Canton DSO / featured-app governance watches
for wash/sybil activity. Making it "look organic" helps with load realism, but it does **not**
protect against an *eligibility clawback* — obfuscation is the pattern such systems flag, not a
defense. **Confirm with BitSafe that bot-driven CBTC swap volume counts toward the shared reward
before running at scale on mainnet.** DevNet is risk-free; treat mainnet as gated on this.

**⚠️ More parties ≠ more budget.** Every fleet party's transactions are sequenced by our ONE
validator and share its ONE traffic bucket (~400 KB free + ~333 B/s refill). 10 parties give
**realistic distribution**, not 10× throughput.

**⚠️ Mainnet has no extra-traffic bucket** (`total_limit = 0` as of 2026-06-15). On mainnet the
bot must stay strictly within the free refill or swaps get **rejected** (no paid fallback). The
mainnet command is guarded behind `--i-understand-mainnet`.

---

## 1. How a farming swap works (the topology)

`settleManagedSwap` **requires the sender's leg to arrive as a pending OFFER, not a direct
transfer** (it throws otherwise — `lib/canton-swap-settle.ts`). So swaps are **not** symmetric
peer-to-peer. Two role types:

| Role | Count | Preapproval | Holds | Position in a swap |
| --- | --- | --- | --- | --- |
| **Trader** | N (e.g. 10) | CC **and** CBTC (so counter legs land direct/instant) | CC + CBTC float | always the **sender** |
| **Vault** | ≥1 (reuse settlement party) | **NONE** (so sender's leg is an offer it accepts) | CC + CBTC float | always the **counterparty** |

**One farming swap (1 atomic tx):**
```
random trader  --(offer: inAmount of asset X)-->  vault
vault          --(accept X  +  deliver outAmount of asset Y, ATOMIC, actAs:[trader,vault])-->  trader
```
Direction (CC→CBTC or CBTC→CC) and amount are randomized per swap. Both legs commit or the whole
tx reverts.

---

## 2. Prerequisites

1. **m2m JWT creds in env** (loaded by `scripts/with-env.sh <net>` from `.env.<net>` + `.env.local`):
   `KEYCLOAK_TOKEN_URL`, `KEYCLOAK_CLIENT_ID[_DEVNET]`, `KEYCLOAK_CLIENT_SECRET[_DEVNET]`,
   `KEYCLOAK_SCOPE`, `NEXT_PUBLIC_NETWORK`. (Secrets live in `.env.<net>` — never commit/log them.)
2. **Treasury party with CC + CBTC float** to seed the fleet: `SOLVER_CANTON_PARTY` (a.k.a.
   `NEXT_PUBLIC_SOLVER_CANTON`). Fund it first if empty (`npm run fund-swap-vault:devnet`).
3. **A vault counterparty with NO preapproval:** reuse `CANTON_SWAP_SETTLEMENT_PARTY` (already
   provisioned preapproval-free) or let the provision script allocate a dedicated farm vault.
4. **`.farm-fleet.json` must be gitignored.** The repo's `.gitignore` covers `.env*` but **not**
   `.farm-fleet.json` — add it (see §6) before the first provision run; it holds fleet party ids.

---

## 3. One-time: provision the fleet

Script: `scripts/provision-farm-fleet.mts` (idempotent — re-runnable; same hint → same party).
It allocates N trader parties (`POST /v2/parties` + `CanActAs` grant), enables CC **and** CBTC
preapproval on each, funds each with CC + CBTC from the treasury, and writes the fleet to
`.farm-fleet.json`. It also asserts the vault has **no** preapproval and funds the vault float.

```bash
# DevNet — start small to prove it out
npm run provision-farm-fleet:devnet -- --traders=2 --cc=1000 --cbtc=0.01

# DevNet — full fleet
npm run provision-farm-fleet:devnet -- --traders=10 --cc=5000 --cbtc=0.05
```

Flags: `--traders=<N>` · `--cc=<amt per trader>` · `--cbtc=<amt per trader>` ·
`--vaults=<N>` (default 1, or reuse settlement party).

Verify: `npm run party-balances:devnet` — each trader has CC + CBTC, the vault has float, and the
vault shows **no** preapproval.

---

## 4. Run the farm bot

Script: `scripts/farm-swaps.mts`. Each loop iteration = one CC↔CBTC atomic swap. Paced to fill
the bucket, jittered to look organic.

```bash
# DevNet dry-run — prints chosen traders/dirs/amounts, mean interval, projected bytes/CC; sends nothing
npm run farm-swaps:devnet -- --dry-run --max-swaps=5

# DevNet — 5 real swaps (use this to MEASURE real bytes/swap, see §5)
npm run farm-swaps:devnet -- --max-swaps=5

# DevNet — run continuously
npm run farm-swaps:devnet -- --max-swaps=0

# Mainnet — guarded; stays within the free refill only
npm run farm-swaps:mainnet -- --i-understand-mainnet --max-swaps=0
```

Flags:
- `--max-swaps=<N>` — total swaps (`0` = until Ctrl-C).
- `--target-utilization=<0..1>` — fraction of the free refill to use (default `0.8`).
- `--min-amount` / `--max-amount` — CBTC amount band (e.g. `0.00005`–`0.002`).
- `--i-understand-mainnet` — required for the mainnet command.
- `--dry-run` — plan only, no ledger writes.

**What it does each tick:** picks a random trader + random vault + random direction + random
amount (varied decimals) → quotes the counter amount → checks both floats + the trader's UTXO
count (< 8) → `settleManagedSwap(syntheticOrder)` (one atomic tx) → sleeps a jittered interval →
backs off on traffic rejections.

---

## 5. Pacing & budget (how fast, and why)

- **Per-swap cost:** a CC↔CBTC swap is a 2-leg atomic tx, budget **~15–25 KB/swap** (MEASURE it,
  below — don't trust the estimate).
- **Free bucket:** ~400 KB cap, **~333 B/s** refill (DSO-governed; confirm live via Scan
  `amulet-rules → fees.baseRateTrafficLimits`).
- **At ~20 KB/swap, `--target-utilization=0.8`:** mean interval ≈ **~75 s/swap**, jittered ±40%
  (≈ 45–105 s), with occasional longer "quiet" gaps and short "busy" bursts so it isn't a
  metronome. That's roughly **~1,450 swaps/day, ~0 CC** on the free tier.
- Going faster than the refill on mainnet (where `total_limit=0`) → rejected swaps. The bot
  auto-throttles down when it sees rejections.

**Measure real bytes/swap (do this once on DevNet):**
1. Read `total_consumed` from Lighthouse (no auth):
   - DevNet: `https://lighthouse.devnet.cantonloop.com/api/validators/<warpx-devnet-party>`
   - Mainnet: `https://lighthouse.cantonloop.com/api/validators/<warpx-mainnet-party>`
   - field: `traffic_status.total_consumed`
2. Run `npm run farm-swaps:devnet -- --max-swaps=5`.
3. Read `total_consumed` again → `(after − before) / 5` = **real bytes/swap**. Plug that into
   `--target-utilization` math (the bot also logs the drawdown every K swaps to self-calibrate).

---

## 6. Monitoring

- **Traffic drawdown:** Lighthouse `traffic_status.{total_limit, total_consumed}` (above).
- **Balances / UTXO counts:** `npm run party-balances:devnet` — confirm trader/vault floats move,
  balances don't drain one-sided (the bot varies direction 50/50 + tops up), and no party nears
  the **10-UTXO cap** (consolidate/skip kicks in at 8).
- **Container logs:** Dozzle (your existing app) — watch for "rejected event — traffic" lines.
- **Per-swap confirmation:** each `updateId` is visible on Lighthouse `transactions`.

**Gitignore (one-time):** add `.farm-fleet.json` to `.gitignore` so fleet party ids aren't
committed.

---

## 7. Tuning & operations

- **Fill the bucket more:** raise `--target-utilization` toward `0.9`+ (watch for rejections).
- **Burn CC for more volume (mainnet):** out of scope here — would require enabling the
  validator's CC-funded traffic top-up. Only worth it if the BitSafe reward share > traffic CC
  cost (~$60/MB). Decide deliberately.
- **Rebalance:** if a trader or the vault runs low, top it up from treasury
  (`fund-swap-vault`-style transfer). The bot does periodic top-ups, but a long run may still
  drift — check balances.
- **Look organic:** keep amounts in a band with varied decimals (no round numbers), keep the
  jitter + busy/quiet rhythm, rotate all traders. Avoid: fixed amount, fixed cadence, single pair.

---

## 8. Reuse map (what the scripts are built on — for maintainers)

| Need | Function / location |
| --- | --- |
| Allocate party + grant CanActAs | `allocateParty` / `grantCanActAs` — `scripts/provision-settlement-party.mts`; `allocateUserParty` — `lib/party-onboarding.ts` |
| Execute one atomic swap | `settleManagedSwap(order)` — `lib/canton-swap-settle.ts`; `CantonSwapOrder` — `lib/canton-swap-types.ts` |
| Quote counter amount | `quoteCantonToCanton` — `lib/canton-quote.ts` |
| Enable preapproval | `enableCcForParty` — `lib/enable-cc.ts`; `enableCbtcPreapprovalForParty` — `lib/enable-cbtc-preapproval.ts` (checks: `hasCcEnabled` / `hasCbtcPreapproval`) |
| Holdings / funding | `getHoldings` / `holdingsForSwapAsset`; `buildTransferExercise` + `submitLedgerCommands` — `lib/transfer.ts` |
| JWT / network | `getLedgerJwt` — `lib/auth.ts`; host + instrument from `NETWORK` — `lib/constants.ts` |

---

## 9. Status

- [ ] Add `.farm-fleet.json` to `.gitignore`
- [ ] `scripts/provision-farm-fleet.mts` (+ `provision-farm-fleet:devnet` npm script)
- [ ] `scripts/farm-swaps.mts` (+ `farm-swaps:devnet` / `farm-swaps:mainnet` npm scripts)
- [ ] DevNet: provision 2 traders → 1 real swap settles → measure bytes/swap
- [ ] DevNet: full 10-trader run, confirm pacing stays in-bucket
- [ ] Confirm reward eligibility with BitSafe **before** mainnet
