/** Shared HTLC swap order types (R5) — used by the service + the persistence store. */

export type SwapDirection = "evm-to-canton" | "canton-to-evm";

export type SwapStatus =
  | "open"
  | "accepted"
  | "main_locking"
  | "main_locked"
  | "counter_locking"
  | "counter_locked"
  | "counter_claimed"
  | "main_claimed"
  /** Transient: refund claimed (CAS) but the on-ledger return transfer may not have
   *  completed yet. A crash here is recoverable — the reconcile/sweep retries the
   *  transfer (idempotent via deterministic commandId) and advances to refunded. */
  | "refunding"
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
  /** canton-to-evm: the SOLVER's EVM WBTC lock tx (the counter leg). */
  counterLockTx?: string;
  counterClaimUpdateId?: string;
  revealedPreimage?: `0x${string}`;
  mainClaimTx?: string;
  createdAt: number;
  /** Unix seconds of the last persisted row update. Used for transient-state TTLs. */
  updatedAt?: number;
  counterMode?: "managed" | "loop";
  allocationCid?: string;
  htlcCid?: string;
  htlcBlob?: string;
  counterTransferOfferCid?: string;
  counterTransferUpdateId?: string;
  /** Loop reverse seller: solver CBTC holding CIDs at accept — new custody must not be in this set. */
  solverCustodyBaselineCids?: string[];
  /** Durable reservation while a reverse WBTC counter-lock submit is in flight. */
  evmFloatReserved?: boolean;
  /** Bound network fee CC from quote (managed paths). */
  networkFeeCc?: string;
  networkFeeExpiresAt?: number;
  /** Legacy fee preapproval binding; Loop HTLC fees are no longer separately charged. */
  networkFeePreapprovalCid?: string;
  networkFeeSettlementUpdateId?: string;
  networkFeeAccountingPending?: boolean;
}
