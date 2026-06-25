/**
 * Pure user-leg / counter-leg evidence parsing from Canton transaction trees.
 * No server-only — safe for unit tests.
 */
import { toBaseUnits, toBaseUnitsFloor } from "./amount-units";
import { getSwapAsset, matchesInstrument } from "./canton-assets";
import type { InstrumentId } from "./constants";
import type { CantonSwapMvpAssetId, CantonSwapOrder } from "./canton-swap-types";
import { swapParty } from "./canton-swap-types";
import {
  isLegacySwapMemo,
  isOrderBoundSwapMemo,
  transferMemoFromMeta
} from "./swap-transfer-memo";
import { readTransferInstructionPayload } from "./transfer-instruction-read";

export interface UserLegEvidence {
  /** Pending TransferInstruction on solver ACS. */
  offerCid?: string;
  /** Solver holding created by preapproval auto-accept. */
  inboundHoldingCid?: string;
}

export interface CounterOfferMatchParams {
  senderParty: string;
  receiverParty: string;
  amount: string;
  amountDecimals: number;
  expectedInstrument?: InstrumentId;
  expectedMemo?: string;
}

function isHoldingTemplate(templateId: string): boolean {
  return (
    templateId.includes("Utility.Registry.Holding") ||
    templateId.includes("Splice.Amulet") ||
    templateId.includes("HoldingV1:Holding")
  );
}

function isTransferInstructionTemplate(templateId: string): boolean {
  return (
    templateId.includes("TransferInstruction") ||
    templateId.includes("TransferOffer")
  );
}

function amountsEqual(expected: string, actual: string, decimals: number): boolean {
  try {
    return toBaseUnitsFloor(actual, decimals) === toBaseUnits(expected, decimals);
  } catch {
    return false;
  }
}

function transferMemoMatches(
  meta: Record<string, unknown> | undefined,
  expectedMemo: string | undefined
): boolean {
  if (!expectedMemo) return true;
  const memo = transferMemoFromMeta(meta);
  if (memo === expectedMemo) return true;
  if (isOrderBoundSwapMemo(memo)) return false;
  return isLegacySwapMemo(memo);
}

function createdEventFromNode(node: unknown): {
  contractId?: string;
  templateId?: string;
  createArgument?: unknown;
  interfaceViews?: Array<{
    interfaceId?: string;
    viewValue?: unknown;
    viewStatus?: { code?: number };
  }>;
} | null {
  const n = node as {
    CreatedTreeEvent?: { value?: Record<string, unknown> };
    CreatedEvent?: Record<string, unknown>;
  };
  const created = (n.CreatedTreeEvent?.value ?? n.CreatedEvent) as
    | {
        contractId?: string;
        templateId?: string;
        createArgument?: unknown;
        interfaceViews?: Array<{
          interfaceId?: string;
          viewValue?: unknown;
          viewStatus?: { code?: number };
        }>;
      }
    | undefined;
  return created?.contractId ? created : null;
}

function exercisedEventFromNode(node: unknown): {
  templateId?: string;
  choice?: string;
  choiceArgument?: unknown;
  exerciseResult?: unknown;
} | null {
  const n = node as {
    ExercisedTreeEvent?: { value?: Record<string, unknown> };
    ExercisedEvent?: Record<string, unknown>;
  };
  return (n.ExercisedTreeEvent?.value ?? n.ExercisedEvent ?? null) as {
    templateId?: string;
    choice?: string;
    choiceArgument?: unknown;
    exerciseResult?: unknown;
  } | null;
}

