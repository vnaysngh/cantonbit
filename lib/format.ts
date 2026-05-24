/**
 * Truncate a Canton party ID for display: first 8 + … + last 8 chars
 * around the `::` separator. Falls back gracefully for short inputs.
 *
 * Example:
 *   warpx-devnet-1::1220231c1885f28...a949203ff
 *     → "warpx-de…203ff"
 */
export function truncatePartyId(partyId: string, head = 8, tail = 6): string {
  if (partyId.length <= head + tail + 1) return partyId;
  return `${partyId.slice(0, head)}…${partyId.slice(-tail)}`;
}

/**
 * Sum a list of decimal-string amounts. Uses a simple integer-cents trick
 * (8 decimal places for BTC) to avoid floating-point drift.
 */
export function sumBtc(amounts: string[]): string {
  let satoshis = 0n;
  for (const a of amounts) satoshis += parseBtc(a);
  return formatSatoshis(satoshis);
}

/** Parse a BTC decimal string into satoshi BigInt (1 BTC = 1e8 sats). */
export function parseBtc(amount: string): bigint {
  const clean = amount.trim();
  if (clean === "" || clean === "-") return 0n;
  const negative = clean.startsWith("-");
  const body = negative ? clean.slice(1) : clean;
  const [whole, frac = ""] = body.split(".");
  const fracPadded = (frac + "00000000").slice(0, 8);
  const sats = BigInt(whole || "0") * 100_000_000n + BigInt(fracPadded || "0");
  return negative ? -sats : sats;
}

/** Format a satoshi BigInt back to a decimal BTC string (8 dp, trimmed). */
export function formatSatoshis(sats: bigint): string {
  const negative = sats < 0n;
  const abs = negative ? -sats : sats;
  const whole = abs / 100_000_000n;
  const frac = (abs % 100_000_000n).toString().padStart(8, "0");
  const trimmed = frac.replace(/0+$/, "");
  const body = trimmed.length === 0 ? `${whole}` : `${whole}.${trimmed}`;
  return negative ? `-${body}` : body;
}

/** Display helper: always show 8 decimal places (BTC convention). */
export function formatBtc(amount: string | bigint): string {
  const sats = typeof amount === "bigint" ? amount : parseBtc(amount);
  const negative = sats < 0n;
  const abs = negative ? -sats : sats;
  const whole = (abs / 100_000_000n).toString();
  const frac = (abs % 100_000_000n).toString().padStart(8, "0");
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

/** Relative time string for activity rows. */
export function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diffSec = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 48) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  return `${diffDay}d ago`;
}
