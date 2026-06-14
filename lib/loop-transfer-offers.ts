/**
 * Find outgoing TransferInstruction offers in the user's Loop wallet ACS.
 * Client-only — the warpx m2m JWT cannot read external Loop parties (403).
 *
 * Loop's active-contracts endpoint REQUIRES templateId or interfaceId — never call
 * getActiveContracts() with no filter (400).
 */
import { toBaseUnits, toBaseUnitsFloor } from "@/lib/amount-units";
import type { InstrumentId } from "@/lib/constants";
import { matchesInstrument } from "@/lib/canton-assets";

const TRANSFER_INSTRUCTION_IFACE =
  "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction";

interface ProviderLike {
  getActiveContracts: (params?: {
    templateId?: string;
    interfaceId?: string;
  }) => Promise<unknown>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Loop connect may return a bare array or a wrapped object — normalize to items. */
export function normalizeLoopAcsResponse(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== "object") return [];
  const o = raw as Record<string, unknown>;
  for (const key of [
    "contracts",
    "active_contracts",
    "activeContracts",
    "items",
    "results",
    "data"
  ]) {
    const v = o[key];
    if (Array.isArray(v)) return v;
  }
  return [];
}

function amountsMatch(expected: string, actual: string, decimals: number): boolean {
  try {
    return (
      toBaseUnitsFloor(actual, decimals) === toBaseUnits(expected, decimals)
    );
  } catch {
    return false;
  }
}

function readTransferFields(ev: Record<string, unknown>): {
  sender?: string;
  receiver?: string;
  amount?: string;
  instrumentId?: { admin?: string; id?: string };
} | null {
  const arg = (ev.createArgument as { transfer?: Record<string, unknown> } | undefined)
    ?.transfer;
  const createArg = (
    ev.create_argument as { transfer?: Record<string, unknown> } | undefined
  )?.transfer;
  const views = ev.interfaceViews as Array<{ viewValue?: unknown }> | undefined;
  const viewTransfer = (
    views?.find((v) => v?.viewValue && typeof v.viewValue === "object")?.viewValue as
      | { transfer?: Record<string, unknown> }
      | undefined
  )?.transfer;
  const payload = ev.payload as { transfer?: Record<string, unknown> } | undefined;
  const argument = (ev.argument as { transfer?: Record<string, unknown> } | undefined)
    ?.transfer;
  const top = ev.transfer as
    | {
        sender?: string;
        receiver?: string;
        amount?: string;
        instrumentId?: { admin?: string; id?: string };
      }
    | undefined;
  const t = (arg ?? createArg ?? viewTransfer ?? payload?.transfer ?? argument ?? top) as
    | {
        sender?: string;
        receiver?: string;
        amount?: string;
        instrumentId?: { admin?: string; id?: string };
      }
    | undefined;
  return t ?? null;
}

export function parseOfferFromLoopAcsItem(item: unknown): {
  contractId: string;
  sender: string;
  receiver: string;
  amountBtc: string;
  instrumentId?: { admin?: string; id?: string };
} | null {
  const row = item as Record<string, unknown>;
  const ev =
    (row?.contractEntry as { JsActiveContract?: { createdEvent?: Record<string, unknown> } })
      ?.JsActiveContract?.createdEvent ??
    (row?.createdEvent as Record<string, unknown> | undefined) ??
    (row?.contract as Record<string, unknown> | undefined) ??
    row;
  if (!ev || typeof ev !== "object") return null;

  const contractId = String(
    (ev as { contractId?: string; contract_id?: string }).contractId ??
      (ev as { contract_id?: string }).contract_id ??
      (row as { contract_id?: string }).contract_id ??
      ""
  );
  const tpl = String(
    (ev as { templateId?: string; template_id?: string }).templateId ??
      (ev as { template_id?: string }).template_id ??
      (row as { template_id?: string }).template_id ??
      ""
  );

  const t = readTransferFields(ev as Record<string, unknown>);
  if (!t?.sender || !t.receiver) return null;

  const looksLikeOffer =
    tpl.includes("TransferInstruction") ||
    tpl.includes("TransferOffer") ||
    tpl.includes("TransferFactory") ||
    !tpl;
  if (!looksLikeOffer && tpl) return null;

  if (!contractId) return null;
  return {
    contractId,
    sender: t.sender,
    receiver: t.receiver,
    amountBtc: String(t.amount ?? "0"),
    instrumentId: t.instrumentId
  };
}

function matchOutgoingOffer(
  offer: NonNullable<ReturnType<typeof parseOfferFromLoopAcsItem>>,
  params: {
    senderParty: string;
    receiverParty: string;
    amount: string;
    instrumentId: InstrumentId;
    amountDecimals: number;
  }
): boolean {
  if (offer.sender !== params.senderParty) return false;
  if (offer.receiver !== params.receiverParty) return false;
  if (!amountsMatch(params.amount, offer.amountBtc, params.amountDecimals)) {
    return false;
  }
  if (
    offer.instrumentId?.id &&
    !matchesInstrument(offer.instrumentId, params.instrumentId)
  ) {
    return false;
  }
  return true;
}

/** Read the user's outgoing sell offer from their Loop wallet after they sign. */
export async function findLoopOutgoingTransferOffer(
  provider: ProviderLike,
  params: {
    senderParty: string;
    receiverParty: string;
    amount: string;
    instrumentId: InstrumentId;
    amountDecimals: number;
  },
  opts?: { maxAttempts?: number; pollMs?: number }
): Promise<string | null> {
  const maxAttempts = opts?.maxAttempts ?? 8;
  const pollMs = opts?.pollMs ?? 1000;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let items: unknown[] = [];
    try {
      const raw = await provider.getActiveContracts({
        interfaceId: TRANSFER_INSTRUCTION_IFACE
      });
      items = normalizeLoopAcsResponse(raw);
    } catch {
      if (attempt < maxAttempts - 1) await sleep(pollMs);
      continue;
    }

    for (const item of items) {
      const offer = parseOfferFromLoopAcsItem(item);
      if (!offer) continue;
      if (!matchOutgoingOffer(offer, params)) continue;
      return offer.contractId;
    }

    if (attempt < maxAttempts - 1) await sleep(pollMs);
  }
  return null;
}
