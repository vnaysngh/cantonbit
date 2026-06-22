/**
 * CC/USD reference from Splice OpenMiningRound.amuletPrice (scan-proxy + JWT).
 * Canonical network rate — use as sanity bound, not sole trade mid.
 */
import "server-only";

import { getLedgerJwt } from "./auth";
import {
  parseAmuletPriceFromMiningRounds,
  parseAmuletRulesPayload,
  parseExtraTrafficPriceFromPayload
} from "./canton-scan-pricing";
import { NETWORK } from "./constants";
import {
  fetchWithFreshness,
  type PriceCacheEntry
} from "./price-cache";

const TAG = "[canton-price-scan]";

let cached: PriceCacheEntry<number> | null = null;
let cachedTrafficPrice: { usdPerMb: number; at: number } | null = null;
const CACHE_MS = 60_000;
const CACHE_MAX_STALE_MS = 90_000;
const AMULET_PRICE_MIN_USD = Number(
  process.env.AMULET_PRICE_MIN_USD ?? "0.0005"
);
const AMULET_PRICE_MAX_USD = Number(
  process.env.AMULET_PRICE_MAX_USD ?? "5"
);
if (
  !Number.isFinite(AMULET_PRICE_MIN_USD) ||
  !Number.isFinite(AMULET_PRICE_MAX_USD) ||
  AMULET_PRICE_MIN_USD <= 0 ||
  AMULET_PRICE_MAX_USD <= AMULET_PRICE_MIN_USD
) {
  throw new Error(
    "AMULET_PRICE_MIN_USD/AMULET_PRICE_MAX_USD must define a positive ascending clamp"
  );
}

function validatorScanUrl(path: string): string {
  return `${NETWORK.validatorHost}/api/validator/v0/scan-proxy${path}`;
}

function assertAmuletPriceInRange(price: number): number {
  if (
    !Number.isFinite(price) ||
    price < AMULET_PRICE_MIN_USD ||
    price > AMULET_PRICE_MAX_USD
  ) {
    throw new Error(
      `amuletPrice ${price} outside configured clamp ${AMULET_PRICE_MIN_USD}–${AMULET_PRICE_MAX_USD} USD/CC`
    );
  }
  return price;
}

async function fetchAmuletPriceUsdLive(): Promise<number | null> {
  const jwt = await getLedgerJwt();
  const r = await fetch(validatorScanUrl("/open-and-issuing-mining-rounds"), {
    method: "GET",
    headers: { Authorization: `Bearer ${jwt}` },
    cache: "no-store"
  });
  if (!r.ok) {
    throw new Error(
      `amuletPrice fetch failed (${r.status}): ${await r.text().catch(() => "")}`
    );
  }
  const price = parseAmuletPriceFromMiningRounds(await r.json());
  if (price == null) {
    throw new Error("no amuletPrice in open mining rounds");
  }
  return price;
}

/** USD per 1 CC (Amulet). Throws if unavailable or outside the configured clamp. */
export async function fetchAmuletPriceUsd(): Promise<number> {
  const result = await fetchWithFreshness<number>({
    cached,
    setCached: (entry) => {
      cached = entry;
    },
    sources: [
      {
        name: "scan-open-mining-rounds",
        fetch: fetchAmuletPriceUsdLive
      }
    ],
    freshMs: CACHE_MS,
    maxStaleMs: CACHE_MAX_STALE_MS,
    alertTitle: "Amulet price source down — serving stale checked price",
    unavailableMessage: (reason) =>
      `amuletPrice unavailable (${reason})`,
    validate: assertAmuletPriceInRange
  });
  if (result.ageMs === 0) {
    console.log(`${TAG} amuletPrice=${result.value} USD/CC`);
  }
  return result.value;
}

/** USD per MB for paid synchronizer traffic — read live from AmuletRules (Scan). */
export async function fetchExtraTrafficPriceUsdPerMb(): Promise<number> {
  const now = Date.now();
  if (cachedTrafficPrice && now - cachedTrafficPrice.at < CACHE_MS) {
    return cachedTrafficPrice.usdPerMb;
  }

  const jwt = await getLedgerJwt();
  const r = await fetch(validatorScanUrl("/amulet-rules"), {
    method: "GET",
    headers: { Authorization: `Bearer ${jwt}` },
    cache: "no-store"
  });
  if (!r.ok) {
    throw new Error(
      `extraTrafficPrice fetch failed (${r.status}): ${await r.text().catch(() => "")}`
    );
  }
  const payload = parseAmuletRulesPayload(await r.json());
  const price = parseExtraTrafficPriceFromPayload(payload);
  if (price == null) {
    throw new Error("no extraTrafficPrice in amulet-rules payload");
  }
  cachedTrafficPrice = { usdPerMb: price, at: now };
  console.log(`${TAG} extraTrafficPrice=${price} USD/MB`);
  return price;
}
