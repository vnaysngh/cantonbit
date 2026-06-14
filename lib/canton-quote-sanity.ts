/**
 * Cross-check Tradecraft Canton quotes against on-ledger CC (amuletPrice) + BTC/USD.
 */
import "server-only";

import { fromBaseUnits, toBaseUnitsFloor } from "./amount-units";
import { getSwapAsset, type CantonSwapAssetId } from "./canton-assets";
import { fetchAmuletPriceUsd } from "./canton-price-scan";
import { CantonQuoteSanityError } from "./canton-quote";
import { NETWORK } from "./constants";

/** Max deviation of Tradecraft gross from reference mid (bps). Wider on devnet (mainnet Tradecraft). */
export const CANTON_QUOTE_SANITY_BPS = Number(
  process.env.CANTON_QUOTE_SANITY_BPS ??
    (NETWORK.name === "devnet" ? "1000" : "300")
);

const BTC_USD_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd";

let btcUsdCache: { price: number; at: number } | null = null;
const BTC_CACHE_MS = 60_000;

async function fetchBtcUsd(): Promise<number> {
  const now = Date.now();
  if (btcUsdCache && now - btcUsdCache.at < BTC_CACHE_MS) {
    return btcUsdCache.price;
  }
  const r = await fetch(BTC_USD_URL, {
    cache: "no-store",
    signal: AbortSignal.timeout(5000),
    headers: { Accept: "application/json", "User-Agent": "OranjSwap/1.0" }
  });
  if (!r.ok) {
    throw new CantonQuoteSanityError(
      `BTC/USD reference unavailable (${r.status})`
    );
  }
  const j = (await r.json()) as { bitcoin?: { usd?: number } };
  const p = j.bitcoin?.usd;
  if (typeof p !== "number" || !Number.isFinite(p) || p <= 0) {
    throw new CantonQuoteSanityError("BTC/USD reference invalid");
  }
  btcUsdCache = { price: p, at: now };
  return p;
}

/** Throws if gross Tradecraft output deviates too far from amuletPrice × BTC/USD reference. */
export async function assertCantonQuoteSanity(
  fromAsset: CantonSwapAssetId,
  toAsset: CantonSwapAssetId,
  inUnits: bigint,
  grossOutUnits: bigint
): Promise<void> {
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
  const btcUsd = await fetchBtcUsd();

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
    throw new CantonQuoteSanityError("reference mid produced zero output");
  }

  const diff =
    grossOutUnits > expectedGross
      ? grossOutUnits - expectedGross
      : expectedGross - grossOutUnits;
  const maxDiff = (expectedGross * BigInt(CANTON_QUOTE_SANITY_BPS)) / 10000n;
  if (diff > maxDiff) {
    throw new CantonQuoteSanityError(
      `Tradecraft quote ${fromBaseUnits(grossOutUnits, to.decimals)} deviates from reference ${fromBaseUnits(expectedGross, to.decimals)} (>${CANTON_QUOTE_SANITY_BPS}bps)`
    );
  }
}
