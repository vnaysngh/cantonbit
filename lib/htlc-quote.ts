/**
 * HTLC quote engine — industry-standard RFQ shape, both directions.
 *
 * Model (what 0x RFQ / 1inch Fusion / Cancore-style venues do, minimal version):
 *   quote = mid price × (1 − fee), with a short TTL and a de-peg circuit breaker.
 *
 * Assets: cBTC is 1:1 BTC by construction (DLC-backed). WBTC is NOT exactly 1:1 —
 * it trades at a small premium/discount. So the live WBTC/BTC rate P matters, and
 * it must be applied DIRECTIONALLY:
 *   wbtc → cbtc : cbtcOut = wbtcIn × P × (1 − fee)     (P = BTC per 1 WBTC)
 *   cbtc → wbtc : wbtcOut = cbtcIn ÷ P × (1 − fee)
 *
 * Price source: CoinGecko WBTC-in-BTC (no API key). Cached 30s server-side; served
 * up to 10 min stale on source failure; beyond that we REFUSE to quote (no silent
 * 1.0 fallback — a wrong price is worse than no quote). De-peg breaker: |P−1| > 2%
 * → refuse (protects both sides from quoting through a WBTC depeg event).
 */
import "server-only";

export const BRIDGE_FEE_BPS = 20; // 0.2% on the output
export const QUOTE_TTL_SECONDS = 60; // RFQ-style short validity (NOT the order window)
const DEPEG_LIMIT_BPS = 200; // 2% — refuse to quote beyond this
const CACHE_FRESH_MS = 30_000;
const CACHE_MAX_STALE_MS = 10 * 60_000;
const PRICE_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=wrapped-bitcoin&vs_currencies=btc&precision=8";

/** P scaled to 8dp (1e8 = exactly 1 BTC per WBTC). */
let cached: { price8: bigint; at: number } | null = null;

export class QuoteUnavailableError extends Error {}
export class DepegError extends Error {}

/** Live WBTC/BTC price, 8dp-scaled bigint. Throws QuoteUnavailableError/DepegError. */
export async function getWbtcBtcPrice8(): Promise<bigint> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_FRESH_MS) return checkPeg(cached.price8);
  try {
    const r = await fetch(PRICE_URL, { cache: "no-store", signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`price source ${r.status}`);
    const j = (await r.json()) as { "wrapped-bitcoin"?: { btc?: number } };
    const p = j["wrapped-bitcoin"]?.btc;
    if (!p || !Number.isFinite(p) || p <= 0) throw new Error("bad price payload");
    cached = { price8: BigInt(Math.round(p * 1e8)), at: now };
    return checkPeg(cached.price8);
  } catch (e) {
    // Serve stale within bounds; otherwise refuse — never silently assume 1.0.
    if (cached && now - cached.at < CACHE_MAX_STALE_MS) return checkPeg(cached.price8);
    throw new QuoteUnavailableError(
      `WBTC/BTC price unavailable (${e instanceof Error ? e.message : e}) — refusing to quote`,
    );
  }
}

function checkPeg(price8: bigint): bigint {
  const dev = price8 > 100_000_000n ? price8 - 100_000_000n : 100_000_000n - price8;
  if (dev * 10000n > BigInt(DEPEG_LIMIT_BPS) * 100_000_000n) {
    throw new DepegError(`WBTC/BTC at ${Number(price8) / 1e8} — outside the ${DEPEG_LIMIT_BPS}bps peg band, quoting paused`);
  }
  return price8;
}

export interface QuoteResult {
  inUnits: bigint;       // input, 8dp base units
  outUnits: bigint;      // output after price + fee, 8dp base units
  price8: bigint;        // WBTC/BTC used, 8dp
  feeBps: number;
  expiresAt: number;     // unix seconds — quote validity (TTL), not the order window
}

/** wbtc → cbtc : out = in × P × (1 − fee). */
export async function quoteWbtcToCbtc(wbtcUnits: bigint): Promise<QuoteResult> {
  const price8 = await getWbtcBtcPrice8();
  const gross = (wbtcUnits * price8) / 100_000_000n;
  return finish(wbtcUnits, gross, price8);
}

/** cbtc → wbtc : out = in ÷ P × (1 − fee). */
export async function quoteCbtcToWbtc(cbtcUnits: bigint): Promise<QuoteResult> {
  const price8 = await getWbtcBtcPrice8();
  const gross = (cbtcUnits * 100_000_000n) / price8;
  return finish(cbtcUnits, gross, price8);
}

function finish(inUnits: bigint, gross: bigint, price8: bigint): QuoteResult {
  const outUnits = gross - (gross * BigInt(BRIDGE_FEE_BPS)) / 10000n;
  return {
    inUnits, outUnits, price8, feeBps: BRIDGE_FEE_BPS,
    expiresAt: Math.floor(Date.now() / 1000) + QUOTE_TTL_SECONDS,
  };
}
