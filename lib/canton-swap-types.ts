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
  /** C2C vault party — receives user sell and pays counter (same as settlementParty). */
  solverParty: string;
  /** Vault party for user sell receiver (no preapproval). Same id as solverParty for C2C. */
  settlementParty?: string;
  walletMode: CantonSwapWalletMode;
  userLegOfferCid?: string;
  /** Loop submit update id proving user signed sell leg. */
  userLegSubmitUpdateId?: string;
  counterLegOfferCid?: string;
  settlementUpdateId?: string;
  /** Incremented on each successful counter reissue submit (deterministic command id). */
  counterReissueAttempt?: number;
  /** Unix seconds when counter offer left user pending ACS (reissue cooldown starts). */
  counterPendingClearedAt?: number;
  failureReason?: string;
  createdAt: number;
  /** CC network fee charged atomically at settle (managed). */
  networkFeeCc?: string;
  /** Unix seconds — network fee estimate valid until (matches quote expiry). */
  networkFeeExpiresAt?: number;
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

/** Vault party for all C2C legs (receive user sell + pay counter). */
export function swapParty(o: CantonSwapOrder): string {
  return o.settlementParty ?? o.solverParty;
}

/** Party that receives the user sell leg (pending offer ACS). */
export function userLegReceiverParty(o: CantonSwapOrder): string {
  return swapParty(o);
}

/** actAs parties for atomic fill (Accept + counter deliver from vault). */
export function loopFillActAsParties(o: CantonSwapOrder): string[] {
  return [swapParty(o)];
}

/** actAs for managed fill with network fee (user CC leg + vault legs). */
export function managedFillActAsParties(
  o: CantonSwapOrder,
  withNetworkFee: boolean
): string[] {
  if (withNetworkFee) return [o.userParty, swapParty(o)];
  return loopFillActAsParties(o);
}