/** Parse user sell leg proof from a Loop submit or ledger update tree. */
export function parseUserLegEvidenceFromEvents(
  eventsById: Record<string, unknown> | null | undefined,
  params: {
    userParty: string;
    solverParty: string;
    inAmount: string;
    fromAsset: CantonSwapMvpAssetId;
    expectedInstrument: InstrumentId;
    expectedMemo?: string;
    strictOrderBoundMemo?: boolean;
  }
): UserLegEvidence | null {
  if (!eventsById) return null;
  const decimals = getSwapAsset(params.fromAsset).decimals;
  let offerCid: string | undefined;
  let inboundHoldingCid: string | undefined;

  for (const node of Object.values(eventsById)) {
    const created = createdEventFromNode(node);
    if (!created?.contractId || !created.templateId) continue;

    if (isTransferInstructionTemplate(created.templateId)) {
      const transfer = readTransferInstructionPayload(created);
      if (!transfer) continue;
      if (transfer.sender !== params.userParty) continue;
      if (transfer.receiver !== params.solverParty) continue;
      if (!amountsEqual(params.inAmount, transfer.amount, decimals)) continue;
      if (!matchesInstrument(transfer.instrumentId, params.expectedInstrument)) {
        continue;
      }
      if (!transferMemoMatches(transfer.meta, params.expectedMemo)) continue;
      offerCid = created.contractId;
      continue;
    }

    if (isHoldingTemplate(created.templateId)) {
      const arg = created.createArgument as
        | {
            owner?: string;
            amount?: string;
            instrumentId?: { id?: string };
            instrument?: { id?: string };
          }
        | undefined;
      const owner = arg?.owner;
      const amount = arg?.amount;
      if (owner !== params.solverParty || !amount) continue;
      if (!amountsEqual(params.inAmount, amount, decimals)) continue;
      const holdingInst = arg?.instrumentId ?? arg?.instrument;
      if (
        holdingInst?.id &&
        !matchesInstrument(holdingInst, params.expectedInstrument)
      ) {
        continue;
      }
      inboundHoldingCid = created.contractId;
    }
  }

  if (offerCid) return { offerCid, inboundHoldingCid };
  if (inboundHoldingCid) {
    if (
      params.strictOrderBoundMemo &&
      params.expectedMemo &&
      !transferExerciseWithOrderMemo(eventsById, params.expectedMemo)
    ) {
      return null;
    }
    return { inboundHoldingCid };
  }
  return null;
}

function transferExerciseWithOrderMemo(
  eventsById: Record<string, unknown> | null | undefined,
  expectedMemo: string
): boolean {
  if (!eventsById) return false;
  for (const node of Object.values(eventsById)) {
    const exercised = exercisedEventFromNode(node);
    if (!exercised?.choice) continue;
    if (
      !exercised.choice.includes("Transfer") ||
      exercised.choice.includes("Accept") ||
      exercised.choice.includes("Reject")
    ) {
      continue;
    }
    const arg = exercised.choiceArgument as
      | {
          meta?: Record<string, unknown>;
          transfer?: { meta?: Record<string, unknown> };
        }
      | undefined;
    const meta = arg?.transfer?.meta ?? arg?.meta;
    if (transferMemoFromMeta(meta) === expectedMemo) return true;
  }
  return false;
}

/** True when a transaction tree consumed a counter offer via Accept. */
export function counterOfferConsumedInEvents(
  eventsById: Record<string, unknown> | null | undefined,
  offerCid: string
): boolean {
  if (!eventsById) return false;
  for (const node of Object.values(eventsById)) {
    const n = node as {
      ExercisedTreeEvent?: { value?: { contractId?: string; choice?: string } };
      ExercisedEvent?: { contractId?: string; choice?: string };
    };
    const exercised = n.ExercisedTreeEvent?.value ?? n.ExercisedEvent;
    if (!exercised?.contractId || exercised.contractId !== offerCid) continue;
    const choice = exercised.choice ?? "";
    if (choice.includes("Accept")) return true;
  }
  return false;
}

/** Reject preapproval direct-settle path — Loop swaps require pending offer only. */
export function assertOfferOnlyUserLegEvidence(evidence: UserLegEvidence): void {
  if (evidence.inboundHoldingCid && !evidence.offerCid) {
    throw new Error(
      "user leg settled via preapproval auto-accept — swap requires pending transfer offer"
    );
  }
  if (!evidence.offerCid) {
    throw new Error("user leg submit update does not prove pending offer");
  }
}

