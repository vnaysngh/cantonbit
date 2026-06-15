/**
 * Pure user-leg / counter-leg evidence parsing from Canton transaction trees.
 * No server-only — safe for unit tests.
 */
import { toBaseUnits, toBaseUnitsFloor } from "./amount-units";
import { getSwapAsset } from "./canton-assets";
import type { InstrumentId } from "./constants";
import type { CantonSwapMvpAssetId, CantonSwapOrder } from "./canton-swap-types";
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

function holdingInstrumentId(
  arg: {
    instrumentId?: { id?: string };
    instrument?: { id?: string };
  } | undefined
): string | undefined {
  return arg?.instrumentId?.id ?? arg?.instrument?.id;
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

/** Parse user sell leg proof from a Loop submit or ledger update tree. */
export function parseUserLegEvidenceFromEvents(
  eventsById: Record<string, unknown> | null | undefined,
  params: {
    userParty: string;
    solverParty: string;
    inAmount: string;
    fromAsset: CantonSwapMvpAssetId;
    expectedInstrument: InstrumentId;
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
      const instrumentId = holdingInstrumentId(arg);
      if (
        params.fromAsset === "CBTC" &&
        instrumentId &&
        instrumentId !== "CBTC"
      ) {
        continue;
      }
      if (
        params.fromAsset === "CC" &&
        instrumentId &&
        instrumentId !== "Amulet"
      ) {
        continue;
      }
      inboundHoldingCid = created.contractId;
    }
  }

  if (offerCid) return { offerCid, inboundHoldingCid };
  if (inboundHoldingCid) return { inboundHoldingCid };
  return null;
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
    hits.push(created.contractId);
  }

  return hits.length ? hits[hits.length - 1]! : null;
}

function isDirectTransferKind(kind: string): boolean {
  const k = kind.toLowerCase();
  return k === "direct" || k === "self" || k.includes("direct");
}

/** Build fill outcome from committed ledger events (pure — safe for tests). */
export function buildLoopFillResultFromEvents(
  order: CantonSwapOrder,
  updateId: string,
  eventsById: Record<string, unknown>,
  deliverTransferKind: string
): {
  updateId: string;
  counterLegOfferCid?: string;
  counterLegPendingAccept: boolean;
} {
  const asset = getSwapAsset(order.toAsset);
  const counterLegOfferCid =
    extractCounterOfferCidFromEvents(eventsById, {
      senderParty: order.solverParty,
      receiverParty: order.userParty,
      amount: order.outAmount,
      amountDecimals: asset.decimals
    }) ?? undefined;
  const counterLegPendingAccept = Boolean(
    counterLegOfferCid && !isDirectTransferKind(deliverTransferKind)
  );
  return { updateId, counterLegOfferCid, counterLegPendingAccept };
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
