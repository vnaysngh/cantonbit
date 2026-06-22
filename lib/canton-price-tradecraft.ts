/**
 * Tradecraft AMM quotes — primary executable price for Canton-native pairs.
 * Uses mainnet Tradecraft API on all app networks (devnet quotes are indicative).
 * https://docs.tradecraft.fi/api/routes/quotes
 */
import "server-only";

import type { CantonSwapAssetId } from "./canton-assets";
import {
  fetchWithFreshness,
  type PriceCacheEntry
} from "./price-cache";

const DEFAULT_BASE = "https://api.tradecraft.fi/v1";

/** CloudFront blocks undifferentiated Node fetch UA — send explicit client headers. */
const TRADECRAFT_HEADERS: HeadersInit = {
  Accept: "application/json",
  "User-Agent": "OranjSwap/1.0 (+https://oranjswap.com)"
};

export class TradecraftQuoteError extends Error {}

interface TradecraftQuoteValue {
  userGets: number;
}

export interface TradecraftQuoteFixedInputResult {
  userGets: number;
  source: "tradecraft";
  ageMs: number;
  stale: boolean;
}

/** Map our asset ids to Tradecraft path tokens. */
export function tradecraftSymbol(id: CantonSwapAssetId): string {
  if (id === "USDCX") return "USDCx";
  return id;
}

function apiBase(): string {
  return process.env.TRADECRAFT_API_URL ?? DEFAULT_BASE;
}

const quoteCache = new Map<string, PriceCacheEntry<TradecraftQuoteValue>>();
const QUOTE_CACHE_MS = 20_000;
const QUOTE_CACHE_MAX_STALE_MS = 60_000;

function quoteUrl(params: {
  from: CantonSwapAssetId;
  to: CantonSwapAssetId;
  givingAmount: string;
}): string {
  const base = apiBase();
  const a = encodeURIComponent(tradecraftSymbol(params.from));
  const b = encodeURIComponent(tradecraftSymbol(params.to));
  return `${base}/quoteForFixedInput/${a}/${b}?givingAmount=${encodeURIComponent(params.givingAmount)}`;
}

async function fetchTradecraftQuote(url: string): Promise<TradecraftQuoteValue | null> {
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
  return { userGets: j.user_gets };
}

function validateTradecraftQuote(
  value: TradecraftQuoteValue
): TradecraftQuoteValue {
  if (
    typeof value.userGets !== "number" ||
    !Number.isFinite(value.userGets) ||
    value.userGets <= 0
  ) {
    throw new TradecraftQuoteError("Tradecraft returned invalid user_gets");
  }
  return value;
}

/** Fixed-input quote with source/freshness metadata. */
export async function tradecraftQuoteFixedInputWithMeta(params: {
  from: CantonSwapAssetId;
  to: CantonSwapAssetId;
  /** Human decimal amount (not base units). */
  givingAmount: string;
}): Promise<TradecraftQuoteFixedInputResult> {
  const url = quoteUrl(params);
  try {
    const result = await fetchWithFreshness<TradecraftQuoteValue>({
      cached: quoteCache.get(url) ?? null,
      setCached: (entry) => {
        quoteCache.set(url, entry);
      },
      sources: [
        {
          name: "tradecraft",
          fetch: () => fetchTradecraftQuote(url)
        }
      ],
      freshMs: QUOTE_CACHE_MS,
      maxStaleMs: QUOTE_CACHE_MAX_STALE_MS,
      alertTitle: "Tradecraft quote source down — serving stale checked quote",
      unavailableMessage: (reason) =>
        `Tradecraft quote unavailable (${reason})`,
      validate: validateTradecraftQuote
    });
    return {
      userGets: result.value.userGets,
      source: "tradecraft",
      ageMs: result.ageMs,
      stale: result.stale
    };
  } catch (e) {
    if (e instanceof TradecraftQuoteError) throw e;
    throw new TradecraftQuoteError(
      e instanceof Error ? e.message : String(e)
    );
  }
}

/** Fixed-input quote: how much `to` the user receives for `givingAmount` of `from`. */
export async function tradecraftQuoteFixedInput(params: {
  from: CantonSwapAssetId;
  to: CantonSwapAssetId;
  /** Human decimal amount (not base units). */
  givingAmount: string;
}): Promise<number> {
  return (await tradecraftQuoteFixedInputWithMeta(params)).userGets;
}

export function tradecraftAvailable(): boolean {
  return true;
}