/** Select counter-leg offer CID from fill transaction (not accept-leg artifacts). */
export function extractCounterOfferCidFromEvents(
  eventsById: Record<string, unknown> | null | undefined,
  match: CounterOfferMatchParams
): string | null {
  if (!eventsById) return null;
  const hits: string[] = [];

  for (const node of Object.values(eventsById)) {
    const created = createdEventFromNode(node);
    if (!created?.contractId || !created.templateId) continue;
    if (!isTransferInstructionTemplate(created.templateId)) continue;

    const transfer = readTransferInstructionPayload(created);
    if (!transfer) continue;
    if (transfer.sender !== match.senderParty) continue;
    if (transfer.receiver !== match.receiverParty) continue;
    if (!amountsEqual(match.amount, transfer.amount, match.amountDecimals)) {
      continue;
    }
    if (
      match.expectedInstrument &&
      transfer.instrumentId?.id &&
      !matchesInstrument(transfer.instrumentId, match.expectedInstrument)
    ) {
      continue;
    }
    if (!transferMemoMatches(transfer.meta, match.expectedMemo)) continue;
    hits.push(created.contractId);
  }

  return hits.length ? hits[hits.length - 1]! : null;
}

function amuletMemoMatches(
  arg: { description?: string; meta?: Record<string, unknown> } | undefined,
  expectedMemo: string | undefined
): boolean {
  if (!expectedMemo) return true;
  if (arg?.description === expectedMemo) return true;
  return transferMemoMatches(arg?.meta, expectedMemo);
}

function amuletReceiverCredited(
  changes: Array<[string, { changeToInitialAmountAsOfRoundZero?: string }]>,
  receiverParty: string
): boolean {
  return changes.some(([party, change]) => {
    if (party !== receiverParty) return false;
    const delta = change?.changeToInitialAmountAsOfRoundZero;
    if (typeof delta !== "string") return false;
    const trimmed = delta.trim();
    return trimmed !== "" && !trimmed.startsWith("-");
  });
}

function amuletSenderDebited(
  changes: Array<[string, { changeToInitialAmountAsOfRoundZero?: string }]>,
  senderParty: string
): boolean {
  return changes.some(([party, change]) => {
    if (party !== senderParty) return false;
    const delta = change?.changeToInitialAmountAsOfRoundZero;
    return typeof delta === "string" && delta.trim().startsWith("-");
  });
}

/** True when counter asset reached the user via direct transfer (holding created). */
export function counterLegDeliveredToUserInEvents(
  eventsById: Record<string, unknown> | null | undefined,
  params: {
    senderParty: string;
    receiverParty: string;
    amount: string;
    amountDecimals: number;
    expectedInstrument: InstrumentId;
    expectedMemo?: string;
  }
): boolean {
  if (!eventsById) return false;

  if (params.expectedInstrument.id === "Amulet") {
    if (amuletDirectDeliveryProvenInEvents(eventsById, params)) return true;
  }

  let receiverHoldingProven = false;
  for (const node of Object.values(eventsById)) {
    const created = createdEventFromNode(node);
    if (!created?.contractId || !created.templateId) continue;
    if (!isHoldingTemplate(created.templateId)) continue;

    const arg = created.createArgument as
      | {
          owner?: string;
          amount?: string;
          instrumentId?: { admin?: string; id?: string };
          instrument?: { admin?: string; id?: string };
        }
      | undefined;
    if (arg?.owner !== params.receiverParty || !arg.amount) continue;
    if (!amountsEqual(params.amount, arg.amount, params.amountDecimals)) continue;
    const holdingInst = arg.instrumentId ?? arg.instrument;
    if (holdingInst?.id && holdingInst.id !== params.expectedInstrument.id) {
      continue;
    }
    if (
      holdingInst?.admin &&
      !matchesInstrument(holdingInst, params.expectedInstrument)
    ) {
      continue;
    }
    receiverHoldingProven = true;
    break;
  }

  return (
    receiverHoldingProven &&
    directSettlementBindsSender(eventsById, params)
  );
}

