/**
 * Client-side helpers for polling HTLC orders on /api/htlc/{id}.
 */
import type { SwapOrder, SwapStatus } from "./htlc-types";
import {
  DELAYED_AFTER_SECONDS,
  PENDING_BUFFER_SECONDS,
  type SwapProgressState
} from "./swap-api";

export function isHtlcTerminal(status: SwapStatus): boolean {
  return (
    status === "main_claimed" ||
    status === "refunded" ||
    status === "cancelled" ||
    status === "failed"
  );
}

/** User-facing progress for cross-chain HTLC orders. */
export function deriveHtlcProgress(
  order: SwapOrder,
  nowSeconds: number
): SwapProgressState {
  if (order.status === "main_claimed") return "finished";
  if (order.status === "refunded") return "refunded";
  if (order.status === "failed" || order.status === "cancelled") return "failed";

  if (
    order.userTimelock &&
    nowSeconds > order.userTimelock + PENDING_BUFFER_SECONDS
  ) {
    return "expired";
  }

  const ageSeconds = nowSeconds - order.createdAt;
  if (ageSeconds > DELAYED_AFTER_SECONDS) return "delayed";

  if (order.status === "open" || order.status === "accepted") return "initial";

  if (
    order.status === "main_locked" ||
    order.status === "counter_locked" ||
    order.status === "counter_claimed"
  ) {
    return "delivering";
  }

  return "initial";
}

export const HTLC_SWAP_STEPS = {
  "evm-to-canton": [
    "Confirming your deposit",
    "Sending CBTC to your wallet",
    "Swap complete"
  ],
  "canton-to-evm": [
    "Locking your CBTC",
    "Sending WBTC to your wallet",
    "Swap complete"
  ]
} as const;

export function htlcStepIndex(order: SwapOrder): number {
  if (order.status === "main_claimed") return 2;
  if (order.status === "open" || order.status === "accepted") return 0;
  return 1;
}

export function htlcPayReceive(order: SwapOrder): {
  pay: string | null;
  receive: string | null;
} {
  const wbtc = order.wbtcAmount
    ? (Number(BigInt(order.wbtcAmount)) / 1e8)
        .toFixed(8)
        .replace(/0+$/, "")
        .replace(/\.$/, "")
    : null;
  const cbtc = order.cbtcAmount
    ? parseFloat(order.cbtcAmount)
        .toFixed(8)
        .replace(/0+$/, "")
        .replace(/\.$/, "")
    : null;
  if (order.direction === "canton-to-evm") {
    return {
      pay: cbtc ? `${cbtc} CBTC` : null,
      receive: wbtc ? `${wbtc} WBTC` : null
    };
  }
  return {
    pay: wbtc ? `${wbtc} WBTC` : null,
    receive: cbtc ? `${cbtc} CBTC` : null
  };
}

export const HTLC_PROGRESS_COPY: Record<
  SwapProgressState,
  { title: string; caption: string }
> = {
  initial: { title: "Swapping…", caption: "Confirming your deposit" },
  delivering: { title: "Swapping…", caption: "Completing the swap" },
  delayed: {
    title: "Taking longer than usual",
    caption:
      "Your funds are safe — track progress on the Orders page"
  },
  finished: { title: "Swap complete", caption: "Funds delivered" },
  expired: { title: "Swap expired", caption: "You can refund your locked funds" },
  refunded: { title: "Refunded", caption: "Funds returned to your wallet" },
  failed: { title: "Swap failed", caption: "Check Orders for recovery options" }
};
