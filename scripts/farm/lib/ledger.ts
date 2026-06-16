/**
 * Script-safe ledger helpers for farm swaps (no server-only imports).
 */
import type { InstrumentId } from "../../../lib/constants";
import { NETWORK } from "../../../lib/constants";
import { toBaseUnitsFloor } from "../../../lib/amount-units";
import { selectHoldingsForAmount } from "../../../lib/transfer-holdings";
import { buildTransferMeta } from "../../../lib/transfer-options";
import type { Holding } from "../../../lib/types";
import { CantonClient } from "../../../swap-solver/src/canton.js";
import { authEnv } from "./jwt";

const CBTC_HOLDING_TEMPLATE_FQN =
  "8107899ac4723ce986bf7d27416534e576e54b92161e46150a595fb78ff3d3a1:Utility.Registry.Holding.V0.Holding:Holding";
const AMULET_HOLDING_TEMPLATE_FQN =
  "a31be0483f3175647053f28965a4e6d97e3dbc433ea2338be303fae69bbcff6a:Splice.Amulet:Amulet";

const TRANSFER_FACTORY_INTERFACE =
  "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory";
const TRANSFER_INSTRUCTION_INTERFACE =
  "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction";
const HOLDING_INTERFACE =
  "#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding";

export type TransferRegistryKind = "cbtc" | "cc";

export interface DisclosedContract {
  templateId: string;
  contractId: string;
  createdEventBlob: string;
  synchronizerId: string;
}

export interface BuiltTransferLeg {
  command: unknown;
  disclosedContracts: DisclosedContract[];
  transferKind: string;
  synchronizerId: string;
  registrarAdmin: string;
  registryKind: TransferRegistryKind;
  instrumentId: InstrumentId;
}

export interface BuiltAcceptLeg {
  command: unknown;
  disclosedContracts: DisclosedContract[];
  synchronizerId: string;
}

function validatorUrl(path: string): string {
  return `${NETWORK.validatorHost}/api/validator${path}`;
}

function ccRegistryPath(suffix: string): string {
  const path = suffix.startsWith("/") ? suffix : `/${suffix}`;
  return validatorUrl(`/v0/scan-proxy/registry${path}`);
}

function holdingTemplate(kind: TransferRegistryKind): string {
  return kind === "cc" ? AMULET_HOLDING_TEMPLATE_FQN : CBTC_HOLDING_TEMPLATE_FQN;
}

function mergeDisclosed(batches: DisclosedContract[][]): DisclosedContract[] {
  const seen = new Set<string>();
  const out: DisclosedContract[] = [];
  for (const batch of batches) {
    for (const dc of batch) {
      if (seen.has(dc.contractId)) continue;
      seen.add(dc.contractId);
      out.push(dc);
    }
  }
  return out;
}

function pickSynchronizerId(batches: DisclosedContract[][]): string {
  for (const batch of batches) {
    const hit = batch.find((d) => d.synchronizerId)?.synchronizerId;
    if (hit) return hit;
  }
  return "";
}

function stampDisclosedSynchronizer(
  disclosed: DisclosedContract[],
  synchronizerId: string
): DisclosedContract[] {
  return disclosed.map((d) => ({
    ...d,
    synchronizerId: d.synchronizerId || synchronizerId
  }));
}

export function assertSameSynchronizer(
  legs: Array<{ synchronizerId: string }>,
  label: string
): string {
  const ids = legs.map((l) => l.synchronizerId).filter(Boolean);
  const unique = [...new Set(ids)];
  if (unique.length > 1) {
    throw new Error(`${label}: legs span multiple synchronizers`);
  }
  return unique[0] ?? "";
}

export function isDirectTransferKind(kind: string): boolean {
  const k = kind.toLowerCase();
  return k.includes("direct") || k === "self";
}

export async function getDsoPartyId(jwt: string): Promise<string> {
  const r = await fetch(validatorUrl("/v0/scan-proxy/dso-party-id"), {
    headers: { Authorization: `Bearer ${jwt}` },
    cache: "no-store"
  });
  if (!r.ok) throw new Error(`DSO lookup failed (${r.status})`);
  const j = (await r.json()) as { dso_party_id?: string };
  const dso = j.dso_party_id?.trim();
  if (!dso) throw new Error("DSO party missing");
  return dso;
}