/** CC/Amulet often credits via balanceChanges — no registry holding in the tree. */
function amuletDirectDeliveryProvenInEvents(
  eventsById: Record<string, unknown>,
  params: {
    senderParty: string;
    receiverParty: string;
    amount: string;
    amountDecimals: number;
    expectedMemo?: string;
  }
): boolean {
  for (const node of Object.values(eventsById)) {
    const ex = exercisedEventFromNode(node);
    if (!ex?.choice) continue;

    if (ex.choice === "TransferPreapproval_SendV2") {
      const arg = ex.choiceArgument as
        | {
            sender?: string;
            amount?: string;
            description?: string;
            meta?: Record<string, unknown>;
          }
        | undefined;
      if (arg?.sender !== params.senderParty) continue;
      if (!amountsEqual(params.amount, arg.amount ?? "", params.amountDecimals)) {
        continue;
      }
      if (!amuletMemoMatches(arg, params.expectedMemo)) continue;
      const result = ex.exerciseResult as
        | {
            result?: {
              summary?: {
                balanceChanges?: Array<
                  [string, { changeToInitialAmountAsOfRoundZero?: string }]
                >;
              };
            };
          }
        | undefined;
      const changes = result?.result?.summary?.balanceChanges ?? [];
      if (
        amuletSenderDebited(changes, params.senderParty) &&
        amuletReceiverCredited(changes, params.receiverParty)
      ) {
        return true;
      }
    }
  }
  return false;
}

function isDirectTransferKind(kind: string): boolean {
  const k = kind.toLowerCase();
  return k === "direct" || k === "self" || k.includes("direct");
}

function signedAmountMatches(
  value: unknown,
  amount: string,
  decimals: number,
  sign: "positive" | "negative"
): boolean {
  if (typeof value !== "string") return false;
  const negative = value.trim().startsWith("-");
  if ((sign === "negative") !== negative) return false;
  const absolute = negative ? value.trim().slice(1) : value.trim();
  return amountsEqual(amount, absolute, decimals);
}

function transferFieldsMatchDirectSettlement(
  transfer:
    | {
        sender?: string;
        receiver?: string;
        amount?: string;
        instrumentId?: InstrumentId;
        meta?: Record<string, unknown>;
      }
    | undefined,
  params: {
    senderParty: string;
    receiverParty: string;
    amount: string;
    amountDecimals: number;
    expectedInstrument: InstrumentId;
    expectedMemo?: string;
  }
): boolean {
  if (!transfer) return false;
  return (
    transfer.sender === params.senderParty &&
    transfer.receiver === params.receiverParty &&
    amountsEqual(params.amount, transfer.amount ?? "", params.amountDecimals) &&
    (!transfer.instrumentId ||
      matchesInstrument(transfer.instrumentId, params.expectedInstrument)) &&
    transferMemoMatches(transfer.meta, params.expectedMemo)
  );
}

