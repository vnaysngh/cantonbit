/**
 * Pure order-lifecycle decision logic — NO server-only / DB / network imports, so
 * it can be unit-tested directly (same pattern as htlc-auth-logic.ts).
 */
import type { SwapOrder } from "./htlc-types";
import { filterVisibleHtlcHistoryOrders, htlcOrderHasUserPaymentProof, htlcOrderVisibleInHistory } from "./swap-order-visibility";

/** C-02 guard: zero EVM lock amount alone must not flip reverse order to counter_claimed. */
export function reverseZeroLockReconcileOutcome(
  evmClaimed: boolean
): "counter_claimed" | "continue" {
  return evmClaimed ? "counter_claimed" : "continue";
}

/** Dev/smoke automation order ids — exclude from user history and UI polling. */
export function isSmokeTestOrderId(id: string | undefined): boolean {
  if (!id) return false;
  return id.startsWith("smoke-");
}

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

/** Forward swap that never locked WBTC — hidden from history via swap-order-visibility. */
export function isAbandonedSwapDraft(
  o: Pick<SwapOrder, "direction" | "status" | "mainLockTx">,
): boolean {
  return o.direction === "evm-to-canton" && o.status === "accepted" && !o.mainLockTx;
}

/**
 * User-facing history filter — only orders with user payment proof; optionally
 * filter to one EVM wallet on shared-party dev accounts.
 */
export function filterHistoryOrders<
  T extends Pick<
    SwapOrder,
    | "direction"
    | "status"
    | "mainLockTx"
    | "counterTransferOfferCid"
    | "counterTransferUpdateId"
    | "allocationCid"
    | "htlcCid"
    | "userEvmAddress"
  > & { id?: string }
>(orders: T[], opts?: { userEvmAddress?: string | null }): T[] {
  return filterVisibleHtlcHistoryOrders(orders, opts);
}

/** Terminal statuses — no background refresh on /orders. */
export const ORDERS_PAGE_TERMINAL_STATUSES = new Set([
  "main_claimed",
  "both_claimed",
  "refunded",
  "cancelled",
  "failed",
  "filled",
  "expired"
]);

/** Cap parallel GET /orders polling (newest in-flight orders only). */
export const ORDERS_LIVE_POLL_MAX = 8;

export const ORDERS_LIVE_POLL_MS = 6_000;

/** True when /orders should poll this row (skip abandoned drafts and stale C2C open). */
export function shouldPollOrderOnOrdersPage(o: {
  id?: string;
  direction?: string;
  status: string;
  mainLockTx?: string;
}): boolean {
  if (isSmokeTestOrderId(o.id)) return false;
  if (ORDERS_PAGE_TERMINAL_STATUSES.has(o.status)) return false;
  if (o.direction === "canton-swap") {
    return ["user_locked", "filling", "settling"].includes(o.status);
  }
  if (
    !htlcOrderVisibleInHistory(
      o as Pick<
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
      >
    )
  ) {
    return false;
  }
  return true;
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
  if (existing) {
    if (existing.userCantonParty !== incoming.userCantonParty) {
      throw new Error("order id already exists for another party");
    }
    const immutableFields: Array<keyof typeof incoming> = [
      "direction",
      "hashLock",
      "userEvmAddress",
      "solverEvmAddress",
      "wbtcAmount",
      "userTimelock",
      "userCantonParty",
      "solverCantonParty",
      "cbtcAmount",
      "solverTimelock",
      "counterMode",
      "evmChainSlug",
      "evmChainId",
      "evmEscrowAddress",
      "evmWbtcAddress"
    ];
    for (const field of immutableFields) {
      const current = existing[field as keyof SwapOrder];
      const requested = incoming[field];
      const normalize = (value: unknown) =>
        typeof value === "string" ? value.toLowerCase() : value;
      if (normalize(current) !== normalize(requested)) {
        throw new Error(`order id already exists with different ${String(field)}`);
      }
    }
    return { order: existing, isNew: false };
  }
  return { order: { ...incoming, status: "open", createdAt: nowSeconds }, isNew: true };
}

