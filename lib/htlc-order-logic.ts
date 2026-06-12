/**
 * Pure order-lifecycle decision logic — NO server-only / DB / network imports, so
 * it can be unit-tested directly (same pattern as htlc-auth-logic.ts).
 */
import type { SwapOrder } from "./htlc-types";

/** True when the user can reveal the secret and claim (matches /swap live flow). */
export function isSwapClaimable(
  o: Pick<SwapOrder, "status" | "direction" | "counterMode" | "revealedPreimage">,
): boolean {
  if (o.revealedPreimage) return false;
  if (o.status === "counter_locked") return true;
  // Loop forward skips the Canton counter-lock — claimable at main_locked once WBTC is locked.
  if (
    o.status === "main_locked" &&
    o.counterMode === "loop" &&
    o.direction === "evm-to-canton"
  ) {
    return true;
  }
  return false;
}

/**
 * Decide what createOrder should persist. SECURITY (audit 2026-06-12): a re-POST
 * with the SAME id must NOT overwrite a live order's terms/status — that would
 * desync the daemon and refund/claim accounting. id = the hashLock, which binds it
 * to a secret, so a different secret can't collide with an existing id anyway.
 *
 * Returns the EXISTING order when one is present (no-op), else the new order to put.
 */
export function resolveCreateOrder(
  existing: SwapOrder | undefined,
  incoming: Omit<SwapOrder, "status" | "createdAt">,
  nowSeconds: number,
): { order: SwapOrder; isNew: boolean } {
  if (existing) return { order: existing, isNew: false };
  return { order: { ...incoming, status: "open", createdAt: nowSeconds }, isNew: true };
}
