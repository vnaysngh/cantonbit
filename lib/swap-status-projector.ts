import type { CantonSwapOrder } from "./canton-swap-types";
import type { SwapOrder } from "./htlc-types";
import {
  c2cVisibleCompleted,
  htlcVisibleCompleted
} from "./swap-product-invariants";

export type ProjectedSwapTone = "success" | "active" | "waiting" | "muted" | "danger";

export interface ProjectedSwapStatus {
  label: string;
  tone: ProjectedSwapTone;
  terminal: boolean;
  proofComplete: boolean;
}

export function projectHtlcStatus(
  order: Pick<
    SwapOrder,
    | "status"
    | "direction"
    | "counterMode"
    | "revealedPreimage"
    | "counterTransferUpdateId"
    | "counterTransferOfferCid"
    | "counterClaimUpdateId"
    | "mainClaimTx"
  >
): ProjectedSwapStatus {
  if (htlcVisibleCompleted(order)) {
    return {
      label: "Completed",
      tone: "success",
      terminal: true,
      proofComplete: true
    };
  }

  switch (order.status) {
    case "main_claimed":
      return {
        label: "Finalizing",
        tone: "waiting",
        terminal: false,
        proofComplete: false
      };
    case "counter_claimed": {
      const pendingLoopAccept =
        order.direction === "evm-to-canton" &&
        order.counterMode === "loop" &&
        !!order.counterTransferOfferCid &&
        !order.counterClaimUpdateId;
      return {
        label: pendingLoopAccept ? "Accept pending" : "Finalizing",
        tone: "waiting",
        terminal: false,
        proofComplete: false
      };
    }
    case "counter_locked":
      return {
        label: "Ready to claim",
        tone: "active",
        terminal: false,
        proofComplete: false
      };
    case "counter_locking":
    case "main_locked":
      return {
        label: "In progress",
        tone: "active",
        terminal: false,
        proofComplete: false
      };
    case "main_locking":
      return {
        label: "Confirming",
        tone: "waiting",
        terminal: false,
        proofComplete: false
      };
    case "accepted":
      return {
        label: "Pending",
        tone: "muted",
        terminal: false,
        proofComplete: false
      };
    case "open":
      return {
        label: "Open",
        tone: "muted",
        terminal: false,
        proofComplete: false
      };
    case "refunding":
      return {
        label: "Refunding",
        tone: "waiting",
        terminal: false,
        proofComplete: false
      };
    case "refunded":
      return {
        label: "Refunded",
        tone: "muted",
        terminal: true,
        proofComplete: true
      };
    case "cancelled":
      return {
        label: "Cancelled",
        tone: "muted",
        terminal: true,
        proofComplete: true
      };
    case "failed":
      return {
        label: "Failed",
        tone: "danger",
        terminal: true,
        proofComplete: true
      };
    default:
      return {
        label: "In progress",
        tone: "active",
        terminal: false,
        proofComplete: false
      };
  }
}

export function projectC2cStatus(
  order: Pick<
    CantonSwapOrder,
    | "status"
    | "settlementUpdateId"
    | "counterLegOfferCid"
    | "counterReceiptUpdateId"
  >
): ProjectedSwapStatus {
  if (c2cVisibleCompleted(order)) {
    return {
      label: "Completed",
      tone: "success",
      terminal: true,
      proofComplete: true
    };
  }
  if (order.counterLegOfferCid && !order.counterReceiptUpdateId) {
    return {
      label: "Accept pending",
      tone: "waiting",
      terminal: false,
      proofComplete: false
    };
  }

  switch (order.status) {
    case "filled":
      return {
        label: "Finalizing",
        tone: "waiting",
        terminal: false,
        proofComplete: false
      };
    case "user_locked":
    case "filling":
    case "settling":
      return {
        label: "Settling",
        tone: "active",
        terminal: false,
        proofComplete: false
      };
    case "open":
      return {
        label: "Open",
        tone: "muted",
        terminal: false,
        proofComplete: false
      };
    case "expired":
      return {
        label: "Expired",
        tone: "muted",
        terminal: true,
        proofComplete: true
      };
    case "cancelled":
      return {
        label: "Cancelled",
        tone: "muted",
        terminal: true,
        proofComplete: true
      };
    case "failed":
      return {
        label: "Failed",
        tone: "danger",
        terminal: true,
        proofComplete: true
      };
    default:
      return {
        label: "In progress",
        tone: "active",
        terminal: false,
        proofComplete: false
      };
  }
}

export function projectedToneClass(tone: ProjectedSwapTone): string {
  switch (tone) {
    case "success":
      return "bg-green-500/12 text-green-600 ring-green-500/20";
    case "danger":
      return "bg-red-500/12 text-red-600 ring-red-500/20";
    case "active":
      return "bg-blue-500/12 text-blue-600 ring-blue-500/20";
    case "waiting":
      return "bg-amber-500/12 text-amber-700 ring-amber-500/20";
    case "muted":
    default:
      return "bg-foreground/8 text-foreground/60 ring-foreground/10";
  }
}