/** Prove the direct settlement was debited from the expected sender. */
function directSettlementBindsSender(
  eventsById: Record<string, unknown>,
  params: {
    senderParty: string;
    receiverParty: string;
    amount: string;
    amountDecimals: number;
    expectedInstrument: InstrumentId;
    expectedMemo?: string;
  }
): boolean {
  for (const node of Object.values(eventsById)) {
    const ex = exercisedEventFromNode(node);
    if (!ex?.choice) continue;
    const arg = ex.choiceArgument as
      | {
          sender?: string;
          receiver?: string;
          amount?: string;
          instrumentId?: InstrumentId;
          meta?: Record<string, unknown>;
          transfer?: {
            sender?: string;
            receiver?: string;
            amount?: string;
            instrumentId?: InstrumentId;
            meta?: Record<string, unknown>;
          };
      }
      | undefined;
    const transfer = arg?.transfer ?? arg;

    if (
      ex.choice === "TransferRule_DirectTransfer" &&
      transferFieldsMatchDirectSettlement(transfer, params) &&
      !!(ex.exerciseResult as { receiverHoldingCid?: string } | undefined)
        ?.receiverHoldingCid
    ) {
      return true;
    }

    if (
      ex.choice === "TransferFactory_Transfer" &&
      transferFieldsMatchDirectSettlement(transfer, params)
    ) {
      return true;
    }

    if (
      ex.choice.includes("Transfer") &&
      !ex.choice.includes("Accept") &&
      !ex.choice.includes("Reject") &&
      !ex.choice.includes("Factory") &&
      !ex.choice.includes("Rule") &&
      transferFieldsMatchDirectSettlement(transfer, params)
    ) {
      return true;
    }

    if (
      ex.choice === "TransferPreapproval_SendV2" &&
      arg?.sender === params.senderParty &&
      amountsEqual(params.amount, arg.amount ?? "", params.amountDecimals)
    ) {
      const result = ex.exerciseResult as
        | {
            result?: {
              summary?: {
                balanceChanges?: Array<
                  [
                    string,
                    { changeToInitialAmountAsOfRoundZero?: string }
                  ]
                >;
              };
            };
          }
        | undefined;
      const changes = result?.result?.summary?.balanceChanges ?? [];
      const senderDebited = changes.some(
        ([party, change]) =>
          party === params.senderParty &&
          signedAmountMatches(
            change?.changeToInitialAmountAsOfRoundZero,
            params.amount,
            params.amountDecimals,
            "negative"
          )
      );
      const receiverCredited = changes.some(
        ([party, change]) =>
          party === params.receiverParty &&
          signedAmountMatches(
            change?.changeToInitialAmountAsOfRoundZero,
            params.amount,
            params.amountDecimals,
            "positive"
          )
      );
      if (senderDebited && receiverCredited) return true;
    }
  }
  return false;
}

/** Build fill outcome from committed ledger events (pure — safe for tests). */
export function buildLoopFillResultFromEvents(
  order: CantonSwapOrder,
  updateId: string,
  eventsById: Record<string, unknown>,
  deliverTransferKind: string,
  expectedInstrument?: InstrumentId,
  expectedMemo?: string
): {
  updateId: string;
  counterLegOfferCid?: string;
  counterLegPendingAccept: boolean;
} {
  const asset = getSwapAsset(order.toAsset);
  const matchParams = {
    senderParty: swapParty(order),
    receiverParty: order.userParty,
    amount: order.outAmount,
    amountDecimals: asset.decimals,
    expectedInstrument: expectedInstrument ?? asset.instrumentId,
    expectedMemo
  };

  if (counterLegDeliveredToUserInEvents(eventsById, matchParams)) {
    return { updateId, counterLegPendingAccept: false };
  }

  const counterLegOfferCid =
    extractCounterOfferCidFromEvents(eventsById, matchParams) ?? undefined;
  if (counterLegOfferCid) {
    return { updateId, counterLegOfferCid, counterLegPendingAccept: true };
  }

  if (isDirectTransferKind(deliverTransferKind)) {
    throw new Error("counter direct transfer did not deliver to user");
  }
  throw new Error("counter leg outcome not found in fill transaction");
}

/** fillLoopSwap must include Accept for pending user leg — never deliver-only. */
export function assertFillIncludesUserLegConsumption(params: {
  userLegOfferCid: string;
  acceptLegIncluded: boolean;
  isPendingOffer: boolean;
}): void {
  if (!params.isPendingOffer) {
    throw new Error("fill requires pending user leg offer on settlement receiver");
  }
  if (!params.acceptLegIncluded) {
    throw new Error("fill must accept pending user leg offer");
  }
}
