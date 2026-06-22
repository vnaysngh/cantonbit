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
 * Price source: multiple independent WBTC/BTC public feeds. Cached 30s server-side;
 * served up to 90s stale on source failure (ops alert); beyond that we REFUSE to
 * quote (no silent 1.0 fallback — a wrong price is worse than no quote). De-peg
 * breaker: |P−1| > 2% → refuse (protects both sides from quoting through a WBTC
 * depeg event).
 */
import "server-only";

import { toBaseUnits } from "./amount-units";
import { DEFAULT_PLATFORM_FEE_BPS } from "./constants";
import {
  quoteGrossOutUnits,
  applyOutputFee,
  parsePlatformFeeBps
} from "./htlc-quote-math";
import {
  fetchWithFreshness,
  type PriceCacheEntry
} from "./price-cache";

/** Output-side platform fee (bps). Override with PLATFORM_FEE_BPS env. */
export const BRIDGE_FEE_BPS = parsePlatformFeeBps(
  process.env.PLATFORM_FEE_BPS,
  DEFAULT_PLATFORM_FEE_BPS
);
export const QUOTE_TTL_SECONDS = 60; // RFQ-style short validity (NOT the order window)
const DEPEG_LIMIT_BPS = 200; // 2% — refuse to quote beyond this
const WBTC_BTC_SOURCE_SANITY_BPS = Number(
  process.env.HTLC_WBTC_BTC_SOURCE_SANITY_BPS ?? "100"
);
if (
  !Number.isInteger(WBTC_BTC_SOURCE_SANITY_BPS) ||
  WBTC_BTC_SOURCE_SANITY_BPS <= 0 ||
  WBTC_BTC_SOURCE_SANITY_BPS > DEPEG_LIMIT_BPS
) {
  throw new Error(
    `HTLC_WBTC_BTC_SOURCE_SANITY_BPS must be an integer from 1 to ${DEPEG_LIMIT_BPS}`
  );
}
const CACHE_FRESH_MS = 30_000;
/** Max age we'll serve a cached price when the source is down. Kept SHORT (90s) so
 *  a fast depeg starting right after a fetch failure can't be missed by the peg
 *  breaker — a 10-min-stale price that still looks pegged IS a wrong price. Beyond
 *  this we refuse to quote rather than risk filling through a move. */
const CACHE_MAX_STALE_MS = 90_000;
/** P scaled to 8dp (1e8 = exactly 1 BTC per WBTC). */
interface WbtcBtcPrice {
  price8: bigint;
  source: string;
}
let cached: PriceCacheEntry<WbtcBtcPrice> | null = null;

export class QuoteUnavailableError extends Error {}
export class DepegError extends Error {}

