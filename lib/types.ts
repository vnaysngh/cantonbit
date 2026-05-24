/**
 * Shared types for Canton Ledger API v2 interactions.
 *
 * These mirror the JSON Ledger API schema (docs.daml.com/json-api) and the
 * CN Token Standard interfaces (Splice.Api.Token.HoldingV1 /
 * TransferInstructionV1). Fields the app doesn't use today are kept as
 * `Record<string, unknown>` rather than guessed-at strict types — better to
 * leave them open than to encode the wrong shape.
 */

/* ---------- Token Standard ---------- */

export interface InstrumentId {
  admin: string;
  id: string;
}

/** Decoded payload of a Splice.Api.Token.HoldingV1:Holding contract. */
export interface HoldingPayload {
  owner: string;
  instrumentId: InstrumentId;
  /** Decimal amount as a string. cBTC is denominated in BTC units. */
  amount: string;
  /** Optional lock metadata if the holding is locked. */
  lock?: Record<string, unknown> | null;
  /** Extra metadata bag — varies per registrar. */
  meta?: Record<string, unknown>;
}

/** App-facing view of an on-ledger Holding contract. */
export interface Holding {
  contractId: string;
  payload: HoldingPayload;
  /**
   * Base64-encoded created-event blob. Required when re-using this contract
   * as a `disclosedContracts` entry on a later choice exercise.
   */
  createdEventBlob?: string;
}

/** Decoded payload of a Splice.Api.Token.TransferInstructionV1:TransferInstruction contract. */
export interface TransferPayload {
  sender: string;
  receiver: string;
  amount: string;
  instrumentId: InstrumentId;
  /** Status of the transfer instruction (e.g. "pending"). Shape varies. */
  status?: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

export interface Transfer {
  contractId: string;
  payload: TransferPayload;
  createdEventBlob?: string;
}

/* ---------- Ledger API command/response shapes ---------- */

/**
 * A single ledger command. We only model ExerciseCommand today; CreateCommand
 * and CreateAndExerciseCommand can be added when a screen needs them.
 */
export interface ExerciseCommand {
  ExerciseCommand: {
    templateId: string;
    contractId: string;
    choice: string;
    choiceArgument: unknown;
  };
}

export type DAMLCommand = ExerciseCommand;

/** Disclosed contract for re-using off-ledger contract data in a command. */
export interface DisclosedContract {
  contractId: string;
  createdEventBlob: string;
  /** synchronizerId on some Canton versions; participantId on older ones. */
  synchronizerId?: string;
}

/** Body shape for /v2/commands/submit-and-wait-for-transaction-tree. */
export interface SubmitAndWaitRequest {
  commands: DAMLCommand[];
  workflowId: string;
  applicationId: string;
  commandId: string;
  actAs: string[];
  readAs?: string[];
  disclosedContracts?: DisclosedContract[];
  /** ISO-8601 deduplication duration, optional. */
  deduplicationPeriod?: { Empty: object } | { Duration: { duration: string } };
}

/**
 * Loose model of the transaction-tree response. We expose the whole shape
 * to callers; downstream code picks out updateId / eventsById as needed.
 */
export interface TransactionTree {
  updateId: string;
  commandId?: string;
  workflowId?: string;
  effectiveAt?: string;
  /** Canton v2 offset is a monotonic JSON number (verified DevNet 2026-05-23). */
  offset?: number;
  eventsById?: Record<string, unknown>;
  rootEventIds?: string[];
  [key: string]: unknown;
}

/* ---------- Activity history (UI display) ---------- */

export type ActivityKind = "sent" | "received" | "minted" | "redeemed";

export interface ActivityRow {
  id: string;
  kind: ActivityKind;
  /** Decimal BTC amount as a string. */
  amount: string;
  /** Counterparty party id, or destination BTC address for redemptions. */
  counterparty: string;
  /** ISO timestamp. */
  timestamp: string;
  status: "complete" | "pending" | "failed";
  /** Canton update id or Bitcoin txid, for display. */
  txid?: string;
}

/* ---------- cBTC ledger-side shapes ---------- */

/**
 * On-ledger CBTCDepositAccount contract — the user's bridge-side container
 * for incoming BTC deposits. Created by exercising the
 * CBTCDepositAccountRules_CreateDepositAccount choice.
 */
export interface DepositAccount {
  contractId: string;
  /** Raw createArgument payload from the ledger. */
  payload: Record<string, unknown>;
  createdEventBlob?: string;
}

/**
 * On-ledger CBTCWithdrawAccount contract — the user's bridge-side container
 * for outgoing BTC withdrawals, parameterised with the destination address.
 */
export interface WithdrawAccount {
  contractId: string;
  payload: Record<string, unknown>;
  createdEventBlob?: string;
}

/**
 * On-ledger CBTCWithdrawRequest contract — created by the coordinator after
 * the user exercises Withdraw; tracked to show progress to the user.
 */
export interface WithdrawRequest {
  contractId: string;
  payload: Record<string, unknown>;
  createdEventBlob?: string;
}
