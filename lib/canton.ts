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

  const res = await fetch(url, {
    ...init,
    headers,
    body:
      init.jsonBody !== undefined ? JSON.stringify(init.jsonBody) : init.body,
    cache: "no-store",
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "<no body>");
    throw new Error(
      `Canton ${init.method ?? "GET"} ${path} failed (${res.status} ${res.statusText}): ${text}`,
    );
  }

  return (await res.json()) as T;
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
  const data = await ledgerFetch<LedgerEndResponse>("/v2/state/ledger-end", {
    method: "GET",
  });
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

interface ActiveContractsResponse {
  // Some Canton versions wrap the array; others return it directly.
  // We accept both via the helper below.
  contractEntries?: JsActiveContract[];
  // Older shape:
  result?: JsActiveContract[];
}

function unwrapContracts(resp: ActiveContractsResponse): JsActiveContract[] {
  return resp.contractEntries ?? resp.result ?? [];
}

function buildInterfaceFilterRequest(
  partyId: string,
  interfaceId: string,
  activeAtOffset: number,
): ActiveContractsRequest {
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
  const view = event.interfaceViews?.find((v) => v.interfaceId === interfaceId);
  if (!view || view.viewStatus?.code) return null;
  return view.viewValue as T;
}

/** POST /v2/state/active-contracts filtered to Holding interface. */
export async function getHoldings(partyId: string): Promise<Holding[]> {
  const activeAtOffset = await getLedgerEnd();
  const body = buildInterfaceFilterRequest(
    partyId,
    HOLDING_INTERFACE_ID,
    activeAtOffset,
  );

  const resp = await ledgerFetch<ActiveContractsResponse>(
    "/v2/state/active-contracts",
    { method: "POST", jsonBody: body },
  );

  const out: Holding[] = [];
  for (const entry of unwrapContracts(resp)) {
    const ev = entry.JsActiveContract.createdEvent;
    const payload = pickInterfaceView<Holding["payload"]>(
      ev,
      HOLDING_INTERFACE_ID,
    );
    if (!payload) continue;
    out.push({
      contractId: ev.contractId,
      payload,
      createdEventBlob: ev.createdEventBlob,
    });
  }
  return out;
}

/** POST /v2/state/active-contracts filtered to TransferInstruction interface. */
export async function getPendingTransfers(partyId: string): Promise<Transfer[]> {
  const activeAtOffset = await getLedgerEnd();
  const body = buildInterfaceFilterRequest(
    partyId,
    TRANSFER_INSTRUCTION_INTERFACE_ID,
    activeAtOffset,
  );

  const resp = await ledgerFetch<ActiveContractsResponse>(
    "/v2/state/active-contracts",
    { method: "POST", jsonBody: body },
  );

  const out: Transfer[] = [];
  for (const entry of unwrapContracts(resp)) {
    const ev = entry.JsActiveContract.createdEvent;
    const payload = pickInterfaceView<Transfer["payload"]>(
      ev,
      TRANSFER_INSTRUCTION_INTERFACE_ID,
    );
    if (!payload) continue;
    out.push({
      contractId: ev.contractId,
      payload,
      createdEventBlob: ev.createdEventBlob,
    });
  }
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
