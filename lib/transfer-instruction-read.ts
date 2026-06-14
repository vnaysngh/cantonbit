import type { InstrumentId } from "./constants";
import type { TransferPayload } from "./types";

export const TRANSFER_INSTRUCTION_INTERFACE =
  "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction";

type RawTransferFields = {
  sender?: string;
  receiver?: string;
  amount?: string;
  instrumentId?: InstrumentId;
  status?: Record<string, unknown>;
  meta?: Record<string, unknown>;
};

export type TransferInstructionEvent = {
  createArgument?: unknown;
  interfaceViews?: Array<{
    interfaceId?: string;
    viewValue?: unknown;
    viewStatus?: { code?: number };
  }>;
};

function pickTransferInstructionSuffix(interfaceId: string): string {
  return interfaceId.split(":").slice(1).join(":");
}

/** Splice TransferInstruction views nest fields under `.transfer` (Loop + ledger ACS). */
export function readTransferInstructionPayload(
  event: TransferInstructionEvent
): TransferPayload | null {
  const arg = (event.createArgument as { transfer?: RawTransferFields } | undefined)
    ?.transfer;
  if (arg?.receiver && arg.sender) {
    return {
      sender: arg.sender,
      receiver: arg.receiver,
      amount: arg.amount ?? "0",
      instrumentId: arg.instrumentId ?? { admin: "", id: "" },
      status: arg.status,
      meta: arg.meta
    };
  }

  const wantSuffix = pickTransferInstructionSuffix(TRANSFER_INSTRUCTION_INTERFACE);
  for (const view of event.interfaceViews ?? []) {
    if (view.viewStatus?.code) continue;
    const id = view.interfaceId ?? "";
    if (
      id !== TRANSFER_INSTRUCTION_INTERFACE &&
      pickTransferInstructionSuffix(id) !== wantSuffix
    ) {
      continue;
    }
    const vv = view.viewValue;
    if (!vv || typeof vv !== "object") continue;
    const t = (
      "transfer" in vv
        ? (vv as { transfer?: RawTransferFields }).transfer
        : (vv as RawTransferFields)
    );
    if (t?.receiver && t.sender) {
      return {
        sender: t.sender,
        receiver: t.receiver,
        amount: t.amount ?? "0",
        instrumentId: t.instrumentId ?? { admin: "", id: "" },
        status: t.status,
        meta: t.meta
      };
    }
  }
  return null;
}
