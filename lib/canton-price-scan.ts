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

const TAG = "[canton-price-scan]";

let cached: { priceUsd: number; at: number } | null = null;
let cachedTrafficPrice: { usdPerMb: number; at: number } | null = null;
const CACHE_MS = 60_000;

function validatorScanUrl(path: string): string {
  return `${NETWORK.validatorHost}/api/validator/v0/scan-proxy${path}`;
}

/** USD per 1 CC (Amulet). Throws if unavailable. */
export async function fetchAmuletPriceUsd(): Promise<number> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_MS) return cached.priceUsd;

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
  cached = { priceUsd: price, at: now };
  console.log(`${TAG} amuletPrice=${price} USD/CC`);
  return price;
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
