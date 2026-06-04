/**
 * Retry with exponential backoff for transient failures.
 *
 * The solver talks to two flaky surfaces: public EVM RPCs (load-balanced,
 * eventually-consistent — we hit stale reads live) and the Canton ledger (had a
 * synchronizer drop live). A single transient error shouldn't waste a whole
 * poll tick, so wrap individual calls in `retry()`.
 *
 * Only RETRYABLE errors are retried (network/timeout/5xx/known-transient). A
 * deterministic error (bad signature, NotProven, insufficient float) fails fast
 * — retrying it just wastes time and gas.
 */

export interface RetryOptions {
  retries?: number; // max attempts after the first (default 4)
  baseMs?: number; // first backoff (default 500)
  maxMs?: number; // backoff ceiling (default 8000)
  label?: string; // for logging
  /** Decide if an error is worth retrying. Default: isTransientError. */
  shouldRetry?: (err: unknown) => boolean;
  onRetry?: (attempt: number, delayMs: number, err: unknown) => void;
}

export async function retry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? 4;
  const baseMs = opts.baseMs ?? 500;
  const maxMs = opts.maxMs ?? 8000;
  const shouldRetry = opts.shouldRetry ?? isTransientError;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === retries || !shouldRetry(err)) break;
      // exponential backoff with light jitter (deterministic-ish: attempt-based)
      const exp = Math.min(maxMs, baseMs * 2 ** attempt);
      const jitter = (exp * (attempt % 3)) / 10; // 0/10%/20% — no Math.random
      const delay = Math.min(maxMs, exp + jitter);
      opts.onRetry?.(attempt + 1, delay, err);
      await sleep(delay);
    }
  }
  throw lastErr;
}

/**
 * Heuristic: is this error worth retrying? Network/timeout/rate-limit/5xx and a
 * few known-transient Canton/EVM strings. Deterministic validation errors are
 * NOT retried.
 */
export function isTransientError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();

  // Never retry these — they won't get better by trying again.
  const deterministic = [
    "notproven",
    "insufficient",
    "invalid signature",
    "does not match",
    "fillsdeadline",
    "after filldeadline",
    "nonce too low",
    "already known",
  ];
  if (deterministic.some((d) => msg.includes(d))) return false;

  // Retry these.
  const transient = [
    "timeout",
    "timed out",
    "econnreset",
    "econnrefused",
    "enotfound",
    "socket hang up",
    "fetch failed",
    "network",
    "rate limit",
    "429",
    "502",
    "503",
    "504",
    "not_connected_to_any_synchronizer", // node recovering
    "temporarily",
    "try again",
  ];
  return transient.some((t) => msg.includes(t));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
