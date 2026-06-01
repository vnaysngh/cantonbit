import "server-only";

import { randomUUID } from "node:crypto";

import { getLedgerJwt } from "./auth";
import { NETWORK } from "./constants";
import type {
  DAMLCommand,
  Holding,
  SubmitAndWaitRequest,
  TransactionTree,
  Transfer,
} from "./types";

const APPLICATION_ID = "cbtc-app";

const HOLDING_INTERFACE_ID =
  "#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding";

const TRANSFER_INSTRUCTION_INTERFACE_ID =
  "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction";

const TRANSFER_FACTORY_TEMPLATE_ID =
  "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory";

const TRANSFER_INSTRUCTION_TEMPLATE_ID =
  "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction";

/* ---------- low-level fetch helpers ---------- */

const TAG = "[canton]";

async function ledgerFetch<T>(
  path: string,
  init: RequestInit & { jsonBody?: unknown },
): Promise<T> {
  const jwt = await getLedgerJwt();
  const url = `${NETWORK.ledgerHost}${path}`;

  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${jwt}`);
  if (init.jsonBody !== undefined) {
    headers.set("content-type", "application/json");
  }

  const method = init.method ?? "GET";
  console.log(`${TAG} ${method} ${url}`);
  if (init.jsonBody !== undefined) {
    const bodyStr = JSON.stringify(init.jsonBody);
    // Log full body for small payloads, truncate large ones (blobs)
    console.log(`${TAG} request body (${bodyStr.length} chars): ${bodyStr.length > 2000 ? bodyStr.slice(0, 2000) + "...[truncated]" : bodyStr}`);
  }

  const res = await fetch(url, {
    ...init,
    headers,
    body:
      init.jsonBody !== undefined ? JSON.stringify(init.jsonBody) : init.body,
    cache: "no-store",
  });

  console.log(`${TAG} response status=${res.status} url=${url}`);

  if (!res.ok) {
    const text = await res.text().catch(() => "<no body>");
    console.error(`${TAG} ERROR ${method} ${path} status=${res.status} body=${text}`);
    throw new Error(
      `Canton ${method} ${path} failed (${res.status} ${res.statusText}): ${text}`,
    );
  }

  const data = (await res.json()) as T;
  const dataStr = JSON.stringify(data);
  console.log(`${TAG} response body (${dataStr.length} chars): ${dataStr.length > 2000 ? dataStr.slice(0, 2000) + "...[truncated]" : dataStr}`);
  return data;
}

/* ---------- public API ---------- */

interface LedgerEndResponse {
  offset: number;
}

/**
 * GET /v2/state/ledger-end → current ledger offset.
 *
 * Canton's v2 JSON API returns offset as a JSON number (monotonic counter),
 * not an opaque string as some older docs suggest. Verified against
 * DevNet 2026-05-23.
 */
export async function getLedgerEnd(): Promise<number> {
  console.log(`${TAG} getLedgerEnd network=${NETWORK.name}`);
  const data = await ledgerFetch<LedgerEndResponse>("/v2/state/ledger-end", {
    method: "GET",
  });
  console.log(`${TAG} getLedgerEnd offset=${data.offset}`);
  return data.offset;
}

/* --- active-contracts request/response shapes --- */

interface ActiveContractsRequest {
  filter: {
    filtersByParty: Record<
      string,
      {
        cumulative: Array<{
          identifierFilter:
            | { InterfaceFilter: { value: { interfaceId: string; includeInterfaceView: boolean; includeCreatedEventBlob: boolean } } }
            | { TemplateFilter: { value: { templateId: string; includeCreatedEventBlob: boolean } } }
            | { WildcardFilter: { value: { includeCreatedEventBlob: boolean } } };
        }>;
      }
    >;
  };
  verbose: boolean;
  activeAtOffset: number;
}

interface JsCreatedEvent {
  contractId: string;
  templateId: string;
  interfaceViews?: Array<{
    interfaceId: string;
    viewValue: unknown;
    viewStatus?: { code?: number; message?: string };
  }>;
  createArgument?: unknown;
  createdEventBlob?: string;
}

interface JsActiveContract {
  JsActiveContract: {
    createdEvent: JsCreatedEvent;
    synchronizerId: string;
    reassignmentCounter?: number;
  };
}

// Canton v2 returns a JSON array. Each entry is one of:
//   1. { workflowId, contractEntry: { JsActiveContract: {...} } } (current shape)
//   2. { JsActiveContract: {...} } (legacy shape)
// Older versions wrapped the array in { contractEntries } or { result }.
interface ActiveContractEntry {
  workflowId?: string;
  contractEntry?: JsActiveContract;
}

type ActiveContractsResponse =
  | Array<ActiveContractEntry | JsActiveContract>
  | { contractEntries?: JsActiveContract[]; result?: JsActiveContract[] };

function unwrapContracts(resp: ActiveContractsResponse): JsActiveContract[] {
  // Wrapped object shape (legacy)
  if (!Array.isArray(resp)) {
    return resp.contractEntries ?? resp.result ?? [];
  }
  const out: JsActiveContract[] = [];
  for (const item of resp) {
    if (!item) continue;
    // Current shape: { workflowId, contractEntry: { JsActiveContract } }
    if ("contractEntry" in item && item.contractEntry) {
      out.push(item.contractEntry);
      continue;
    }
    // Legacy shape: { JsActiveContract } directly in the array
    if ("JsActiveContract" in item) {
      out.push(item as JsActiveContract);
    }
  }
  return out;
}

function buildInterfaceFilterRequest(
  partyId: string,
  interfaceId: string,
  activeAtOffset: number,
): ActiveContractsRequest {
  // Query as the actual party — the m2m JWT has authority over warpx + all cbtc-user parties.
  // Contracts owned by a cbtc-user party are NOT visible to warpx (different witness sets),
  // so we must filter by the target party itself.
  return {
    filter: {
      filtersByParty: {
        [partyId]: {
          cumulative: [
            {
              identifierFilter: {
                InterfaceFilter: {
                  value: {
                    interfaceId,
                    includeInterfaceView: true,
                    includeCreatedEventBlob: true,
                  },
                },
              },
            },
          ],
        },
      },
    },
    verbose: false,
    activeAtOffset,
  };
}

function pickInterfaceView<T>(
  event: JsCreatedEvent,
  interfaceId: string,
): T | null {
  // The interfaceId we send uses package-name form (#splice-api-token-holding-v1:Foo:Bar),
  // but the ledger response uses package-hash form (abc123...:Foo:Bar).
  // Compare by the qualified name suffix (everything after the first ":").
  const suffix = interfaceId.split(":").slice(1).join(":");
  const view = event.interfaceViews?.find((v) => {
    if (v.interfaceId === interfaceId) return true;
    const vSuffix = v.interfaceId.split(":").slice(1).join(":");
    return vSuffix === suffix;
  });
  if (!view || view.viewStatus?.code) return null;
  return view.viewValue as T;
}

/** POST /v2/state/active-contracts filtered to Holding interface. */
export async function getHoldings(partyId: string): Promise<Holding[]> {
  console.log(`${TAG} getHoldings partyId=${partyId.slice(0, 40)}...`);
  const activeAtOffset = await getLedgerEnd();
  console.log(`${TAG} getHoldings activeAtOffset=${activeAtOffset}`);
  const body = buildInterfaceFilterRequest(
    partyId,
    HOLDING_INTERFACE_ID,
    activeAtOffset,
  );

  const resp = await ledgerFetch<ActiveContractsResponse>(
    "/v2/state/active-contracts",
    { method: "POST", jsonBody: body },
  );

  const allEntries = unwrapContracts(resp);
  console.log(`${TAG} getHoldings raw entries count=${allEntries.length}`);

  const out: Holding[] = [];
  for (const entry of allEntries) {
    const ev = entry.JsActiveContract.createdEvent;
    const payload = pickInterfaceView<Holding["payload"]>(
      ev,
      HOLDING_INTERFACE_ID,
    );
    if (!payload) {
      console.log(`${TAG} getHoldings skipping contractId=${ev.contractId} (no interface view)`);
      continue;
    }
    // Filter to only holdings owned by the requested party
    if (payload.owner !== partyId) {
      console.log(`${TAG} getHoldings skipping contractId=${ev.contractId} owner=${String(payload.owner).slice(0,30)}... (not our party)`);
      continue;
    }
    const p = payload as unknown as Record<string, unknown>;
    console.log(`${TAG} getHoldings including contractId=${ev.contractId} owner=${String(payload.owner).slice(0,30)}... amount=${JSON.stringify(p.amount ?? p.quantity ?? "?")}`);
    out.push({
      contractId: ev.contractId,
      payload,
      createdEventBlob: ev.createdEventBlob,
    });
  }
  console.log(`${TAG} getHoldings returning ${out.length} holdings for partyId=${partyId.slice(0,40)}...`);
  return out;
}

/** POST /v2/state/active-contracts filtered to TransferInstruction interface. */
export async function getPendingTransfers(partyId: string): Promise<Transfer[]> {
  console.log(`${TAG} getPendingTransfers partyId=${partyId.slice(0, 40)}...`);
  const activeAtOffset = await getLedgerEnd();
  console.log(`${TAG} getPendingTransfers activeAtOffset=${activeAtOffset}`);
  const body = buildInterfaceFilterRequest(
    partyId,
    TRANSFER_INSTRUCTION_INTERFACE_ID,
    activeAtOffset,
  );

  const resp = await ledgerFetch<ActiveContractsResponse>(
    "/v2/state/active-contracts",
    { method: "POST", jsonBody: body },
  );

  const allEntries = unwrapContracts(resp);
  console.log(`${TAG} getPendingTransfers raw entries count=${allEntries.length}`);

  const out: Transfer[] = [];
  for (const entry of allEntries) {
    const ev = entry.JsActiveContract.createdEvent;
    const payload = pickInterfaceView<Transfer["payload"]>(
      ev,
      TRANSFER_INSTRUCTION_INTERFACE_ID,
    );
    if (!payload) {
      console.log(`${TAG} getPendingTransfers skipping contractId=${ev.contractId} (no interface view)`);
      continue;
    }
    if (payload.receiver !== partyId) {
      console.log(`${TAG} getPendingTransfers skipping contractId=${ev.contractId} receiver=${String(payload.receiver).slice(0,30)}... (not our party)`);
      continue;
    }
    console.log(`${TAG} getPendingTransfers including contractId=${ev.contractId}`);
    out.push({
      contractId: ev.contractId,
      payload,
      createdEventBlob: ev.createdEventBlob,
    });
  }
  console.log(`${TAG} getPendingTransfers returning ${out.length} transfers for partyId=${partyId.slice(0,40)}...`);
  return out;
}

/**
 * POST /v2/commands/submit-and-wait-for-transaction-tree.
 *
 * Server-only path. For user-initiated writes (sender transfers, receiver
 * accepts), the browser hits the Loop wallet via provider.submitTransaction
 * instead — this function is for app-party / admin / receiver-accept flows
 * that run server-side with the m2m JWT.
 *
 * `commandId` and `workflowId` are auto-generated if not provided.
 */
export async function submitCommand(
  command: DAMLCommand,
  opts: {
    actAs: string[];
    readAs?: string[];
    disclosedContracts?: SubmitAndWaitRequest["disclosedContracts"];
    commandId?: string;
    workflowId?: string;
  },
): Promise<TransactionTree> {
  const body: SubmitAndWaitRequest = {
    commands: [command],
    applicationId: APPLICATION_ID,
    commandId: opts.commandId ?? randomUUID(),
    workflowId: opts.workflowId ?? `cbtc-${randomUUID()}`,
    actAs: opts.actAs,
    readAs: opts.readAs,
    disclosedContracts: opts.disclosedContracts,
  };

  return ledgerFetch<TransactionTree>(
    "/v2/commands/submit-and-wait-for-transaction-tree",
    { method: "POST", jsonBody: body },
  );
}

/* ---------- exports for downstream callers ---------- */

export const CantonTemplateIds = {
  transferFactory: TRANSFER_FACTORY_TEMPLATE_ID,
  transferInstruction: TRANSFER_INSTRUCTION_TEMPLATE_ID,
  holdingInterface: HOLDING_INTERFACE_ID,
  transferInstructionInterface: TRANSFER_INSTRUCTION_INTERFACE_ID,
} as const;
