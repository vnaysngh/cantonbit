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
 * Client IP for rate limiting. Prefer the edge-set `x-real-ip`; otherwise take
 * the client address from `x-forwarded-for` using TRUSTED_PROXY_HOPS (default 1).
 */
export function clientIpFromRequest(req: Request): string {
  const realIp = req.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;

  const forwarded = req.headers.get("x-forwarded-for");
  if (!forwarded) return "unknown";

  const hops = Math.max(
    1,
    Number.parseInt(process.env.TRUSTED_PROXY_HOPS ?? "1", 10) || 1
  );
  const parts = forwarded
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return "unknown";
  const idx = Math.max(0, parts.length - hops - 1);
  return parts[idx] ?? "unknown";
}
