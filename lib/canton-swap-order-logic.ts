import type { CantonSwapOrder } from "./canton-swap-types";

/** Loop swaps get more time than the RFQ quote TTL (sign + daemon fill). */
export const LOOP_SWAP_ORDER_TTL_SECONDS = 900;

/** Counter-leg offer window after solver fill (Splice executeBefore). */
export const LOOP_COUNTER_OFFER_TTL_SECONDS = 24 * 60 * 60;

/** User sell-leg offer TTL when preparing Loop sign (matches Splice 24h convention). */
export const LOOP_USER_LEG_OFFER_TTL_SECONDS = 24 * 60 * 60;

/** Solver auto-accepted user sell via TransferPreapproval — no pending offer CID. */
export const LOOP_USER_LEG_PREAPPROVAL_SETTLED = "transfer-preapproval-settled";

export function isLoopUserLegPreapprovalSettled(cid: string | undefined | null): boolean {
  return cid === LOOP_USER_LEG_PREAPPROVAL_SETTLED;
}

export const QUOTE_GRACE_SECONDS = 30;

export function loopOrderDeadline(o: CantonSwapOrder): number {
  return o.createdAt + LOOP_SWAP_ORDER_TTL_SECONDS;
}

export function quoteDeadline(o: CantonSwapOrder): number {
  return o.quoteExpiresAt + QUOTE_GRACE_SECONDS;
}

export function orderDeadline(o: CantonSwapOrder): number {
  return o.walletMode === "loop" ? loopOrderDeadline(o) : quoteDeadline(o);
}

export function isOrderExpired(o: CantonSwapOrder, now = Math.floor(Date.now() / 1000)): boolean {
  if (
    o.walletMode === "loop" &&
    o.status === "user_locked" &&
    o.settlementUpdateId &&
    o.counterLegOfferCid
  ) {
    // Solver already filled — user must accept counter; do not auto-expire.
    return false;
  }
  return now > orderDeadline(o);
}

/** Loop fill already ran and is waiting on user counter-accept. */
export function isLoopFillPendingCounterAccept(o: CantonSwapOrder): boolean {
  return (
    o.walletMode === "loop" &&
    o.status === "user_locked" &&
    !!o.settlementUpdateId &&
    !!o.counterLegOfferCid
  );
}

export function shouldSkipLoopFill(o: CantonSwapOrder): boolean {
  return isLoopFillPendingCounterAccept(o);
}

export function assertOrderNotExpired(o: CantonSwapOrder, now = Math.floor(Date.now() / 1000)): void {
  if (isOrderExpired(o, now)) {
    throw new Error(o.walletMode === "loop" ? "order expired" : "quote expired");
  }
}

/**
 * Decide what createOrder should persist. SECURITY: a re-POST with the same id must
 * NOT overwrite a live order — that would reset status/terms and desync settlement.
 */
export function resolveCreateCantonSwapOrder(
  existing: CantonSwapOrder | undefined,
  incoming: Omit<CantonSwapOrder, "status" | "createdAt">,
  nowSeconds: number
): { order: CantonSwapOrder; isNew: boolean } {
  if (existing) {
    if (existing.userParty !== incoming.userParty) {
      throw new Error("order id already exists for another party");
    }
    return { order: existing, isNew: false };
  }
  return {
    order: { ...incoming, status: "open", createdAt: nowSeconds },
    isNew: true
  };
}
