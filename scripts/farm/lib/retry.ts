export interface RetryOptions {
  retries?: number;
  baseMs?: number;
  maxMs?: number;
  label?: string;
  shouldRetry?: (err: unknown) => boolean;
  onRetry?: (attempt: number, delayMs: number, err: unknown) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function isTransientError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  const cause = (err as { cause?: { message?: string } })?.cause?.message?.toLowerCase() ?? "";
  const combined = `${msg} ${cause}`;

  const deterministic = [
    "insufficient",
    "float check failed",
    "no viable swap",
    "not allowlisted",
    "duplicate command",
    "invalid_argument",
    "template_id",
    "inactive_contract"
  ];
  if (deterministic.some((d) => combined.includes(d))) return false;
  if (
    combined.includes("maximum_list_elements") ||
    combined.includes("acs read failed (413)") ||
    combined.includes("getholdings acs query failed (413)")
  ) {
    return false;
  }

  const transient = [
    "fetch failed",
    "timeout",
    "timed out",
    "econnreset",
    "econnrefused",
    "enotfound",
    "socket hang up",
    "network",
    "ledger-end failed",
    "429",
    "502",
    "503",
    "504",
    "aborted",
    "lighthouse fetch failed",
    // Node free-traffic bucket temporarily exhausted — refills over time, so
    // backing off and retrying lets a slightly-too-big tx through once the base
    // traffic remainder regenerates above its byte cost.
    "traffic rejection",
    "sequencer_request_failed",
    "not_enough_traffic_credit",
    "abovetrafficlimit"
  ];
  return transient.some((t) => combined.includes(t));
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
      const exp = Math.min(maxMs, baseMs * 2 ** attempt);
      const delay = Math.min(maxMs, exp + (exp * (attempt % 3)) / 10);
      opts.onRetry?.(attempt + 1, delay, err);
      await sleep(delay);
    }
  }
  throw lastErr;
}
