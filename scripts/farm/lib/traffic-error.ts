/**
 * Parse Canton sequencer traffic-rejection errors so the farm can (a) recognize a
 * traffic failure distinctly from a network transient, and (b) read the node's
 * ACTUAL numbers back into the local pacing model.
 *
 * The two rejection shapes seen in practice:
 *   SEQUENCER_NOT_ENOUGH_TRAFFIC_CREDIT(9,0): AboveTrafficLimit(
 *     member = PAR::warpx-mainnet-1::...,
 *     trafficCost = 8849,
 *     trafficState = TrafficState(extraTrafficLimit = 0, extraTrafficConsumed = 0,
 *       baseTrafficRemainder = 4546, lastConsumedCost = 5204, ..., availableTraffic = 4546))
 *   SEQUENCER_REQUEST_FAILED / RequestRefused(...)   ← also traffic-driven refusal
 */

export interface ParsedTrafficError {
  /** Real byte cost the node computed for the rejected tx (if present). */
  trafficCost: number | null;
  /** Real free-bucket level remaining on the node (if present). */
  baseTrafficRemainder: number | null;
  /** Real spendable traffic the node reports (if present). */
  availableTraffic: number | null;
}

function errText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const cause = (err as { cause?: { message?: string } })?.cause?.message ?? "";
  return `${msg} ${cause}`;
}

/** True for a traffic/sequencer-capacity rejection (NOT a generic network blip). */
export function isTrafficError(err: unknown): boolean {
  const t = errText(err).toLowerCase();
  return (
    t.includes("not_enough_traffic_credit") ||
    t.includes("abovetrafficlimit") ||
    t.includes("traffic rejection") ||
    t.includes("sequencer_request_failed") ||
    t.includes("requestrefused")
  );
}

/**
 * True for an expired/invalid JWT (m2m tokens lapse every ~8h). The ledger
 * returns 401 with "security-sensitive error"; a fresh getLedgerJwt() fixes it.
 * Kept separate from traffic errors so the farm re-auths instead of backing off.
 */
export function isAuthError(err: unknown): boolean {
  const t = errText(err).toLowerCase();
  return (
    t.includes("401") ||
    t.includes("unauthorized") ||
    t.includes("security-sensitive") ||
    t.includes("jwt") ||
    t.includes("token expired") ||
    t.includes("invalid_token")
  );
}

function grabInt(text: string, key: string): number | null {
  // matches e.g.  trafficCost = 8849   or   "trafficCost":8849
  const re = new RegExp(`${key}\\s*[=:]\\s*"?(\\d+)`, "i");
  const m = text.match(re);
  return m ? Number(m[1]) : null;
}

export function parseTrafficError(err: unknown): ParsedTrafficError {
  const text = errText(err);
  return {
    trafficCost: grabInt(text, "trafficCost"),
    baseTrafficRemainder: grabInt(text, "baseTrafficRemainder"),
    availableTraffic: grabInt(text, "availableTraffic")
  };
}