async function fetchJson(url: string, headers?: Record<string, string>): Promise<unknown> {
  const r = await fetch(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(5000),
    headers: {
      Accept: "application/json",
      "User-Agent": "OranjSwap/1.0",
      ...headers
    }
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

function parsePositive(raw: unknown): number | null {
  const p =
    typeof raw === "number"
      ? raw
      : typeof raw === "string"
        ? Number.parseFloat(raw)
        : Number.NaN;
  if (!Number.isFinite(p) || p <= 0) return null;
  return p;
}

async function tryCoinGeckoWbtcBtc(): Promise<number | null> {
  const key = process.env.COINGECKO_API_KEY?.trim();
  const url = key
    ? "https://pro-api.coingecko.com/api/v3/simple/price?ids=wrapped-bitcoin&vs_currencies=btc&precision=8"
    : "https://api.coingecko.com/api/v3/simple/price?ids=wrapped-bitcoin&vs_currencies=btc&precision=8";
  const j = (await fetchJson(url, key ? { "x-cg-pro-api-key": key } : undefined)) as {
    "wrapped-bitcoin"?: { btc?: number };
  };
  return parsePositive(j["wrapped-bitcoin"]?.btc);
}

/** BTC per 1 WBTC from Binance spot ratio (Railway-friendly fallback). */
async function tryBinanceWbtcBtc(): Promise<number | null> {
  const [wbtcJ, btcJ] = await Promise.all([
    fetchJson("https://api.binance.com/api/v3/ticker/price?symbol=WBTCUSDT"),
    fetchJson("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT")
  ]);
  const wbtc = parsePositive((wbtcJ as { price?: string }).price);
  const btc = parsePositive((btcJ as { price?: string }).price);
  if (wbtc == null || btc == null) return null;
  return wbtc / btc;
}

/** BTC per 1 WBTC from Kraken spot ratio. */
async function tryKrakenWbtcBtc(): Promise<number | null> {
  const j = (await fetchJson(
    "https://api.kraken.com/0/public/Ticker?pair=WBTCUSD,XBTUSD"
  )) as {
    error?: string[];
    result?: Record<string, { c?: [string, ...string[]] }>;
  };
  if (j.error?.length) throw new Error(j.error.join(", "));
  const result = j.result ?? {};
  let wbtcUsd: number | null = null;
  let btcUsd: number | null = null;
  for (const [pair, ticker] of Object.entries(result)) {
    const last = parsePositive(ticker.c?.[0]);
    if (last == null) continue;
    const normalized = pair.toUpperCase();
    if (normalized.includes("WBTC")) {
      wbtcUsd = last;
    } else if (
      normalized.includes("XBT") ||
      (normalized.includes("BTC") && !normalized.includes("WBTC"))
    ) {
      btcUsd = last;
    }
  }
  if (wbtcUsd == null || btcUsd == null) return null;
  return wbtcUsd / btcUsd;
}

/** BTC per 1 WBTC from CoinPaprika's direct WBTC/BTC quote. */
async function tryCoinPaprikaWbtcBtc(): Promise<number | null> {
  const j = (await fetchJson(
    "https://api.coinpaprika.com/v1/tickers/wbtc-wrapped-bitcoin?quotes=BTC"
  )) as {
    quotes?: { BTC?: { price?: number | string } };
  };
  return parsePositive(j.quotes?.BTC?.price);
}

/** BTC per 1 WBTC from Coinbase's public exchange-rate endpoint. */
async function tryCoinbaseWbtcBtc(): Promise<number | null> {
  const j = (await fetchJson(
    "https://api.coinbase.com/v2/exchange-rates?currency=WBTC"
  )) as {
    data?: { rates?: { BTC?: string } };
  };
  return parsePositive(j.data?.rates?.BTC);
}

async function fetchWbtcBtcLiveChecked(): Promise<WbtcBtcPrice> {
  const sources: Array<{ name: string; fn: () => Promise<number | null> }> = [
    { name: "coingecko", fn: tryCoinGeckoWbtcBtc },
    { name: "kraken", fn: tryKrakenWbtcBtc },
    { name: "coinpaprika", fn: tryCoinPaprikaWbtcBtc },
    { name: "coinbase", fn: tryCoinbaseWbtcBtc },
    { name: "binance", fn: tryBinanceWbtcBtc }
  ];
  const settled = await Promise.allSettled(
    sources.map(async ({ name, fn }) => {
      try {
        return { name, price: await fn() };
      } catch (e) {
        throw new Error(`${name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    })
  );
  const valid: Array<{ name: string; price: number }> = [];
  const errors: string[] = [];
  for (const result of settled) {
    if (result.status === "rejected") {
      errors.push(
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason)
      );
      continue;
    }
    const { name, price } = result.value;
    if (price == null) {
      errors.push(`${name}: invalid payload`);
      continue;
    }
    valid.push({ name, price });
  }
  if (valid.length < 2) {
    throw new Error(
      `need two independent WBTC/BTC sources, got ${valid.length} (${errors.join("; ")})`
    );
  }

  const primary = valid.find((v) => v.name === "coingecko") ?? valid[0];
  for (const other of valid) {
    if (other.name === primary.name) continue;
    const diffBps =
      (Math.abs(other.price - primary.price) / primary.price) * 10000;
    if (diffBps > WBTC_BTC_SOURCE_SANITY_BPS) {
      throw new Error(
        `WBTC/BTC sources disagree: ${primary.name}=${primary.price}, ${other.name}=${other.price} (${diffBps.toFixed(1)}bps > ${WBTC_BTC_SOURCE_SANITY_BPS}bps)`
      );
    }
  }
  return {
    price8: BigInt(Math.round(primary.price * 1e8)),
    source: valid.map((v) => v.name).sort().join("+")
  };
}

function checkPegPrice(value: WbtcBtcPrice): WbtcBtcPrice {
  return { ...value, price8: checkPeg(value.price8) };
}

/** Live WBTC/BTC price with source/freshness metadata. */
export async function getWbtcBtcPrice(): Promise<{
  price8: bigint;
  source: string;
  ageMs: number;
  stale: boolean;
}> {
  try {
    const result = await fetchWithFreshness<WbtcBtcPrice>({
      cached,
      setCached: (entry) => {
        cached = entry;
      },
      sources: [
        {
          name: "wbtc-btc-cross-check",
          fetch: fetchWbtcBtcLiveChecked
        }
      ],
      freshMs: CACHE_FRESH_MS,
      maxStaleMs: CACHE_MAX_STALE_MS,
      alertTitle: "WBTC/BTC price source down — serving stale checked price",
      unavailableMessage: (reason) =>
        `WBTC/BTC price unavailable (${reason}) — refusing to quote`,
      validate: checkPegPrice
    });
    return {
      price8: result.value.price8,
      source: result.value.source,
      ageMs: result.ageMs,
      stale: result.stale
    };
  } catch (e) {
    if (e instanceof DepegError) throw e;
    throw new QuoteUnavailableError(
      e instanceof Error ? e.message : String(e)
    );
  }
}

/** Live WBTC/BTC price, 8dp-scaled bigint. Throws QuoteUnavailableError/DepegError. */
export async function getWbtcBtcPrice8(): Promise<bigint> {
  return (await getWbtcBtcPrice()).price8;
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
  source: string;
  ageMs: number;
  stale: boolean;
  feeBps: number;
  expiresAt: number; // unix seconds — quote validity (TTL), not the order window
}

/** wbtc → cbtc : out = in × P × (1 − fee). */
export async function quoteWbtcToCbtc(wbtcUnits: bigint): Promise<QuoteResult> {
  const price = await getWbtcBtcPrice();
  const gross = quoteGrossOutUnits("evm-to-canton", wbtcUnits, price.price8);
  return finish(wbtcUnits, gross, price);
}

/** cbtc → wbtc : out = in ÷ P × (1 − fee). */
export async function quoteCbtcToWbtc(cbtcUnits: bigint): Promise<QuoteResult> {
  const price = await getWbtcBtcPrice();
  const gross = quoteGrossOutUnits("canton-to-evm", cbtcUnits, price.price8);
  return finish(cbtcUnits, gross, price);
}

function finish(
  inUnits: bigint,
  gross: bigint,
  price: Awaited<ReturnType<typeof getWbtcBtcPrice>>
): QuoteResult {
  const outUnits = applyOutputFee(gross, BRIDGE_FEE_BPS);
  return {
    inUnits,
    outUnits,
    price8: price.price8,
    source: price.source,
    ageMs: price.ageMs,
    stale: price.stale,
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
export const HTLC_SETTLEMENT_SLIPPAGE_BPS = 50;

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

/**
 * Re-quote immediately before any solver value leg is locked or delivered. The
 * persisted quoted output amount is the user's floor. If the live checked quote is
 * below that floor, the order must not progress; existing timelock refund paths
 * unwind the user's locked leg instead of filling an unsafe stale quote.
 */
export async function assertHtlcSettlementQuoteFresh(params: {
  direction: "evm-to-canton" | "canton-to-evm";
  wbtcAmount?: string;
  cbtcAmount?: string;
  minOutUnits?: bigint;
}): Promise<void> {
  if (!params.wbtcAmount || !params.cbtcAmount) {
    throw new Error("order missing HTLC quote amounts");
  }
  const wbtcUnits = BigInt(params.wbtcAmount);
  const cbtcUnits = toBaseUnits(params.cbtcAmount, 8);
  const reverse = params.direction === "canton-to-evm";
  const inUnits = reverse ? cbtcUnits : wbtcUnits;
  const promisedOut = reverse ? wbtcUnits : cbtcUnits;
  if (inUnits <= 0n || promisedOut <= 0n) {
    throw new Error("order amounts must be > 0");
  }

  const fresh = reverse
    ? await quoteCbtcToWbtc(inUnits)
    : await quoteWbtcToCbtc(inUnits);
  const minOut = params.minOutUnits ?? promisedOut;
  if (fresh.outUnits < minOut) {
    throw new Error(
      `fresh HTLC quote ${fresh.outUnits} below minOut ${minOut} — quote expired, refund instead`
    );
  }
  const settlementFloor =
    promisedOut -
    (promisedOut * BigInt(HTLC_SETTLEMENT_SLIPPAGE_BPS)) / 10000n;
  if (fresh.outUnits < settlementFloor) {
    throw new Error(
      `fresh HTLC quote ${fresh.outUnits} below settlement floor ${settlementFloor}`
    );
  }
}
