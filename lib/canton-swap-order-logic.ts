import type { CantonSwapOrder } from "./canton-swap-types";

/** Loop swaps get more time than the RFQ quote TTL (sign + daemon fill). */
export const LOOP_SWAP_ORDER_TTL_SECONDS = 900;

/** Counter-leg offer window after solver fill (Splice executeBefore). */
export const LOOP_COUNTER_OFFER_TTL_SECONDS = 24 * 60 * 60;

/** User sell-leg offer TTL when preparing Loop sign (matches Splice 24h convention). */
export const LOOP_USER_LEG_OFFER_TTL_SECONDS = 24 * 60 * 60;

/** Solver auto-accepted user sell via TransferPreapproval — no pending offer CID. */
export const LOOP_USER_LEG_PREAPPROVAL_SETTLED = "transfer-preapproval-settled";

/** Min wait after counter leaves pending ACS before vault may reissue (ledger propagation). */
export const COUNTER_REISSUE_COOLDOWN_SECONDS = 90;

export function counterReissueCooldownElapsed(
  clearedAtUnix: number | undefined,
  nowUnix = Math.floor(Date.now() / 1000)
): boolean {
  if (!clearedAtUnix) return false;
  return nowUnix >= clearedAtUnix + COUNTER_REISSUE_COOLDOWN_SECONDS;
}

export function loopFillCommandId(orderId: string): string {
  return `canton-swap-fill-${orderId}`;
}

export function loopCounterReissueCommandId(orderId: string, attempt: number): string {
  return `canton-swap-counter-${orderId}-${attempt}`;
}

/** Transient fill errors — retry via daemon reconcile, not terminal failed. */
export function isRetriableLoopFillError(msg: string): boolean {
  return (
    msg.includes("offer not visible") ||
    msg.includes("pending offer not found") ||
    msg.includes("cannot fill atomically") ||
    msg.includes("Retry shortly") ||
    msg.includes("still in flight") ||
    msg.includes("duplicate command committed but fill transaction not found")
  );
}

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
  if (
    o.walletMode === "managed" &&
    o.status === "settling" &&
    o.settlementUpdateId &&
    o.counterLegOfferCid
  ) {
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

/** Managed settle committed; user must accept counter offer. */
export function isManagedPendingCounterAccept(o: CantonSwapOrder): boolean {
  return (
    o.walletMode === "managed" &&
    o.status === "settling" &&
    !!o.settlementUpdateId &&
    !!o.counterLegOfferCid
  );
}

export function isPendingCounterAccept(o: CantonSwapOrder): boolean {
  return isLoopFillPendingCounterAccept(o) || isManagedPendingCounterAccept(o);
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
