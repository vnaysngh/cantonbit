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
  userEvmAddress: string;
  solverEvmAddress: string;
  wbtcAmount: string;
  userTimelock: number;
  userCantonParty: string;
  solverCantonParty: string;
  cbtcAmount: string;
  solverTimelock: number;
  mainLockTx?: string;
  /** canton-to-evm: the SOLVER's EVM WBTC lock tx (the counter leg). */
  counterLockTx?: string;
  counterClaimUpdateId?: string;
  revealedPreimage?: `0x${string}`;
  mainClaimTx?: string;
  createdAt: number;
  // How the CBTC counter-leg is settled:
  //   "managed" — participant-managed (email) user: on-ledger HtlcLock, backend
  //               claims via CanActAs. Fully trustless (on-ledger keccak gate).
  //   "loop"    — Loop-wallet user: their party is on Loop's node where our DAR
  //               CANNOT run, so we use Loop's Option 1 — the solver delivers CBTC
  //               via a STANDARD transfer that auto-accepts in the user's wallet.
  //               All secret/claim logic stays on OUR node. Defaults to "managed"
  //               when unset so existing orders keep the proven behavior.
  counterMode?: "managed" | "loop";
  // on-ledger HTLC (the DAR path — "managed" only)
  allocationCid?: string;
  htlcCid?: string;
  htlcBlob?: string;
  // standard-transfer counter-leg (the "loop" path): the TransferInstruction offer cid.
  counterTransferOfferCid?: string;
  counterTransferUpdateId?: string;
}
