/**
 * Optional cross-check: Tradecraft vs amuletPrice × BTC/USD reference mid.
 * NOT used on the C2C quote path — Tradecraft is the executable price for CC↔CBTC.
 * Enable manually via CANTON_QUOTE_ENABLE_SANITY=1 if you want this guardrail back.
 */
import "server-only";

import { alert } from "./alert";
import { fromBaseUnits, toBaseUnitsFloor } from "./amount-units";
import { getSwapAsset, type CantonSwapAssetId } from "./canton-assets";
import { fetchAmuletPriceUsd } from "./canton-price-scan";
import { CantonQuoteSanityError } from "./canton-quote";
import { cantonQuoteSanityUserMessage } from "./canton-quote-messages";
import { NETWORK } from "./constants";

/** Max deviation of Tradecraft gross from reference mid (bps). Wider on devnet (mainnet Tradecraft). */
export const CANTON_QUOTE_SANITY_BPS = Number(
  process.env.CANTON_QUOTE_SANITY_BPS ??
    (NETWORK.name === "devnet" ? "1000" : "300")
);

const BTC_PRICE_USER_MSG =
  "Could not verify the Bitcoin reference price. Please try again shortly.";

let btcUsdCache: { price: number; at: number } | null = null;
const BTC_CACHE_FRESH_MS = 60_000;
/** Serve stale BTC/USD briefly when all live sources fail (matches HTLC quote policy). */
const BTC_CACHE_MAX_STALE_MS = 90_000;

function parsePositivePrice(raw: unknown): number | null {
  const p =
    typeof raw === "number"
      ? raw
      : typeof raw === "string"
        ? Number.parseFloat(raw)
        : Number.NaN;
  if (!Number.isFinite(p) || p <= 0) return null;
  return p;
}

async function fetchJson(
  url: string,
  headers?: Record<string, string>
): Promise<unknown> {
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

async function tryCoinGeckoBtcUsd(): Promise<number | null> {
  const key = process.env.COINGECKO_API_KEY?.trim();
  const url = key
    ? "https://pro-api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd"
    : "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd";
  const j = (await fetchJson(url, key ? { "x-cg-pro-api-key": key } : undefined)) as {
    bitcoin?: { usd?: number };
  };
  return parsePositivePrice(j.bitcoin?.usd);
}

async function tryCoinbaseBtcUsd(): Promise<number | null> {
  const j = (await fetchJson(
    "https://api.coinbase.com/v2/prices/BTC-USD/spot"
  )) as { data?: { amount?: string } };
  return parsePositivePrice(j.data?.amount);
}

async function tryBinanceBtcUsd(): Promise<number | null> {
  const j = (await fetchJson(
    "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT"
  )) as { price?: string };
  return parsePositivePrice(j.price);
}

async function fetchBtcUsdLive(): Promise<number> {
  const sources: Array<{ name: string; fn: () => Promise<number | null> }> = [
    { name: "coingecko", fn: tryCoinGeckoBtcUsd },
    { name: "coinbase", fn: tryCoinbaseBtcUsd },
    { name: "binance", fn: tryBinanceBtcUsd }
  ];
  const errors: string[] = [];
  for (const { name, fn } of sources) {
    try {
      const p = await fn();
      if (p != null) return p;
      errors.push(`${name}: invalid payload`);
    } catch (e) {
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(errors.join("; "));
}

/** BTC/USD reference for notional guards (network fee, optional sanity). */
export async function fetchBtcUsdReference(): Promise<number> {
  return fetchBtcUsd();
}

async function fetchBtcUsd(): Promise<number> {
  const now = Date.now();
  if (btcUsdCache && now - btcUsdCache.at < BTC_CACHE_FRESH_MS) {
    return btcUsdCache.price;
  }
  try {
    const p = await fetchBtcUsdLive();
    btcUsdCache = { price: p, at: now };
    return p;
  } catch (e) {
    if (btcUsdCache && now - btcUsdCache.at < BTC_CACHE_MAX_STALE_MS) {
      void alert("warn", "BTC/USD reference down — serving stale price", {
        ageMs: now - btcUsdCache.at,
        reason: e instanceof Error ? e.message : String(e)
      });
      return btcUsdCache.price;
    }
    throw new CantonQuoteSanityError(
      `BTC/USD reference unavailable (${e instanceof Error ? e.message : e})`,
      BTC_PRICE_USER_MSG
    );
  }
}

/** Throws if gross Tradecraft output deviates too far from amuletPrice × BTC/USD reference. */
export async function assertCantonQuoteSanity(
  fromAsset: CantonSwapAssetId,
  toAsset: CantonSwapAssetId,
  inUnits: bigint,
  grossOutUnits: bigint
): Promise<void> {
  if (process.env.CANTON_QUOTE_ENABLE_SANITY !== "1") return;
  if (process.env.CANTON_QUOTE_SKIP_SANITY === "1") return;
  if (
    (fromAsset !== "CBTC" && fromAsset !== "CC") ||
    (toAsset !== "CBTC" && toAsset !== "CC") ||
    fromAsset === toAsset
  ) {
    return;
  }

  const from = getSwapAsset(fromAsset);
  const to = getSwapAsset(toAsset);
  const inDec = Number(fromBaseUnits(inUnits, from.decimals));
  if (!Number.isFinite(inDec) || inDec <= 0) return;

  const ccUsd = await fetchAmuletPriceUsd();
  let btcUsd: number;
  try {
    btcUsd = await fetchBtcUsd();
  } catch (e) {
    // Tradecraft is the executable price; sanity is defense-in-depth only.
    // If every BTC/USD source is down (common on Railway + CoinGecko 429), don't block swaps.
    if (e instanceof CantonQuoteSanityError) {
      void alert("warn", "Canton quote sanity skipped — BTC/USD unavailable", {
        reason: e.message
      });
      return;
    }
    throw e;
  }

  let expectedOutDec: number;
  if (fromAsset === "CBTC") {
    expectedOutDec = (inDec * btcUsd) / ccUsd;
  } else {
    expectedOutDec = (inDec * ccUsd) / btcUsd;
  }

  const expectedGross = toBaseUnitsFloor(
    expectedOutDec.toFixed(to.decimals + 4),
    to.decimals
  );
  if (expectedGross <= 0n) {
    throw new CantonQuoteSanityError(
      "reference mid produced zero output",
      cantonQuoteSanityUserMessage(fromAsset, toAsset)
    );
  }

  const diff =
    grossOutUnits > expectedGross
      ? grossOutUnits - expectedGross
      : expectedGross - grossOutUnits;
  const maxDiff = (expectedGross * BigInt(CANTON_QUOTE_SANITY_BPS)) / 10000n;
  if (diff > maxDiff) {
    const detail =
      `Tradecraft quote ${fromBaseUnits(grossOutUnits, to.decimals)} deviates from reference ${fromBaseUnits(expectedGross, to.decimals)} (>${CANTON_QUOTE_SANITY_BPS}bps)`;
    throw new CantonQuoteSanityError(
      detail,
      cantonQuoteSanityUserMessage(fromAsset, toAsset)
    );
  }
}
