/**
 * CC/USD reference from Splice OpenMiningRound.amuletPrice (scan-proxy + JWT).
 * Canonical network rate — use as sanity bound, not sole trade mid.
 */
import "server-only";

import { getLedgerJwt } from "./auth";
import { NETWORK } from "./constants";

const TAG = "[canton-price-scan]";

let cached: { priceUsd: number; at: number } | null = null;
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
  const j = (await r.json()) as {
    open_mining_rounds?:
      | Array<{ contract?: { payload?: { amuletPrice?: string } } }>
      | Record<string, { contract?: { payload?: { amuletPrice?: string } } }>;
  };
  const rawRounds = j.open_mining_rounds ?? [];
  const rounds = Array.isArray(rawRounds)
    ? rawRounds
    : Object.values(rawRounds);
  for (const entry of rounds) {
    const raw = entry?.contract?.payload?.amuletPrice;
    if (raw == null) continue;
    const p = parseFloat(String(raw));
    if (Number.isFinite(p) && p > 0) {
      cached = { priceUsd: p, at: now };
      console.log(`${TAG} amuletPrice=${p} USD/CC`);
      return p;
    }
  }
  throw new Error("no amuletPrice in open mining rounds");
}
