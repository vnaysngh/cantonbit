/**
 * User-facing order visibility — unpaid drafts must never appear in /orders history.
 */
import type { CantonSwapOrder } from "./canton-swap-types";
import type { SwapOrder } from "./htlc-types";
import { isSmokeTestOrderId } from "./htlc-order-logic";

export function htlcOrderHasUserPaymentProof(
  o: Pick<
    SwapOrder,
    | "direction"
    | "status"
    | "mainLockTx"
    | "counterTransferOfferCid"
    | "counterTransferUpdateId"
    | "allocationCid"
    | "htlcCid"
  >
): boolean {
  if (o.direction === "evm-to-canton") {
    return !!o.mainLockTx;
  }
  return !!(
    o.counterTransferOfferCid ||
    o.counterTransferUpdateId ||
    o.allocationCid ||
    o.htlcCid ||
    o.status === "main_locked" ||
    o.status === "counter_locking" ||
    o.status === "counter_locked" ||
    o.status === "counter_claimed" ||
    o.status === "main_claimed" ||
    o.status === "refunding" ||
    o.status === "refunded"
  );
}

/** Reverse Loop rows with WBTC pre-locked but custody not yet bound — user must retry commit. */
export function htlcOrderNeedsLoopRecovery(
  o: Pick<
    SwapOrder,
    | "direction"
    | "counterMode"
    | "status"
    | "evmFloatReserved"
    | "counterTransferOfferCid"
    | "counterTransferUpdateId"
    | "allocationCid"
    | "htlcCid"
  >
): boolean {
  return (
    o.direction === "canton-to-evm" &&
    o.counterMode === "loop" &&
    o.evmFloatReserved === true &&
    (o.status === "main_locking" || o.status === "accepted") &&
    !o.counterTransferOfferCid &&
    !o.counterTransferUpdateId &&
    !o.allocationCid &&
    !o.htlcCid
  );
}

export function htlcOrderVisibleInHistory(
  o: Parameters<typeof htlcOrderHasUserPaymentProof>[0] &
    Parameters<typeof htlcOrderNeedsLoopRecovery>[0]
): boolean {
  return htlcOrderHasUserPaymentProof(o) || htlcOrderNeedsLoopRecovery(o);
}

export function c2cOrderHasUserPaymentProof(
  o: Pick<
    CantonSwapOrder,
    "walletMode" | "status" | "userLegOfferCid" | "userLegSubmitUpdateId" | "settlementUpdateId"
  >
): boolean {
  if (o.walletMode === "managed") {
    return o.status !== "open" && o.status !== "expired" && o.status !== "cancelled";
  }
  return !!(
    o.userLegOfferCid ||
    o.userLegSubmitUpdateId ||
    o.settlementUpdateId ||
    o.status === "user_locked" ||
    o.status === "filling" ||
    o.status === "filled" ||
    o.status === "settling"
  );
}

export function filterVisibleHtlcHistoryOrders<
  T extends Pick<
    SwapOrder,
    | "direction"
    | "status"
    | "mainLockTx"
    | "counterTransferOfferCid"
    | "counterTransferUpdateId"
    | "allocationCid"
    | "htlcCid"
    | "counterMode"
    | "evmFloatReserved"
    | "userEvmAddress"
  > & { id?: string }
>(orders: T[], opts?: { userEvmAddress?: string | null }): T[] {
  const evm = opts?.userEvmAddress?.trim().toLowerCase();
  return orders.filter((o) => {
    if (isSmokeTestOrderId(o.id)) return false;
    if (!htlcOrderVisibleInHistory(o)) return false;
    if (evm && o.userEvmAddress?.toLowerCase() !== evm) return false;
    return true;
  });
}

export function filterVisibleC2cHistoryOrders<
  T extends Pick<
    CantonSwapOrder,
    | "walletMode"
    | "status"
    | "userLegOfferCid"
    | "userLegSubmitUpdateId"
    | "settlementUpdateId"
  > & { id?: string }
>(orders: T[]): T[] {
  return orders.filter(
    (o) => !isSmokeTestOrderId(o.id) && c2cOrderHasUserPaymentProof(o)
  );
}
