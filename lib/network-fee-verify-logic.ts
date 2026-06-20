/**
 * Pure network-fee settlement proof parsing from Canton transaction trees.
 */
import { toBaseUnitsFloor } from "./amount-units";
import { CC_ASSET } from "./canton-assets";
import type { InstrumentId } from "./constants";
import { matchesInstrument } from "./canton-assets";

function createdEventFromNode(node: unknown): {
  contractId?: string;
  templateId?: string;
  createArgument?: unknown;
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
      }
    | undefined;
  return created?.contractId ? created : null;
}

function isCcHoldingTemplate(templateId: string): boolean {
  return (
    templateId.includes("Splice.Amulet") ||
    templateId.includes("HoldingV1:Holding")
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

/** Read an exercised-choice event's sender/receiver/amount/instrument, if it is a
 *  CC transfer. Used to BIND the payer (sender) — a bare Holding only records the
 *  new owner (receiver) and cannot prove who paid (H-01). */
function exercisedTransferFromNode(node: unknown): {
  sender?: string;
  receiver?: string;
  amount?: string;
  instrumentId?: { id?: string; admin?: string };
} | null {
  const n = node as {
    ExercisedTreeEvent?: { value?: Record<string, unknown> };
    ExercisedEvent?: Record<string, unknown>;
  };
  const ex = (n.ExercisedTreeEvent?.value ?? n.ExercisedEvent) as
    | { choiceArgument?: unknown; templateId?: string }
    | undefined;
  if (!ex) return null;
  const arg = ex.choiceArgument as
    | {
        transfer?: {
          sender?: string;
          receiver?: string;
          amount?: string;
          instrumentId?: { id?: string; admin?: string };
        };
      }
    | undefined;
  return arg?.transfer ?? null;
}

/**
 * True when events prove a CC network-fee transfer FROM `userParty` TO
 * `receiverParty` of at least `minFeeCc`.
 *
 * SECURITY (H-01): we must prove the SENDER, not merely that the receiver ended up
 * with a CC Holding. A bare Holding created in the tree only carries `owner` (the
 * new holder), so an unrelated receiver-owned Holding would otherwise pass. We
 * therefore accept ONLY:
 *   (a) a TransferInstruction/TransferOffer whose sender === userParty, OR
 *   (b) a receiver-owned CC Holding that is accompanied IN THE SAME TREE by an
 *       exercised CC transfer whose sender === userParty (the direct/preapproved
 *       path, where the settled artifact is a Holding but the exercise binds the payer).
 * A receiver Holding with no sender-bound transfer in the tree is rejected.
 */
export function ccNetworkFeePaidInEvents(
  eventsById: Record<string, unknown> | null | undefined,
  params: {
    userParty: string;
    receiverParty: string;
    minFeeCc: string;
    expectedInstrument: InstrumentId;
  }
): boolean {
  if (!eventsById) return false;
  const nodes = Object.values(eventsById);

  // Does the tree contain an exercised CC transfer FROM the user TO the receiver
  // for at least the fee? This binds the payer. H-01: we require this PLUS a settled
  // receiver Holding below — an exercise alone (or a pending offer) is not enough.
  const senderBoundTransfer = nodes.some((node) => {
    const t = exercisedTransferFromNode(node);
    if (!t) return false;
    if (t.sender !== params.userParty) return false;
    if (t.receiver !== params.receiverParty) return false;
    if (!feeAmountAtLeast(t.amount ?? "0", params.minFeeCc)) return false;
    if (t.instrumentId && !matchesInstrument(t.instrumentId, params.expectedInstrument)) {
      return false;
    }
    return true;
  });
  if (!senderBoundTransfer) return false;

  // H-01: require SETTLED proof — a CC Holding now OWNED BY THE RECEIVER, created in
  // this tree, for at least the fee. We do NOT accept a bare TransferInstruction /
  // TransferOffer: that proves funds were OFFERED/locked, not received — it can still
  // expire or be rejected, so the receiver might never get the CC.
  for (const node of nodes) {
    const created = createdEventFromNode(node);
    if (!created?.contractId || !created.templateId) continue;
    if (!isCcHoldingTemplate(created.templateId)) continue;

    const arg = created.createArgument as
      | {
          owner?: string;
          amount?: string;
          instrumentId?: { id?: string; admin?: string };
          instrument?: { id?: string; admin?: string };
        }
      | undefined;
    if (arg?.owner !== params.receiverParty || !arg.amount) continue;
    if (!feeAmountAtLeast(arg.amount, params.minFeeCc)) continue;
    const holdingInst = arg.instrumentId ?? arg.instrument;
    if (
      holdingInst?.id &&
      !matchesInstrument(holdingInst, params.expectedInstrument)
    ) {
      continue;
    }
    return true; // settled: receiver-owned Holding + sender-bound transfer
  }
  return false;
}
