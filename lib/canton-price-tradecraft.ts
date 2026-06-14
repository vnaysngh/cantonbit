/**
 * Tradecraft AMM quotes — primary executable price for Canton-native pairs.
 * Uses mainnet Tradecraft API on all app networks (devnet quotes are indicative).
 * https://docs.tradecraft.fi/api/routes/quotes
 */
import "server-only";

import type { CantonSwapAssetId } from "./canton-assets";

const DEFAULT_BASE = "https://api.tradecraft.fi/v1";

/** CloudFront blocks undifferentiated Node fetch UA — send explicit client headers. */
const TRADECRAFT_HEADERS: HeadersInit = {
  Accept: "application/json",
  "User-Agent": "OranjSwap/1.0 (+https://oranjswap.com)"
};

export class TradecraftQuoteError extends Error {}

/** Map our asset ids to Tradecraft path tokens. */
export function tradecraftSymbol(id: CantonSwapAssetId): string {
  if (id === "USDCX") return "USDCx";
  return id;
}

function apiBase(): string {
  return process.env.TRADECRAFT_API_URL ?? DEFAULT_BASE;
}

const quoteCache = new Map<string, { at: number; userGets: number }>();
const QUOTE_CACHE_MS = 20_000;

/** Fixed-input quote: how much `to` the user receives for `givingAmount` of `from`. */
export async function tradecraftQuoteFixedInput(params: {
  from: CantonSwapAssetId;
  to: CantonSwapAssetId;
  /** Human decimal amount (not base units). */
  givingAmount: string;
}): Promise<number> {
  const base = apiBase();
  const a = encodeURIComponent(tradecraftSymbol(params.from));
  const b = encodeURIComponent(tradecraftSymbol(params.to));
  const url = `${base}/quoteForFixedInput/${a}/${b}?givingAmount=${encodeURIComponent(params.givingAmount)}`;

  const hit = quoteCache.get(url);
  if (hit && Date.now() - hit.at < QUOTE_CACHE_MS) {
    return hit.userGets;
  }

  const r = await fetch(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(5000),
    headers: TRADECRAFT_HEADERS
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    const detail =
      body.startsWith("{") || body.startsWith("[")
        ? body
        : r.status === 403
          ? "blocked by CDN (check User-Agent / server egress)"
          : body.slice(0, 200);
    throw new TradecraftQuoteError(
      `Tradecraft quote failed (${r.status}): ${detail}`
    );
  }
  const j = (await r.json()) as { user_gets?: number; error?: string };
  if (j.error) throw new TradecraftQuoteError(j.error);
  if (typeof j.user_gets !== "number" || !Number.isFinite(j.user_gets) || j.user_gets <= 0) {
    throw new TradecraftQuoteError("Tradecraft returned invalid user_gets");
  }
  quoteCache.set(url, { at: Date.now(), userGets: j.user_gets });
  return j.user_gets;
}

export function tradecraftAvailable(): boolean {
  return true;
}
