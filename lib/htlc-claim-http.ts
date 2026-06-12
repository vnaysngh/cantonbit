/**
 * Map HTLC claim-route errors to HTTP status codes.
 * User-actionable / state conflicts → 4xx (not 500 retry storms).
 */
export function htlcClaimErrorStatus(message: string): number {
  const msg = message.toLowerCase();
  if (msg.includes("invalid preimage") || msg.includes("missing preimage")) return 400;
  if (
    msg.includes("evm lock") ||
    msg.includes("expires too soon") ||
    msg.includes("counter not locked") ||
    msg.includes("unexpected status") ||
    msg.includes("not ready") ||
    msg.includes("not present") ||
    msg.includes("claim-counter is the loop path") ||
    msg.includes("claim-managed")
  ) {
    return 409;
  }
  return 500;
}
