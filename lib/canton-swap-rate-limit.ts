const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 30;
const buckets = new Map<string, number[]>();

/** Per-client IP token bucket for public quote endpoint. */
export function cantonSwapQuoteRateLimitOk(clientKey: string): boolean {
  const now = Date.now();
  const hits = (buckets.get(clientKey) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (hits.length >= RATE_MAX) {
    buckets.set(clientKey, hits);
    return false;
  }
  hits.push(now);
  buckets.set(clientKey, hits);
  return true;
}

/**
 * Client IP for rate limiting. Uses the client address from `x-forwarded-for`
 * with TRUSTED_PROXY_HOPS (default 1). Does not trust spoofable `x-real-ip`.
 * Returns null when the header is absent — callers on IP-only routes must fail closed.
 */
export function clientIpFromRequest(req: Request): string | null {
  const forwarded = req.headers.get("x-forwarded-for");
  if (!forwarded) return null;

  const hops = Math.max(
    1,
    Number.parseInt(process.env.TRUSTED_PROXY_HOPS ?? "1", 10) || 1
  );
  const parts = forwarded
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  const idx = Math.max(0, parts.length - hops - 1);
  return parts[idx] ?? null;
}
