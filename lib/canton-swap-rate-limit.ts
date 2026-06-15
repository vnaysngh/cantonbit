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

export function clientIpFromRequest(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() || "unknown";
  return req.headers.get("x-real-ip") ?? "unknown";
}
