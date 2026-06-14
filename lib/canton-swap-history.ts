import type { CantonSwapOrder } from "./canton-swap-types";
import { isLoopFillPendingCounterAccept } from "./canton-swap-order-logic";

/** Shape compatible with /orders HistoryOrder table. */
export interface CantonSwapHistoryRow {
  id: string;
  direction: "canton-swap";
  status: string;
  wbtcAmount: string;
  cbtcAmount: string;
  userCantonParty?: string;
  solverCantonParty?: string;
  createdAt: number;
  counterMode?: string;
  mainLeg: { asset: string; amount: string };
  counterLeg: { asset: string; amount: string };
  counterTransferOfferCid?: string;
  settlementUpdateId?: string;
  failureReason?: string;
  walletMode?: string;
}

export function mapCantonSwapToHistoryRow(
  o: CantonSwapOrder
): CantonSwapHistoryRow {
  return {
    id: o.id,
    direction: "canton-swap",
    status: o.status,
    wbtcAmount: "0",
    cbtcAmount: "0",
    userCantonParty: o.userParty,
    solverCantonParty: o.solverParty,
    createdAt: o.createdAt,
    counterMode: o.walletMode,
    walletMode: o.walletMode,
    mainLeg: { asset: o.fromAsset, amount: o.inAmount },
    counterLeg: { asset: o.toAsset, amount: o.outAmount },
    counterTransferOfferCid: o.counterLegOfferCid,
    settlementUpdateId: o.settlementUpdateId,
    failureReason: o.failureReason
  };
}

export function isCantonSwapHistoryRow(
  o: { direction?: string }
): o is CantonSwapHistoryRow {
  return o.direction === "canton-swap";
}

export function cantonSwapPayReceive(o: CantonSwapHistoryRow): {
  pay: string;
  receive: string;
} {
  return {
    pay: `${o.mainLeg.amount} ${o.mainLeg.asset}`,
    receive: `${o.counterLeg.amount} ${o.counterLeg.asset}`
  };
}

export function needsCantonSwapCounterAccept(o: CantonSwapHistoryRow): boolean {
  if (o.walletMode !== "loop" || o.status !== "user_locked") return false;
  if (!o.counterTransferOfferCid || !o.settlementUpdateId) return false;
  return true;
}

/** Same detection from a live order row (no failureReason substring). */
export function orderNeedsCounterAccept(o: CantonSwapOrder): boolean {
  return isLoopFillPendingCounterAccept(o);
}
