/** Same-Canton intent swap orders (not HTLC). */

import type { CantonSwapAssetId } from "./canton-assets";

export type CantonSwapMvpAssetId = "CBTC" | "CC";

export type CantonSwapStatus =
  | "open"
  | "settling"
  | "filling"
  | "user_locked"
  | "filled"
  | "expired"
  | "failed"
  | "cancelled";

export type CantonSwapWalletMode = "managed" | "loop";

export interface CantonSwapOrder {
  id: string;
  status: CantonSwapStatus;
  fromAsset: CantonSwapMvpAssetId;
  toAsset: CantonSwapMvpAssetId;
  /** Decimal string at native asset precision. */
  inAmount: string;
  outAmount: string;
  /** Minimum output guaranteed at order time (same as outAmount for MVP). */
  minOut: string;
  quoteExpiresAt: number;
  userParty: string;
  solverParty: string;
  /** Loop user sell-leg receiver (no preapproval). Counter leg still from solverParty. */
  settlementParty?: string;
  walletMode: CantonSwapWalletMode;
  userLegOfferCid?: string;
  /** Loop submit update id proving user signed sell leg. */
  userLegSubmitUpdateId?: string;
  /** Solver holding CID from preapproval auto-accept (bound to this order). */
  userLegInboundHoldingCid?: string;
  counterLegOfferCid?: string;
  settlementUpdateId?: string;
  failureReason?: string;
  createdAt: number;
}

export function isCantonSwapMvpPair(
  from: CantonSwapAssetId,
  to: CantonSwapAssetId
): from is CantonSwapMvpAssetId {
  return (
    from !== to &&
    (from === "CBTC" || from === "CC") &&
    (to === "CBTC" || to === "CC")
  );
}

export const CANTON_SWAP_TERMINAL: CantonSwapStatus[] = [
  "filled",
  "expired",
  "failed",
  "cancelled"
];

export function isCantonSwapActive(o: CantonSwapOrder): boolean {
  return !CANTON_SWAP_TERMINAL.includes(o.status);
}

/** Party that receives the Loop user sell leg (pending offer ACS). */
export function userLegReceiverParty(o: CantonSwapOrder): string {
  return o.settlementParty ?? o.solverParty;
}

/** actAs parties for atomic Loop fill (accept on receiver + deliver from solver). */
export function loopFillActAsParties(o: CantonSwapOrder): string[] {
  const receiver = userLegReceiverParty(o);
  if (receiver === o.solverParty) return [o.solverParty];
  return [receiver, o.solverParty];
}
