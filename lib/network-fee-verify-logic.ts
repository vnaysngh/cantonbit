/**
 * Pure network-fee settlement proof parsing from Canton transaction trees.
 */
import { toBaseUnitsFloor } from "./amount-units";
import { CC_ASSET, matchesInstrument } from "./canton-assets";
import type { InstrumentId } from "./constants";
import {
  readTransferInstructionPayload,
  TRANSFER_INSTRUCTION_INTERFACE
} from "./transfer-instruction-read";

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

function identifierSuffix(identifier: string): string {
  return identifier.split(":").slice(1).join(":");
}

function identifierMatchesInterface(
  identifier: string,
  expectedInterface: string
): boolean {
  return (
    identifier === expectedInterface ||
    identifierSuffix(identifier) === identifierSuffix(expectedInterface)
  );
}

function isTransferInstructionEvent(
  event: NonNullable<ReturnType<typeof createdEventFromNode>>
): boolean {
  if (
    event.templateId &&
    identifierMatchesInterface(
      event.templateId,
      TRANSFER_INSTRUCTION_INTERFACE
    )
  ) {
    return true;
  }
  return (event.interfaceViews ?? []).some((view) =>
    identifierMatchesInterface(
      view.interfaceId ?? "",
      TRANSFER_INSTRUCTION_INTERFACE
    )
  );
}

function feeAmountAtLeast(actual: string, minFeeCc: string): boolean {
  try {
    return (
      toBaseUnitsFloor(actual, CC_ASSET.decimals) >=
      toBaseUnitsFloor(minFeeCc, CC_ASSET.decimals)
    );
  } catch {
    return false;
  }
}

type TransferFields = {
  sender?: string;
  receiver?: string;
  amount?: string;
  instrumentId?: { id?: string; admin?: string };
};

type ExerciseValue = {
  contractId?: string;
  choiceArgument?: unknown;
  exerciseResult?: unknown;
  templateId?: string;
  choice?: string;
};

export function disclosedCcTransferPreapprovalCid(
  disclosedContracts: Array<{
    templateId?: string;
    contractId?: string;
  }>
): string | null {
  const matches = disclosedContracts
    .filter(
      (dc) =>
        dc.templateId?.includes("Splice.AmuletRules:TransferPreapproval") &&
        !!dc.contractId
    )
    .map((dc) => dc.contractId!);
  const unique = [...new Set(matches)];
  return unique.length === 1 ? unique[0]! : null;
}

function exercisedValueFromNode(node: unknown): ExerciseValue | null {
  const n = node as {
    ExercisedTreeEvent?: { value?: Record<string, unknown> };
    ExercisedEvent?: Record<string, unknown>;
  };
  return (n.ExercisedTreeEvent?.value ?? n.ExercisedEvent ?? null) as
    | ExerciseValue
    | null;
}

function transferFieldsMatch(
  t: TransferFields,
  params: {
    userParty: string;
    receiverParty: string;
    minFeeCc: string;
    expectedInstrument: InstrumentId;
  }
): boolean {
  if (t.sender !== params.userParty) return false;
  if (t.receiver !== params.receiverParty) return false;
  if (!feeAmountAtLeast(t.amount ?? "0", params.minFeeCc)) return false;
  if (
    t.instrumentId &&
    !matchesInstrument(t.instrumentId, params.expectedInstrument)
  ) {
    return false;
  }
  return true;
}

function signedAmountAtLeast(
  value: unknown,
  minFeeCc: string,
  sign: "positive" | "negative"
): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  const negative = trimmed.startsWith("-");
  if ((sign === "negative") !== negative) return false;
  return feeAmountAtLeast(negative ? trimmed.slice(1) : trimmed, minFeeCc);
}

/**
 * Direct CC transfers to a TransferPreapproval are exposed by WarpX as
 * `TransferPreapproval_SendV2`, not as a TransferFactory exercise. The choice
 * argument binds sender + amount, and the authoritative exercise result binds the
 * receiver through its positive balance change. Require both sides so an unrelated
 * receiver balance change cannot be used as fee proof.
 */
