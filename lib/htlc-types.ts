/** Shared HTLC swap order types (R5) — used by the service + the persistence store. */

export type SwapDirection = "evm-to-canton" | "canton-to-evm";

export type SwapStatus =
  | "open"
  | "accepted"
  | "main_locked"
  | "counter_locked"
  | "counter_claimed"
  | "main_claimed"
  | "refunded"
  | "cancelled"
  | "failed";

export interface SwapOrder {
  id: string;
  direction: SwapDirection;
  status: SwapStatus;
  hashLock: `0x${string}`;
  userEvmAddress?: string;
  solverEvmAddress?: string;
  wbtcAmount?: string;
  userTimelock: number;
  userCantonParty: string;
  solverCantonParty: string;
  cbtcAmount?: string;
  solverTimelock: number;
  mainLockTx?: string;
  /** canton-to-evm: solver WBTC lock on EVM. */
  counterLockTx?: string;
  /**
   * Canton claim update id.
   * - evm-to-canton: user's CBTC claim (claim-managed / Loop).
   * - canton-to-evm: solver CBTC claim (claim-main) after user reveals on EVM.
   */
  counterClaimUpdateId?: string;
  revealedPreimage?: `0x${string}`;
  /**
   * EVM WBTC claim tx hash.
   * - evm-to-canton: solver claims WBTC after user reveals (main-claim).
   * - canton-to-evm: user claims WBTC in MetaMask (claim-record); may be
   *   "already-claimed" on forward solver path only.
   */
  mainClaimTx?: string;
  createdAt: number;
  counterMode?: "managed" | "loop";
  allocationCid?: string;
  htlcCid?: string;
  htlcBlob?: string;
  counterTransferOfferCid?: string;
  counterTransferUpdateId?: string;
  /** Bound network fee CC from quote (managed paths). */
  networkFeeCc?: string;
  networkFeeExpiresAt?: number;
}