/** 0x + 64 hex chars — EVM tx hash or update id mis-filed as tx. */
export function isEvmTxHash(s: string | undefined): s is string {
  return !!s && /^0x[0-9a-fA-F]{64}$/.test(s);
}

/**
 * Direction-aware claim evidence on SwapOrder (see htlc-types field comments).
 * Legacy reverse orders may have the user's WBTC claim tx in counterClaimUpdateId.
 *
 * On reverse orders, mainClaimTx doubles as solver-retake proof when the user
 * never revealed the preimage — do not treat that as a user WBTC claim.
 */
export function htlcUserWbtcClaimTx(
  o: {
    direction: SwapOrder["direction"] | "canton-swap";
    mainClaimTx?: string;
    counterClaimUpdateId?: string;
    revealedPreimage?: string;
    status?: SwapOrder["status"] | string;
  }
): string | undefined {
  if (o.direction !== "canton-to-evm") return undefined;
  const status = o.status;
  if (
    isEvmTxHash(o.mainClaimTx) &&
    !o.revealedPreimage &&
    status !== undefined &&
    status !== "main_claimed" &&
    status !== "counter_claimed"
  ) {
    return undefined;
  }
  if (isEvmTxHash(o.mainClaimTx)) return o.mainClaimTx;
  if (isEvmTxHash(o.counterClaimUpdateId)) return o.counterClaimUpdateId;
  return undefined;
}

/** Solver retook WBTC on a reverse order after the user never claimed. */
export function htlcReverseSolverRetakeTx(
  o: Pick<SwapOrder, "direction" | "mainClaimTx" | "revealedPreimage" | "status">
): string | undefined {
  if (o.direction !== "canton-to-evm") return undefined;
  if (o.revealedPreimage) return undefined;
  if (!isEvmTxHash(o.mainClaimTx)) return undefined;
  if (
    o.status === "failed" ||
    o.status === "refunded" ||
    o.status === "refunding" ||
    o.status === "counter_locked"
  ) {
    return o.mainClaimTx;
  }
  return undefined;
}

/** Solver WBTC claim on forward; undefined on reverse. */
export function htlcSolverWbtcClaimTx(
  o: Pick<SwapOrder, "direction" | "mainClaimTx">
): string | undefined {
  if (o.direction !== "evm-to-canton") return undefined;
  return o.mainClaimTx;
}

/** Canton claim update: user CBTC (forward) or solver CBTC (reverse). */
export function htlcCantonClaimUpdateId(
  o: Pick<SwapOrder, "direction" | "counterClaimUpdateId">
): string | undefined {
  const c = o.counterClaimUpdateId;
  if (!c) return undefined;
  if (o.direction === "canton-to-evm" && isEvmTxHash(c)) return undefined;
  return c;
}

const REFUND_MAIN_ACTIVE_STATUSES = new Set([
  "main_locked",
  "counter_locking",
  "counter_locked",
  "counter_claimed",
  "refunding"
]);

/** Status gate for reverse refundMainCanton (managed reverse + retake-recorded failed). */
export function isRefundMainCantonStatusEligible(
  o: Pick<SwapOrder, "status" | "mainClaimTx" | "revealedPreimage">
): boolean {
  if (REFUND_MAIN_ACTIVE_STATUSES.has(o.status)) return true;
  return (
    o.status === "failed" &&
    !!o.mainClaimTx &&
    !o.revealedPreimage
  );
}

/** reverseMain bucket in expiredOrders — solver retake before userTimelock. */
export function isReverseMainExpiredSweepCandidate(
  o: Pick<
    SwapOrder,
    | "direction"
    | "counterMode"
    | "htlcCid"
    | "revealedPreimage"
    | "status"
    | "mainClaimTx"
    | "userTimelock"
  >,
  nowSeconds: number
): boolean {
  return (
    o.direction === "canton-to-evm" &&
    o.counterMode !== "loop" &&
    !!o.htlcCid &&
    !o.revealedPreimage &&
    nowSeconds >= o.userTimelock &&
    (o.status !== "failed" || !!o.mainClaimTx)
  );
}
