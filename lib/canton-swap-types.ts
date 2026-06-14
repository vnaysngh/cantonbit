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
  walletMode: CantonSwapWalletMode;
  userLegOfferCid?: string;
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
