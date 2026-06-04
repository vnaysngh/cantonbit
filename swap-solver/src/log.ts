/**
 * Minimal structured logger. Leveled, timestamped, single-line JSON-ish output
 * that's grep-able and shippable to a log aggregator. Never logs secrets — the
 * env loader already redacts; this is the runtime equivalent.
 *
 * LOG_LEVEL env: debug | info | warn | error (default info).
 */

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const THRESHOLD: number = ORDER[(process.env.LOG_LEVEL as Level) ?? "info"] ?? 1;

// Keys whose values must never be printed, even if passed in a context object.
const SECRET_KEYS = ["privatekey", "clientsecret", "secret", "accesstoken", "jwt", "key"];

function redact(ctx?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!ctx) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ctx)) {
    out[k] = SECRET_KEYS.some((s) => k.toLowerCase().includes(s)) ? "***redacted***" : v;
  }
  return out;
}

function emit(level: Level, scope: string, msg: string, ctx?: Record<string, unknown>): void {
  if (ORDER[level] < THRESHOLD) return;
  const safe = redact(ctx);
  const suffix = safe && Object.keys(safe).length ? " " + JSON.stringify(safe) : "";
  // ISO timestamp via Date is unavailable in some sandboxes but fine at runtime.
  const line = `${nowIso()} [${level.toUpperCase()}] [${scope}] ${msg}${suffix}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

function nowIso(): string {
  try {
    return new Date().toISOString();
  } catch {
    return String(Date.now());
  }
}

export function logger(scope: string) {
  return {
    debug: (msg: string, ctx?: Record<string, unknown>) => emit("debug", scope, msg, ctx),
    info: (msg: string, ctx?: Record<string, unknown>) => emit("info", scope, msg, ctx),
    warn: (msg: string, ctx?: Record<string, unknown>) => emit("warn", scope, msg, ctx),
    error: (msg: string, ctx?: Record<string, unknown>) => emit("error", scope, msg, ctx),
  };
}