function preapprovalSendMatches(
  node: unknown,
  params: {
    userParty: string;
    receiverParty: string;
    minFeeCc: string;
    expectedInstrument: InstrumentId;
    expectedPreapprovalCid?: string;
  }
): boolean {
  const ex = exercisedValueFromNode(node);
  if (
    !ex ||
    ex.choice !== "TransferPreapproval_SendV2" ||
    !params.expectedPreapprovalCid ||
    ex.contractId !== params.expectedPreapprovalCid ||
    !ex.templateId?.includes("Splice.AmuletRules:TransferPreapproval") ||
    ex.templateId.includes("TransferInstruction")
  ) {
    return false;
  }
  if (params.expectedInstrument.id !== "Amulet") return false;

  const arg = ex.choiceArgument as
    | { sender?: string; amount?: string }
    | undefined;
  if (
    arg?.sender !== params.userParty ||
    !feeAmountAtLeast(arg.amount ?? "0", params.minFeeCc)
  ) {
    return false;
  }

  const result = ex.exerciseResult as
    | {
        result?: {
          summary?: {
            balanceChanges?: Array<
              [
                string,
                {
                  changeToInitialAmountAsOfRoundZero?: string;
                }
              ]
            >;
          };
        };
      }
    | undefined;
  const changes = result?.result?.summary?.balanceChanges ?? [];
  const senderDebited = changes.some(
    ([party, change]) =>
      party === params.userParty &&
      signedAmountAtLeast(
        change?.changeToInitialAmountAsOfRoundZero,
        params.minFeeCc,
        "negative"
      )
  );
  const receiverCredited = changes.some(
    ([party, change]) =>
      party === params.receiverParty &&
      signedAmountAtLeast(
        change?.changeToInitialAmountAsOfRoundZero,
        params.minFeeCc,
        "positive"
      )
  );
  return senderDebited && receiverCredited;
}

function exercisedContractIdsInTree(nodes: unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const node of nodes) {
    const n = node as {
      ExercisedTreeEvent?: { value?: { contractId?: string } };
      ExercisedEvent?: { contractId?: string };
    };
    const ex = n.ExercisedTreeEvent?.value ?? n.ExercisedEvent;
    if (ex?.contractId) ids.add(ex.contractId);
  }
  return ids;
}

/** Pending TransferInstruction = offered in-tree and not consumed — not settled. */
function hasUnconsumedPendingFeeTransferOffer(
  nodes: unknown[],
  params: {
    userParty: string;
    receiverParty: string;
    minFeeCc: string;
    expectedInstrument: InstrumentId;
  }
): boolean {
  const consumed = exercisedContractIdsInTree(nodes);
  for (const node of nodes) {
    const created = createdEventFromNode(node);
    if (!created || !isTransferInstructionEvent(created)) {
      continue;
    }
    if (created.contractId && consumed.has(created.contractId)) {
      continue;
    }
    const transfer = readTransferInstructionPayload(created);
    if (!transfer) continue;
    if (!transferFieldsMatch(transfer, params)) continue;
    return true;
  }
  return false;
}

/**
 * True when events prove a CC network-fee transfer FROM `userParty` TO
 * `receiverParty` of at least `minFeeCc`.
 *
 * SECURITY (H-01): network-fee collection requires the configured receiver's
 * direct CC TransferPreapproval. Prove settlement through WarpX's
 * TransferPreapproval_SendV2 result, bound to the receiver's active preapproval
 * contract id plus sender debit and receiver credit.
 *
 * Transfer-shaped choice arguments and receiver Holdings are not independently
 * authoritative settlement evidence.
 */
export function ccNetworkFeePaidInEvents(
  eventsById: Record<string, unknown> | null | undefined,
  params: {
    userParty: string;
    receiverParty: string;
    minFeeCc: string;
    expectedInstrument: InstrumentId;
    expectedPreapprovalCid?: string;
  }
): boolean {
  return ccNetworkFeeRejectReason(eventsById, params) === null;
}

/** Human-readable reason when ccNetworkFeePaidInEvents would fail (for API errors). */
export function ccNetworkFeeRejectReason(
  eventsById: Record<string, unknown> | null | undefined,
  params: {
    userParty: string;
    receiverParty: string;
    minFeeCc: string;
    expectedInstrument: InstrumentId;
    expectedPreapprovalCid?: string;
  }
): string | null {
  if (!eventsById) return "missing transaction tree";
  const nodes = Object.values(eventsById);

  if (hasUnconsumedPendingFeeTransferOffer(nodes, params)) {
    return "unconsumed CC transfer offer in tree (fee not settled)";
  }

  const settledPreapproval = nodes.some((node) =>
    preapprovalSendMatches(node, params)
  );
  if (!settledPreapproval) {
    return "no settled sender-bound CC transfer matching user, receiver, and fee amount";
  }

  return null;
}
