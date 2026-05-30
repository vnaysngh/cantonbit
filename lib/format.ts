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

/**
 * Canonical cBTC amount string for ledger submission: fixed 10 decimal places,
 * e.g. "0.000001" → "0.0000010000". Matches the format the reference burn
 * script sends. Uses exact BigInt satoshi math (no float), so an input like
 * "0.000001" parses to 100 sats and renders padded to 10 dp.
 *
 * cBTC carries 8 decimals on-ledger; the extra two trailing zeros are the
 * scale Canton expects in the choice argument. We always submit this form so
 * UI and script burns are byte-identical on the amount field.
 */
export function toCanonicalAmount(amount: string): string {
  const sats = parseBtc(amount); // exact: BTC string → satoshi BigInt
  const negative = sats < 0n;
  const abs = negative ? -sats : sats;
  const whole = abs / 100_000_000n;
  // 8 dp from satoshis, then pad to 10 dp total (Canton's amount scale).
  const frac8 = (abs % 100_000_000n).toString().padStart(8, "0");
  const body = `${whole}.${frac8}00`;
  return negative ? `-${body}` : body;
}

/**
 * Display helper for BTC amounts.
 *
 * Formats with up to 8 decimal places (the BTC convention) but trims trailing
 * zeros so we show the natural, minimal representation:
 *   "0.00002000" → "0.00002"
 *   "1.00000000" → "1"
 *   "0"          → "0"
 *
 * Uses integer-satoshi BigInt math (no floats, no precision loss) — same as
 * the rest of this module. We deliberately do NOT pull in a decimal library:
 * the BigInt approach is already exact for BTC's fixed 8-dp scale.
 */
export function formatBtc(amount: string | bigint): string {
  return formatSatoshis(typeof amount === "bigint" ? amount : parseBtc(amount));
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
