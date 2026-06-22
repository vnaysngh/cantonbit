# Swap Quote Design — research + target architecture

How to produce the best-possible swap quote for **cross-chain (WBTC↔CBTC HTLC)** and
**same-chain (CBTC↔CC C2C)**, benchmarked against CoW Swap, 1inch Fusion(+), and
UniswapX, and grounded in what the Canton Network / Splice / Global Synchronizer
actually provide.

## Context — why this doc

The quote is the product. A wrong or stale quote either loses the user money or
drains the settlement vault. This captures (a) how the current code quotes, (b) how
the best apps do it, (c) the hard Canton constraints, and (d) a concrete, prioritized
plan to close the gap — across the four dimensions the user prioritized: **price
source quality, the quoted-vs-executed gap, the cross-chain rate, and quote UX/honesty.**

---

## 1. The single most important constraint (Canton reality)

**Canton has NO protocol-native price oracle, AMM, or RFQ standard.** The Token
Standard (CIP-56/0112) provides only *atomic settlement* (Allocations + DvP);
pricing/quoting is explicitly the application's responsibility. The only on-ledger
price is **`amuletPrice` (CC/USD)** on `OpenMiningRound` — a **median of
Super-Validator submissions, stepped at ~10-minute round granularity** — a
*fee-accounting* rate, **not a tradeable market quote** (CIP-0079 will move it to a
~1-min Kaiko feed later).

Implications we must design around:
- **We own the quote engine.** The chain gives settlement + one lagged reference
  price (CC/USD). BTC/USD, CBTC/CC, WBTC/BTC, spread, slippage, expiry are all ours.
- Every real Canton DEX (Cantex AMM, Temple CLOB, Tradecraft, CantonSwap) prices
  off-ledger and uses the chain only for atomic DvP — exactly our model.
- The canonical Canton "quote→settle" = **quote off-ledger → write fixed leg amounts
  into the Allocation/transfer → settle atomically before the deadline.** Quote
  expiry = settlement deadline. (CIP-0112 adds committed allocations for firm RFQ.)
- **CBTC is 1:1 BTC by construction** (DLC/BitSafe mint-burn). So WBTC↔CBTC is
  fundamentally a **WBTC/BTC rate ≈ 1 ± peg, minus spread** — not an arbitrary pair.

Sources: docs.sync.global token-standard index (pricing left to app), AllocationV1
interface (no price field), Splice AmuletRules / tokenomics (10-min rounds, median
voting), CIP-0079 (Kaiko feed), Cantex/Temple/CantonSwap ecosystem docs, BitSafe CBTC
+ Chainlink BTC/USD.

---

## 2. How the best apps quote (distilled)

| Technique | CoW | 1inch Fusion(+) | UniswapX | Take for us |
|---|---|---|---|---|
| **Quote = floor, not firm scalar** | quoted = *worst* price; surplus → user | Dutch curve start→floor | signed `{start, floor, decay, deadline}` | **Adopt: the quoted number is the user's guaranteed minimum.** |
| **Fold ALL costs into the out-amount** | gas + protocol fee in quote | gas paid by resolver, in curve | gas folded, gas-free for user | **Adopt: one net "you receive" number** (platform fee already is; add network fee). |
| **Dutch-auction decay** | (batch instead) | fast ~3 min / fair ~6 min | linear, ~clamped | **Defer for v1.** Keep short-TTL floor quotes until solver competition needs it. |
| **Short expiry / exclusivity** | `validTo` | 3–6 min auctions | ~24s (2 blocks) exclusive then open | **Adopt: short firm-quote TTL; exclusive winner then open.** |
| **Enforce floor in the settlement contract** | limit price, revert | HTLC minReturn | Reactor reverts < minOut | **Adopt: settle reverts/refunds below minOut.** |
| **Price improvement → user, monetize the surplus** | 50% of improvement capped ~0.98% | — | — | **Consider later** (needs solver competition). |
| **Cross-chain: 2-escrow HTLC + safety deposit + staged timelocks** | — | EscrowSrc/Dst, finality→exclusive→public→cancel, 3rd-party cleanup bonded | bonded optimistic | **Adopt the staged-timelock + cleanup-incentive shape** (we already have most). |

**The guarantee to copy (both contexts):** *"You receive **at least** X; if the market
is better at fill you get more; if no one can fill at ≥X before expiry, nothing happens
and you keep your funds."* Replace the slippage slider with a hard floor.

---

## 3. Current state (what we have) — and the gaps

### Cross-chain HTLC (`lib/htlc-quote.ts`) — hardened for v1
- RFQ shape: `out = in × P × (1−fee)`, P = WBTC/BTC; fee folded into output. ✓
- Sources: CoinGecko + Binance cross-check; 30s fresh cache, 90s max-stale serve, else refuse (no silent 1.0). ✓
- Depeg breaker (|P−1|>2% → refuse). ✓
- `QUOTE_TTL_SECONDS=60`; `assertOrderAmounts` re-quotes at create with `ORDER_AMOUNT_TOLERANCE_BPS=30`. ✓
- Settlement-time floor: `assertHtlcSettlementQuoteFresh` re-quotes before solver value is locked/delivered (forward managed CBTC HtlcLock, forward Loop reveal/delivery, reverse WBTC counter-lock). ✓
- Quote response exposes source, age, stale flag, mid price, min-received floor, and expiry. ✓
- **Remaining gap:** no Dutch decay; this is intentionally deferred for v1.

