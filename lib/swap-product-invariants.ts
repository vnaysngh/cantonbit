import type { CantonSwapOrder } from "./canton-swap-types";
import type { SwapOrder } from "./htlc-types";
import { htlcUserWbtcClaimTx } from "./htlc-order-logic";

export type SwapFlowKey =
  | "htlc-forward-managed"
  | "htlc-forward-loop"
  | "htlc-reverse-managed"
  | "htlc-reverse-loop"
  | "c2c-managed"
  | "c2c-loop";

export interface SwapFlowInvariant {
  key: SwapFlowKey;
  atomicity: "atomic" | "trust-minimized";
  userSigns: string[];
  userFundsMove: string;
  solverFundsMove: string;
  preimagePublic: string;
  completionProof: string[];
  refundPath: string;
}

export const SWAP_FLOW_MATRIX: readonly SwapFlowInvariant[] = [
  {
    key: "htlc-forward-managed",
    atomicity: "atomic",
    userSigns: ["EVM WBTC HTLC lock", "secret reveal / CBTC claim"],
    userFundsMove: "WBTC is locked on EVM before solver CBTC HTLC is created.",
    solverFundsMove:
      "CBTC is locked in the custom Canton HTLC and only released by the hash preimage.",
    preimagePublic:
      "Only when the managed participant exercises HtlcLock.Claim.",
    completionProof: [
      "Canton counter claim update id",
      "EVM solver WBTC claim tx"
    ],
    refundPath:
      "User retakes WBTC after EVM timelock or solver refunds CBTC after Canton timelock."
  },
  {
    key: "htlc-forward-loop",
    atomicity: "trust-minimized",
    userSigns: [
      "EVM WBTC HTLC lock",
      "Loop standard accept when CBTC delivery creates an offer"
    ],
    userFundsMove: "WBTC is locked on EVM before any CBTC delivery attempt.",
    solverFundsMove:
      "CBTC is sent with a standard TransferFactory transfer because Loop cannot exercise the custom HTLC DAR.",
    preimagePublic:
      "May be known to the backend after the user clicks claim, but the solver must not claim WBTC until exact CBTC delivery/accept proof exists.",
    completionProof: [
      "Loop CBTC delivery update id",
      "Loop direct-delivery proof or exact offer-accept update id",
      "EVM solver WBTC claim tx"
    ],
    refundPath:
      "User retakes WBTC after EVM timelock if delivery/settlement does not complete."
  },
  {
    key: "htlc-reverse-managed",
    atomicity: "atomic",
    userSigns: ["secret reveal / WBTC claim on EVM"],
    userFundsMove:
      "CBTC is locked in the custom Canton HTLC before solver WBTC is locked.",
    solverFundsMove: "WBTC is locked on EVM for the user.",
    preimagePublic: "When the user claims WBTC on EVM.",
    completionProof: [
      "EVM user WBTC claim tx",
      "Canton solver CBTC claim update id"
    ],
    refundPath:
      "User refunds CBTC after Canton timelock when WBTC was not claimed."
  },
  {
    key: "htlc-reverse-loop",
    atomicity: "trust-minimized",
    userSigns: [
      "Loop standard CBTC transfer to venue custody",
      "secret reveal / WBTC claim on EVM"
    ],
    userFundsMove:
      "CBTC custody transfer must be exactly order-bound before solver WBTC is locked.",
    solverFundsMove: "WBTC is locked on EVM for the user.",
    preimagePublic: "When the user claims WBTC on EVM.",
    completionProof: [
      "Loop custody transfer proof",
      "EVM user WBTC claim tx"
    ],
    refundPath:
      "Venue returns custodied CBTC if solver WBTC lock does not happen or user does not claim."
  },
  {
    key: "c2c-managed",
    atomicity: "atomic",
    userSigns: [],
    userFundsMove:
      "Managed user sell leg and vault counter leg settle in one backend Canton transaction where preapprovals permit.",
    solverFundsMove: "Vault counter leg is included in the same fill transaction.",
    preimagePublic: "Not applicable.",
    completionProof: ["Canton settlement update id"],
    refundPath: "Order fails/rolls back before user funds are consumed."
  },
  {
    key: "c2c-loop",
    atomicity: "trust-minimized",
    userSigns: [
      "Loop standard sell transfer offer",
      "Loop standard accept if vault counter leg creates an offer"
    ],
    userFundsMove:
      "Loop sell offer must be exactly order-bound before vault fill.",
    solverFundsMove:
      "Vault fill consumes the exact sell offer and delivers/creates the exact counter leg.",
    preimagePublic: "Not applicable.",
    completionProof: [
      "Exact user sell offer proof",
      "Canton settlement update id",
      "Direct counter delivery proof or exact counter offer accept update id"
    ],
    refundPath:
      "Unfilled sell offers expire/cancel; pending counter offers remain user-acceptable/recoverable."
  }
];

