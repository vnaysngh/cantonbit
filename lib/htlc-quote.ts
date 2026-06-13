/**
 * HTLC quote engine — industry-standard RFQ shape, both directions.
 *
 * Model (what 0x RFQ / 1inch Fusion / Cancore-style venues do, minimal version):
 *   quote = mid price × (1 − fee), with a short TTL and a de-peg circuit breaker.
 *
 * Assets: CBTC is 1:1 BTC by construction (DLC-backed). WBTC is NOT exactly 1:1 —
 * it trades at a small premium/discount. So the live WBTC/BTC rate P matters, and
 * it must be applied DIRECTIONALLY:
 *   wbtc → cbtc : cbtcOut = wbtcIn × P × (1 − fee)     (P = BTC per 1 WBTC)
 *   cbtc → wbtc : wbtcOut = cbtcIn ÷ P × (1 − fee)
 *
 * Price source: CoinGecko WBTC-in-BTC (no API key). Cached 30s server-side; served
 * up to 90s stale on source failure (ops alert); beyond that we REFUSE to quote (no
 * silent 1.0 fallback — a wrong price is worse than no quote). De-peg breaker:
 * |P−1| > 2% → refuse (protects both sides from quoting through a WBTC depeg event).
 */
import "server-only";

import { alert } from "./alert";
import { DEFAULT_PLATFORM_FEE_BPS } from "./constants";

/** Output-side platform fee (bps). Override with PLATFORM_FEE_BPS env. */
export const BRIDGE_FEE_BPS = Number(
  process.env.PLATFORM_FEE_BPS ?? DEFAULT_PLATFORM_FEE_BPS
);
export const QUOTE_TTL_SECONDS = 60; // RFQ-style short validity (NOT the order window)
const DEPEG_LIMIT_BPS = 200; // 2% — refuse to quote beyond this
const CACHE_FRESH_MS = 30_000;
/** Max age we'll serve a cached price when the source is down. Kept SHORT (90s) so
 *  a fast depeg starting right after a fetch failure can't be missed by the peg
 *  breaker — a 10-min-stale price that still looks pegged IS a wrong price. Beyond
 *  this we refuse to quote rather than risk filling through a move. */
const CACHE_MAX_STALE_MS = 90_000;
const PRICE_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=wrapped-bitcoin&vs_currencies=btc&precision=8";

/** P scaled to 8dp (1e8 = exactly 1 BTC per WBTC). */
let cached: { price8: bigint; at: number } | null = null;

export class QuoteUnavailableError extends Error {}
export class DepegError extends Error {}

/** Live WBTC/BTC price, 8dp-scaled bigint. Throws QuoteUnavailableError/DepegError. */
export async function getWbtcBtcPrice8(): Promise<bigint> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_FRESH_MS)
    return checkPeg(cached.price8);
  try {
    const r = await fetch(PRICE_URL, {
      cache: "no-store",
      signal: AbortSignal.timeout(5000)
    });
    if (!r.ok) throw new Error(`price source ${r.status}`);
    const j = (await r.json()) as { "wrapped-bitcoin"?: { btc?: number } };
    const p = j["wrapped-bitcoin"]?.btc;
    if (!p || !Number.isFinite(p) || p <= 0)
      throw new Error("bad price payload");
    cached = { price8: BigInt(Math.round(p * 1e8)), at: now };
    return checkPeg(cached.price8);
  } catch (e) {
    // Serve stale within bounds; otherwise refuse — never silently assume 1.0.
    if (cached && now - cached.at < CACHE_MAX_STALE_MS) {
      // Alert: we're quoting on a stale price because the source is unreachable.
      // Ops should know — a sustained outage means quotes are flying blind to drift.
      void alert("warn", "WBTC/BTC price source down — serving stale price", {
        ageMs: now - cached.at,
        reason: e instanceof Error ? e.message : String(e),
      });
      return checkPeg(cached.price8);
    }
    throw new QuoteUnavailableError(
      `WBTC/BTC price unavailable (${e instanceof Error ? e.message : e}) — refusing to quote`
    );
  }
}

function checkPeg(price8: bigint): bigint {
  const dev =
    price8 > 100_000_000n ? price8 - 100_000_000n : 100_000_000n - price8;
  if (dev * 10000n > BigInt(DEPEG_LIMIT_BPS) * 100_000_000n) {
    throw new DepegError(
      `WBTC/BTC at ${Number(price8) / 1e8} — outside the ${DEPEG_LIMIT_BPS}bps peg band, quoting paused`
    );
  }
  return price8;
}

export interface QuoteResult {
  inUnits: bigint; // input, 8dp base units
  outUnits: bigint; // output after price + fee, 8dp base units
  price8: bigint; // WBTC/BTC used, 8dp
  feeBps: number;
  expiresAt: number; // unix seconds — quote validity (TTL), not the order window
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
    inUnits,
    outUnits,
    price8,
    feeBps: BRIDGE_FEE_BPS,
    expiresAt: Math.floor(Date.now() / 1000) + QUOTE_TTL_SECONDS
  };
}

/** Slack the server allows between the order's claimed output and a FRESH quote.
 *  This is a DRIFT BUFFER ONLY — the platform fee is already subtracted inside the
 *  quote (`finish` → `fresh.outUnits` is net of fee), so the tolerance covers just
 *  honest BTC/WBTC price movement between the user's quote and order submission
 *  (≤ the 60s quote TTL). It must NOT also "exceed the fee" — that would let a user
 *  reclaim the fee as a standing skim against solver float. 30bps comfortably
 *  covers 60s of normal drift while keeping that skim near zero. */
const ORDER_AMOUNT_TOLERANCE_BPS = 30;

/**
 * SERVER-SIDE order-amount validation (SECURITY): the user submits cbtcAmount +
 * wbtcAmount on the order. Re-quote NOW and reject if the user's output is more
 * favorable than a fresh quote by more than the tolerance — so a client can't
 * submit a manipulated/stale ratio that the solver then fills. The input side is
 * what the user actually locks; we check the OUTPUT (what the solver pays) isn't
 * inflated. Throws QuoteUnavailableError/DepegError (→ 503) on price failure.
 */
export async function assertOrderAmounts(
  direction: "evm-to-canton" | "canton-to-evm",
  wbtcUnits: bigint,
  cbtcUnits: bigint
): Promise<void> {
  // out = what the solver pays the user; in = what the user locks.
  const reverse = direction === "canton-to-evm";
  const inUnits = reverse ? cbtcUnits : wbtcUnits;
  const claimedOut = reverse ? wbtcUnits : cbtcUnits;
  if (inUnits <= 0n || claimedOut <= 0n)
    throw new Error("order amounts must be > 0");
  const fresh = reverse
    ? await quoteCbtcToWbtc(inUnits)
    : await quoteWbtcToCbtc(inUnits);
  // Allow the solver to be GENEROUS (claimedOut <= fresh is always fine); only
  // reject when the user demands MORE than a fresh quote + tolerance.
  const maxOut =
    fresh.outUnits +
    (fresh.outUnits * BigInt(ORDER_AMOUNT_TOLERANCE_BPS)) / 10000n;
  if (claimedOut > maxOut) {
    throw new Error(
      `order output ${claimedOut} exceeds a fresh quote ${fresh.outUnits} (+${ORDER_AMOUNT_TOLERANCE_BPS}bps) — re-quote and retry`
    );
  }
}