async function fetchTransferFactoryContext(
  kind: TransferRegistryKind,
  registrarAdmin: string,
  transferPayload: Record<string, unknown>,
  jwt: string
): Promise<Response> {
  const body = JSON.stringify({
    choiceArguments: {
      expectedAdmin: registrarAdmin,
      transfer: transferPayload,
      extraArgs: { context: { values: {} }, meta: { values: {} } }
    }
  });
  if (kind === "cc") {
    return fetch(ccRegistryPath("/transfer-instruction/v1/transfer-factory"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`
      },
      body,
      cache: "no-store"
    });
  }
  return fetch(
    `${NETWORK.registryUrl}/api/token-standard/v0/registrars/${registrarAdmin}/registry/transfer-instruction/v1/transfer-factory`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      cache: "no-store"
    }
  );
}

async function fetchAcceptChoiceContext(
  kind: TransferRegistryKind,
  registrarAdmin: string,
  offerContractId: string,
  jwt: string
): Promise<Response> {
  const body = JSON.stringify({ meta: {} });
  if (kind === "cc") {
    return fetch(
      ccRegistryPath(
        `/transfer-instruction/v1/${offerContractId}/choice-contexts/accept`
      ),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${jwt}`
        },
        body,
        cache: "no-store"
      }
    );
  }
  return fetch(
    `${NETWORK.registryUrl}/api/token-standard/v0/registrars/${registrarAdmin}/registry/transfer-instruction/v1/${offerContractId}/choice-contexts/accept`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      cache: "no-store"
    }
  );
}