export function htlcFlowKey(
  order: Pick<SwapOrder, "direction" | "counterMode">
): SwapFlowKey {
  if (order.direction === "evm-to-canton") {
    return order.counterMode === "loop"
      ? "htlc-forward-loop"
      : "htlc-forward-managed";
  }
  return order.counterMode === "loop"
    ? "htlc-reverse-loop"
    : "htlc-reverse-managed";
}

export function c2cFlowKey(
  order: Pick<CantonSwapOrder, "walletMode">
): SwapFlowKey {
  return order.walletMode === "loop" ? "c2c-loop" : "c2c-managed";
}

export function htlcForwardLoopDeliveryProven(
  order: Pick<
    SwapOrder,
    | "direction"
    | "counterMode"
    | "counterTransferUpdateId"
    | "counterClaimUpdateId"
  >
): boolean {
  if (order.direction !== "evm-to-canton" || order.counterMode !== "loop") {
    return true;
  }
  return !!order.counterTransferUpdateId && !!order.counterClaimUpdateId;
}

export function htlcCounterClaimProofPresent(
  order: Pick<
    SwapOrder,
    "direction" | "counterMode" | "counterClaimUpdateId" | "counterTransferUpdateId"
  >
): boolean {
  if (order.direction === "evm-to-canton" && order.counterMode === "loop") {
    return htlcForwardLoopDeliveryProven(order);
  }
  if (order.direction === "evm-to-canton") {
    return !!order.counterClaimUpdateId;
  }
  if (order.counterMode === "loop") {
    return !!order.counterTransferUpdateId;
  }
  return !!order.counterClaimUpdateId;
}

export function htlcCanExposePreimageToSolver(
  order: Pick<
    SwapOrder,
    | "status"
    | "direction"
    | "counterMode"
    | "revealedPreimage"
    | "counterTransferUpdateId"
    | "counterClaimUpdateId"
  >
): { ok: true } | { ok: false; reason: string } {
  if (order.status !== "counter_claimed" && order.status !== "main_claimed") {
    return { ok: false, reason: "counter not claimed yet" };
  }
  if (!order.revealedPreimage) {
    return { ok: false, reason: "preimage not revealed yet" };
  }
  if (
    order.direction === "evm-to-canton" &&
    order.counterMode === "loop" &&
    !htlcForwardLoopDeliveryProven(order)
  ) {
    return {
      ok: false,
      reason:
        "Loop CBTC delivery/accept proof missing — refusing solver EVM claim"
    };
  }
  if (
    order.direction === "evm-to-canton" &&
    order.counterMode !== "loop" &&
    !order.counterClaimUpdateId
  ) {
    return {
      ok: false,
      reason: "managed CBTC claim proof missing — refusing solver EVM claim"
    };
  }
  return { ok: true };
}

export function htlcCanMarkComplete(
  order: Pick<
    SwapOrder,
    | "status"
    | "direction"
    | "counterMode"
    | "revealedPreimage"
    | "counterTransferUpdateId"
    | "counterClaimUpdateId"
    | "mainClaimTx"
  >
): { ok: true } | { ok: false; reason: string } {
  if (order.direction === "evm-to-canton") {
    const preimage = htlcCanExposePreimageToSolver(order);
    if (!preimage.ok) return preimage;
    if (!order.mainClaimTx && order.status === "main_claimed") {
      return { ok: false, reason: "solver WBTC claim tx missing" };
    }
    return { ok: true };
  }

  if (order.status !== "main_claimed") {
    return { ok: false, reason: "reverse swap not finalized" };
  }
  if (!htlcUserWbtcClaimTx({ ...order, direction: "canton-to-evm" })) {
    return { ok: false, reason: "user WBTC claim tx missing" };
  }
  if (!htlcCounterClaimProofPresent(order)) {
    return { ok: false, reason: "Canton custody/claim proof missing" };
  }
  return { ok: true };
}

export function htlcVisibleCompleted(
  order: Pick<
    SwapOrder,
    | "status"
    | "direction"
    | "counterMode"
    | "revealedPreimage"
    | "counterTransferUpdateId"
    | "counterClaimUpdateId"
    | "mainClaimTx"
  >
): boolean {
  if (order.status !== "main_claimed") return false;
  return htlcCanMarkComplete(order).ok;
}

export function c2cCounterLegProofPresent(
  order: Pick<
    CantonSwapOrder,
    "status" | "settlementUpdateId" | "counterLegOfferCid" | "counterReceiptUpdateId"
  >
): boolean {
  if (!order.settlementUpdateId) return false;
  if (order.counterLegOfferCid && !order.counterReceiptUpdateId) return false;
  if (!order.counterLegOfferCid && !order.counterReceiptUpdateId) return false;
  return true;
}

export function c2cVisibleCompleted(
  order: Pick<
    CantonSwapOrder,
    "status" | "settlementUpdateId" | "counterLegOfferCid" | "counterReceiptUpdateId"
  >
): boolean {
  return order.status === "filled" && c2cCounterLegProofPresent(order);
}

