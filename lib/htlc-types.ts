/** Shared HTLC swap order types (R5) — used by the service + the persistence store. */

export type SwapDirection = "evm-to-canton" | "canton-to-evm";

export type SwapStatus =
  | "open" | "accepted" | "main_locked" | "counter_locked"
  | "counter_claimed" | "main_claimed" | "refunded" | "cancelled" | "failed";

export interface SwapOrder {
  id: string;
  direction: SwapDirection;
  status: SwapStatus;
  hashLock: `0x${string}`;
  userEvmAddress: string;
  solverEvmAddress: string;
  wbtcAmount: string;
  userTimelock: number;
  userCantonParty: string;
  solverCantonParty: string;
  cbtcAmount: string;
  solverTimelock: number;
  mainLockTx?: string;
  counterClaimUpdateId?: string;
  revealedPreimage?: `0x${string}`;
  mainClaimTx?: string;
  createdAt: number;
  // on-ledger HTLC (the DAR path)
  allocationCid?: string;
  htlcCid?: string;
  htlcBlob?: string;
}