export async function submitLedgerCommands(params: {
  jwt: string;
  actAs: string[];
  commands: unknown[];
  disclosedContracts: DisclosedContract[];
  commandId: string;
  workflowId?: string;
  applicationId?: string;
  synchronizerId?: string;
}): Promise<{ updateId: string; eventsById: Record<string, unknown> }> {
  const disclosedContracts = params.synchronizerId
    ? stampDisclosedSynchronizer(params.disclosedContracts, params.synchronizerId)
    : params.disclosedContracts;
  const body: Record<string, unknown> = {
    applicationId: params.applicationId ?? "cbtc-farm",
    workflowId: params.workflowId ?? params.commandId,
    commandId: params.commandId,
    actAs: params.actAs,
    readAs: params.actAs,
    commands: params.commands,
    disclosedContracts
  };
  if (params.synchronizerId) body.synchronizerId = params.synchronizerId;

  const res = await fetch(
    `${NETWORK.ledgerHost}/v2/commands/submit-and-wait-for-transaction-tree`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.jwt}`
      },
      cache: "no-store",
      body: JSON.stringify(body)
    }
  );
  const text = await res.text();
  if (!res.ok) {
    if (text.includes("SUBMISSION_ALREADY_IN_FLIGHT")) {
      throw new Error(`submission in flight: ${params.commandId}`);
    }
    if (text.includes("DUPLICATE_COMMAND")) {
      throw new Error(`duplicate command committed: ${params.commandId}`);
    }
    if (/traffic|quota|rate/i.test(text)) {
      throw new Error(`traffic rejection: ${text.slice(0, 300)}`);
    }
    throw new Error(`ledger submit failed (${res.status}): ${text.slice(0, 500)}`);
  }
  const json = JSON.parse(text) as {
    transactionTree?: { updateId: string; eventsById?: Record<string, unknown> };
  };
  return {
    updateId: json.transactionTree?.updateId ?? "",
    eventsById: json.transactionTree?.eventsById ?? {}
  };
}

export async function buildTransferExercise(params: {
  jwt: string;
  senderParty: string;
  receiverParty: string;
  amount: string;
  inputHoldings: Holding[];
  expirationSeconds?: number;
  instrumentId?: InstrumentId;
  registrarAdmin?: string;
  registryKind?: TransferRegistryKind;
  assetSymbol?: string;
  memo?: string;
}): Promise<BuiltTransferLeg> {
  const {
    jwt,
    senderParty,
    receiverParty,
    amount,
    inputHoldings,
    expirationSeconds = 3600,
    instrumentId = NETWORK.instrumentId,
    registrarAdmin = NETWORK.decentralizedPartyId,
    registryKind = "cbtc",
    assetSymbol = instrumentId.id === "Amulet" ? "CC" : "CBTC",
    memo = "OranjSwap"
  } = params;
  const now = new Date().toISOString();
  const executeBefore = new Date(Date.now() + Math.max(60, expirationSeconds) * 1000).toISOString();
  const picked = selectHoldingsForAmount(
    inputHoldings.map((h) => ({
      ...h,
      payload: {
        owner: h.payload?.owner ?? senderParty,
        amount: h.payload?.amount ?? "0",
        instrumentId: h.payload?.instrumentId ?? instrumentId
      }
    })),
    amount,
    assetSymbol === "CC" ? 10 : 8,
    assetSymbol
  );
  const transferPayload = {
    sender: senderParty,
    receiver: receiverParty,
    amount,
    instrumentId,
    lock: null,
    requestedAt: now,
    executeBefore,
    inputHoldingCids: picked.map((h) => h.contractId),
    meta: buildTransferMeta(memo)
  };
  const factoryRes = await fetchTransferFactoryContext(
    registryKind,
    registrarAdmin,
    transferPayload,
    jwt
  );
  if (!factoryRes.ok) {
    throw new Error(
      `TransferFactory failed (${factoryRes.status}): ${await factoryRes.text()}`
    );
  }
  const factory = (await factoryRes.json()) as {
    factoryId: string;
    transferKind?: string;
    choiceContext: {
      choiceContextData: unknown;
      disclosedContracts: DisclosedContract[];
    };
  };
  const disclosedContracts: DisclosedContract[] = [
    ...factory.choiceContext.disclosedContracts.map((dc) => ({
      ...dc,
      synchronizerId: dc.synchronizerId ?? ""
    })),
    ...picked.map((h) => ({
      templateId: h.templateId ?? holdingTemplate(registryKind),
      contractId: h.contractId,
      createdEventBlob: h.createdEventBlob ?? "",
      synchronizerId: ""
    }))
  ];
  const synchronizerId = pickSynchronizerId([disclosedContracts]);
  return {
    command: {
      ExerciseCommand: {
        templateId: TRANSFER_FACTORY_INTERFACE,
        contractId: factory.factoryId,
        choice: "TransferFactory_Transfer",
        choiceArgument: {
          expectedAdmin: registrarAdmin,
          transfer: transferPayload,
          extraArgs: {
            context: factory.choiceContext.choiceContextData,
            meta: { values: {} }
          }
        }
      }
    },
    disclosedContracts,
    transferKind: factory.transferKind ?? "",
    synchronizerId,
    registrarAdmin,
    registryKind,
    instrumentId
  };
}

export async function buildAcceptExercise(params: {
  jwt: string;
  offerContractId: string;
  registrarAdmin: string;
  registryKind: TransferRegistryKind;
}): Promise<BuiltAcceptLeg> {
  const ctxRes = await fetchAcceptChoiceContext(
    params.registryKind,
    params.registrarAdmin,
    params.offerContractId,
    params.jwt
  );
  if (!ctxRes.ok) {
    throw new Error(`accept context failed (${ctxRes.status}): ${await ctxRes.text()}`);
  }
  const ctx = (await ctxRes.json()) as {
    choiceContextData: unknown;
    disclosedContracts: DisclosedContract[];
  };
  const disclosedContracts = (ctx.disclosedContracts ?? []).map((dc) => ({
    ...dc,
    synchronizerId: dc.synchronizerId ?? ""
  }));
  return {
    command: {
      ExerciseCommand: {
        templateId: TRANSFER_INSTRUCTION_INTERFACE,
        contractId: params.offerContractId,
        choice: "TransferInstruction_Accept",
        choiceArgument: {
          extraArgs: { context: ctx.choiceContextData, meta: { values: {} } }
        }
      }
    },
    disclosedContracts,
    synchronizerId: pickSynchronizerId([disclosedContracts])
  };
}

export { mergeDisclosed };

export async function listCcHoldings(
  jwt: string,
  party: string,
  dsoAdmin: string
): Promise<Holding[]> {
  const endRes = await fetch(`${NETWORK.ledgerHost}/v2/state/ledger-end`, {
    headers: { Authorization: `Bearer ${jwt}` }
  });
  if (!endRes.ok) throw new Error("ledger-end failed");
  const { offset } = (await endRes.json()) as { offset: number };
  const r = await fetch(`${NETWORK.ledgerHost}/v2/state/active-contracts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`
    },
    body: JSON.stringify({
      filter: {
        filtersByParty: {
          [party]: {
            cumulative: [
              {
                identifierFilter: {
                  InterfaceFilter: {
                    value: {
                      interfaceId: HOLDING_INTERFACE,
                      includeInterfaceView: true,
                      includeCreatedEventBlob: true
                    }
                  }
                }
              }
            ]
          }
        }
      },
      verbose: false,
      activeAtOffset: offset
    })
  });
  if (!r.ok) throw new Error(`ACS read failed (${r.status})`);
  const entries = (await r.json()) as Array<{
    contractEntry?: {
      JsActiveContract?: {
        createdEvent?: {
          contractId?: string;
          createdEventBlob?: string;
          interfaceViews?: Array<{
            viewValue?: { owner?: string; amount?: string; instrumentId?: { id?: string } };
            viewStatus?: { code?: number };
          }>;
        };
      };
    };
  }>;
  const out: Holding[] = [];
  for (const e of entries) {
    const ev = e.contractEntry?.JsActiveContract?.createdEvent;
    const iv = ev?.interfaceViews?.[0];
    if (!ev?.contractId || !iv || iv.viewStatus?.code) continue;
    const v = iv.viewValue;
    if (!v || v.owner !== party || v.instrumentId?.id !== "Amulet") continue;
    out.push({
      contractId: ev.contractId,
      createdEventBlob: ev.createdEventBlob ?? "",
      templateId: AMULET_HOLDING_TEMPLATE_FQN,
      payload: {
        owner: party,
        amount: String(v.amount ?? "0"),
        instrumentId: { admin: dsoAdmin, id: "Amulet" }
      }
    });
  }
  return out;
}

export async function listCbtcHoldings(party: string): Promise<Holding[]> {
  const client = new CantonClient(
    {
      ledgerHost: NETWORK.ledgerHost,
      registryUrl: NETWORK.registryUrl,
      decentralizedPartyId: NETWORK.decentralizedPartyId,
      instrumentId: NETWORK.instrumentId,
      solverParty: party
    },
    authEnv()
  );
  const raw = await client.getHoldings(party);
  return raw
    .filter((h) => !h.locked)
    .map((h) => ({
      contractId: h.contractId,
      createdEventBlob: h.createdEventBlob,
      payload: {
        owner: party,
        amount: h.amount,
        instrumentId: NETWORK.instrumentId
      }
    }));
}

export async function holdingsForAsset(
  jwt: string,
  party: string,
  asset: "CBTC" | "CC"
): Promise<Holding[]> {
  if (asset === "CBTC") return listCbtcHoldings(party);
  const dso = await getDsoPartyId(jwt);
  return listCcHoldings(jwt, party, dso);
}

export async function ccInstrumentId(jwt: string): Promise<InstrumentId> {
  const dso = await getDsoPartyId(jwt);
  return { admin: dso, id: "Amulet" };
}

export async function registrarForAsset(
  jwt: string,
  asset: "CBTC" | "CC"
): Promise<{ admin: string; kind: TransferRegistryKind; instrumentId: InstrumentId }> {
  if (asset === "CBTC") {
    return {
      admin: NETWORK.decentralizedPartyId,
      kind: "cbtc",
      instrumentId: NETWORK.instrumentId
    };
  }
  const inst = await ccInstrumentId(jwt);
  return { admin: inst.admin, kind: "cc", instrumentId: inst };
}

export async function countHoldings(
  jwt: string,
  party: string
): Promise<{ cbtc: number; cc: number }> {
  const [cbtc, cc] = await Promise.all([
    listCbtcHoldings(party).then((h) => h.length),
    ccInstrumentId(jwt).then((inst) =>
      listCcHoldings(jwt, party, inst.admin).then((h) => h.length)
    )
  ]);
  return { cbtc, cc };
}

export async function ccBalance(jwt: string, party: string): Promise<string> {
  const r = await fetch(
    validatorUrl(
      `/v0/admin/external-party/balance?party_id=${encodeURIComponent(party)}`
    ),
    { headers: { Authorization: `Bearer ${jwt}` }, cache: "no-store" }
  );
  if (r.ok) {
    const j = (await r.json()) as { balance?: string; total?: string };
    const bal = j.balance ?? j.total;
    if (bal != null) return bal;
  }
  const inst = await ccInstrumentId(jwt);
  const holdings = await listCcHoldings(jwt, party, inst.admin);
  let units = 0n;
  for (const h of holdings) {
    units += toBaseUnitsFloor(h.payload?.amount ?? "0", 10);
  }
  const { fromBaseUnits } = await import("../../../lib/amount-units");
  return fromBaseUnits(units, 10);
}

export async function cbtcBalance(party: string): Promise<string> {
  const holdings = await listCbtcHoldings(party);
  let units = 0n;
  for (const h of holdings) {
    units += toBaseUnitsFloor(h.payload?.amount ?? "0", 8);
  }
  const { fromBaseUnits } = await import("../../../lib/amount-units");
  return fromBaseUnits(units, 8);
}