### Same-chain C2C (`lib/canton-swap-quote.ts`, `canton-quote.ts`, `canton-quote-sanity.ts`) — strong, metadata/freshness hardened
- Tradecraft AMM (`/quoteForFixedInput`) is the executable price; 20s cache. ✓
- **Independent sanity cross-check**: Tradecraft vs `amuletPrice × BTC/USD`, 300bps band mainnet (10% devnet) → refuse if off. ✓ (this is the model the HTLC path lacks)
- `assertSettlementQuoteFresh`: re-quote at settle, enforce `minOut` floor + `SETTLEMENT_SLIPPAGE_BPS=50`. ✓
- Shared freshness helper now covers Tradecraft, BTC/USD, and amulet/CC reference pricing; Tradecraft serves only bounded stale quotes and then refuses. ✓
- `amuletPrice` has an absolute clamp (`AMULET_PRICE_MIN_USD`/`AMULET_PRICE_MAX_USD`, default 0.0005–5 USD/CC). ✓
- Quote response exposes source, age, stale flag, gross mid price, min-received floor, expiry, and devnet indicative labeling. ✓
- **Remaining gap:** devnet C2C still uses mainnet Tradecraft pricing, so the UI/API labels it indicative.

### Shared
- Price sources now use one bounded freshness helper (`lib/price-cache.ts`) for fresh cache → bounded stale + alert → refuse. ✓
- Quote APIs now carry `{source, ageMs, stale, mid, minReceived, expiresAt}` metadata for honest display. ✓

---

## 4. Target architecture (the plan)

Ranked by impact, scoped to keep the proven pieces and only add what's missing.

### P1 — Cross-chain: add a settlement-time floor + sanity cross-check (implemented)
The cross-chain time gap is where users/solvers get hurt. Mirror C2C's two guards on the HTLC path:
1. **`assertHtlcSettlementQuoteFresh`** re-quotes WBTC/BTC immediately before solver value is locked/delivered and enforces the quoted output as the user's floor.
2. **HTLC source cross-check** requires CoinGecko and Binance WBTC/BTC to agree within `HTLC_WBTC_BTC_SOURCE_SANITY_BPS` (default 100bps) and still applies the 2% depeg breaker.

### P2 — Price source quality (implemented)
- **Unified freshness policy** in `lib/price-cache.ts`: source fallback/check → fresh cache → bounded stale-serve + alert → refuse.
- **Clamped `amuletPrice`** to a configurable absolute band before it can affect quote sanity or network-fee math.
- **Executable-price cross-check parity**: C2C keeps Tradecraft-vs-reference sanity; HTLC now cross-checks WBTC/BTC sources before quote/create/settlement.

### P3 — Cross-chain rate quality: optional Dutch-auction quote (deferred)
Today the HTLC quote is one firm number for a multi-minute window → the solver must
either widen the spread or risk being picked off. Adopt a **bounded Dutch curve** for
the cross-chain quote: return `{startRate (user-favorable), minOut (floor), decayFn,
auctionDeadline}` with **"fast ~90s / fair ~5min"** presets (1inch model). The solver
fills when profitable, competition pulls the fill toward the start. The user's floor is
`mid − (peg + inventory σ√T + gas + finality + option premium)`. This is the biggest
*quote-quality* upgrade but the largest change (touches quote shape + daemon fill
logic + UI) — explicitly deferred for now. Reuse the existing staggered-timelock HTLC +
auto-refund (we already have the Fusion+ "staged timelock + cleanup" shape).

### P4 — Quote UX / honesty (implemented)
- Quote response (both routes) returns `{source, ageMs, stale, midPrice, minReceived, expiresAt, feeBps, networkFeeCc}` while preserving existing fields.
- UI (`app/swap/page.tsx` ReviewModal) shows **"You receive at least X"**, quote source + age, quote expiry, and quote notes.
- Devnet C2C quotes are labeled indicative because they still use mainnet Tradecraft pricing.

---

## 5. What NOT to change (keep)
- The RFQ `out = in×P×(1−fee)` core and fee-folded-into-output. ✓
- Depeg breaker, refuse-don't-fallback on price failure. ✓
- C2C Tradecraft + independent sanity cross-check + settlement re-quote floor. ✓ (replicate to HTLC, don't replace.)
- Integer base-unit math (`lib/amount-units.ts`), no floats in the value path. ✓
- Atomic-settle / staggered-timelock HTLC + auto-refund (the Fusion+ pattern). ✓

---

## 6. Verification (per phase)
- **Unit:** quote math (floor + fee + decay), sanity-band rejection (primary vs reference > band → throw), freshness helper (fresh/stale/refuse), amulet clamp. Add fixtures like the existing `htlc-quote-math.test.ts`.
- **DevNet E2E:** a CBTC↔CC and a WBTC↔CBTC quote → create → settle, asserting the settlement-time floor blocks an adverse move and the user never receives < minOut.
- **Reconcile:** log quoted vs executed out-amount on settle to confirm "≥ quote" holds.

## 7. Open decisions for the user
1. **Dutch auction (P3)** — deferred. Revisit only when solver competition/free-option pricing becomes the bottleneck.
2. **Price-improvement/surplus model** — pass surplus to the user (CoW-style) and monetize a capped cut, or keep the fixed-spread model?
3. **Additional WBTC/BTC source** — optional hardening beyond CoinGecko + Binance (Coinbase/Kraken/Chainlink on Base).

---

## Sources (key)
Canton: docs.sync.global token-standard index, AllocationV1, AmuletRules, tokenomics
(10-min rounds), Scan `/v0/open-and-issuing-mining-rounds`, CIP-0079 (Kaiko), CIP-56/0112.
DEX: CoW orderbook API + competition rules + price-improvement + fees; 1inch Fusion
deep-dive + Fusion+ cross-chain-swap repo; UniswapX whitepaper + DutchDecayLib + auction
types; 0x/Cube RFQ. Ecosystem: Cantex, Temple, CantonSwap, BitSafe CBTC + Chainlink.
