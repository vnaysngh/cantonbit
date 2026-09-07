/**
 * Script-safe ledger helpers for farm swaps (no server-only imports).
 */
import type { InstrumentId } from "../../../lib/constants";
import { NETWORK } from "../../../lib/constants";
import { toBaseUnitsFloor } from "../../../lib/amount-units";
import { selectHoldingsForAmount } from "../../../lib/transfer-holdings";
import { buildTransferMeta } from "../../../lib/transfer-options";
import type { Holding } from "../../../lib/types";
import {
  AMULET_HOLDING_TEMPLATE_FQN,
  AMULET_TEMPLATE_BY_NAME,
  CBTC_HOLDING_TEMPLATE_BY_NAME,
  CBTC_HOLDING_TEMPLATE_FQN
} from "./ledger-constants";
import {
  getVaultCbtcCachedHoldings,
  isVaultCbtcCacheParty,
  refreshVaultCbtcCacheIfEmpty,
  syncVaultCbtcCacheFromAcs
} from "./vault-cbtc-holdings";

/** WarpX JSON API returns 413 when a party has >200 matching ACS rows. */
export function isAcsLimitError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes("maximum_list_elements") ||
    msg.includes("acs read failed (413)") ||
    msg.includes("getholdings acs query failed (413)")
  );
}

const TRANSFER_FACTORY_INTERFACE =
  "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory";
const TRANSFER_INSTRUCTION_INTERFACE =
  "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction";

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

function holdingDisclosedTemplateId(
  holding: Holding,
  registryKind: TransferRegistryKind
): string {
  if (holding.templateId) return holding.templateId;
  return holdingTemplate(registryKind);
}

function mergeDisclosed(batches: DisclosedContract[][]): DisclosedContract[] {
  const byCid = new Map<string, DisclosedContract>();
  for (const batch of batches) {
    for (const dc of batch) {
      // Later batches win — input holdings override factory prefetch stubs.
      byCid.set(dc.contractId, dc);
    }
  }
  return [...byCid.values()];
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
      // Keep a wide slice: parseTrafficError() reads trafficCost /
      // baseTrafficRemainder / availableTraffic out of this string to re-sync the
      // pacing bucket to the node's real level. Those fields sit ~160-350 chars in
      // (after the member party id), so a 300-char cut dropped them and forced the
      // caller into a blind full-window backoff. 2000 covers the whole
      // AboveTrafficLimit(...) payload with room for a JSON envelope.
      throw new Error(`traffic rejection: ${text.slice(0, 2000)}`);
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
  /** Use every input holding (self-transfer merge) instead of greedy pick. */
  useAllInputHoldings?: boolean;
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
    memo = "OranjSwap",
    useAllInputHoldings = false
  } = params;
  const now = new Date().toISOString();
  const executeBefore = new Date(Date.now() + Math.max(60, expirationSeconds) * 1000).toISOString();
  const normalized = inputHoldings
    .filter((h) => h.createdEventBlob?.trim())
    .map((h) => ({
    ...h,
    payload: {
      owner: h.payload?.owner ?? senderParty,
      amount: h.payload?.amount ?? "0",
      instrumentId: h.payload?.instrumentId ?? instrumentId
    }
  }));
  if (normalized.length === 0) {
    throw new Error(
      `sender has no disclosable ${assetSymbol} holdings (missing createdEventBlob)`
    );
  }
  const picked = useAllInputHoldings
    ? normalized
    : selectHoldingsForAmount(
        normalized,
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
  const disclosedContracts = mergeDisclosed([
    factory.choiceContext.disclosedContracts.map((dc) => ({
      ...dc,
      synchronizerId: dc.synchronizerId ?? ""
    })),
    picked.map((h) => ({
      templateId: holdingDisclosedTemplateId(h, registryKind),
      contractId: h.contractId,
      createdEventBlob: h.createdEventBlob ?? "",
      synchronizerId: ""
    }))
  ]);
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

type AcsCreatedEvent = {
  contractId?: string;
  templateId?: string;
  createdEventBlob?: string;
  createArgument?: Record<string, unknown>;
  interfaceViews?: Array<{
    viewValue?: {
      owner?: string;
      amount?: string;
      instrumentId?: { id?: string };
      lock?: { expiresAt?: string | null; expiresAfter?: string | null } | null;
    };
    viewStatus?: { code?: number };
  }>;
};

/**
 * Ledger read session — matches Canton JSON API tutorial flow:
 * 1. GET /v2/state/ledger-end once
 * 2. POST /v2/state/active-contracts at that activeAtOffset (TemplateFilter, optional ?limit=)
 *
 * Docs: active-contracts is expensive; bootstrap once then track changes via /v2/updates.
 * @see https://docs.canton.network/sdks-tools/api-reference/json-api
 * @see https://docs.canton.network/appdev/modules/m4-json-api-tutorial
 * @see https://docs.canton.network/sdks-tools/api-reference/ledger-api-services (State Service)
 */
let ledgerReadSession: { jwt: string; offset: number } | null = null;

export function clearLedgerOffsetCache(): void {
  ledgerReadSession = null;
}

/** GET /v2/state/ledger-end — standalone fetch (outside a read session). */
export async function fetchLedgerEnd(jwt: string): Promise<number> {
  let endRes: Response;
  try {
    endRes = await fetch(`${NETWORK.ledgerHost}/v2/state/ledger-end`, {
      headers: { Authorization: `Bearer ${jwt}` },
      cache: "no-store"
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`ledger-end failed (network): ${msg.slice(0, 120)}`);
  }

  if (!endRes.ok) {
    const body = await endRes.text().catch(() => "");
    throw new Error(
      `ledger-end failed (${endRes.status})${body ? `: ${body.slice(0, 120)}` : ""}`
    );
  }
  const { offset } = (await endRes.json()) as { offset: number };
  return offset;
}

/** One ledger-end per batch; all ACS queries in fn share the same activeAtOffset. */
export async function runWithLedgerReadSession<T>(
  jwt: string,
  fn: () => Promise<T>
): Promise<T> {
  if (ledgerReadSession?.jwt === jwt) {
    return fn();
  }
  const offset = await fetchLedgerEnd(jwt);
  ledgerReadSession = { jwt, offset };
  try {
    return await fn();
  } finally {
    ledgerReadSession = null;
  }
}

async function getLedgerOffset(jwt: string): Promise<number> {
  if (ledgerReadSession?.jwt === jwt) {
    return ledgerReadSession.offset;
  }
  return fetchLedgerEnd(jwt);
}

/** WarpX node cap (http-list-max-elements-limit). Use ?limit= below this. */
export const ACS_QUERY_BATCH_LIMIT = 150;

async function queryActiveContractsByTemplate(
  jwt: string,
  party: string,
  templateId: string,
  includeCreatedEventBlob: boolean,
  limit: number = ACS_QUERY_BATCH_LIMIT
): Promise<AcsCreatedEvent[]> {
  const offset = await getLedgerOffset(jwt);
  const capped = Math.min(Math.max(1, limit), ACS_QUERY_BATCH_LIMIT);
  const r = await fetch(
    `${NETWORK.ledgerHost}/v2/state/active-contracts?limit=${capped}`, {
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
                  TemplateFilter: {
                    value: {
                      templateId,
                      includeCreatedEventBlob
                    }
                  }
                }
              }
            ]
          }
        }
      },
      verbose: true,
      activeAtOffset: offset
    })
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`ACS read failed (${r.status})${body ? `: ${body.slice(0, 240)}` : ""}`);
  }
  const entries = (await r.json()) as Array<{
    contractEntry?: { JsActiveContract?: { createdEvent?: AcsCreatedEvent } };
  }>;
  return entries
    .map((e) => e.contractEntry?.JsActiveContract?.createdEvent)
    .filter((ev): ev is AcsCreatedEvent => !!ev?.contractId);
}

function isActivelyLocked(
  lock: { expiresAt?: string | null; expiresAfter?: string | null } | null | undefined,
  nowIso: string
): boolean {
  if (lock == null) return false;
  return lock.expiresAt ? lock.expiresAt > nowIso : true;
}

function parseAmuletAmount(arg: Record<string, unknown> | undefined): string {
  if (!arg) return "0";
  const amt = arg.amount;
  if (typeof amt === "string") return amt;
  if (amt && typeof amt === "object" && "initialAmount" in amt) {
    return String((amt as { initialAmount?: string }).initialAmount ?? "0");
  }
  return "0";
}

export async function listCcHoldings(
  jwt: string,
  party: string,
  dsoAdmin: string,
  limit: number = ACS_QUERY_BATCH_LIMIT
): Promise<Holding[]> {
  const events = await queryActiveContractsByTemplate(
    jwt,
    party,
    AMULET_TEMPLATE_BY_NAME,
    true,
    limit
  );
  const nowIso = new Date().toISOString();
  const out: Holding[] = [];
  for (const ev of events) {
    const iv = ev.interfaceViews?.[0];
    const v = iv && !iv.viewStatus?.code ? iv.viewValue : undefined;
    const arg = ev.createArgument;
    const owner = v?.owner ?? (typeof arg?.owner === "string" ? arg.owner : undefined);
    if (!ev.contractId || owner !== party) continue;
    const lock = (v?.lock ?? arg?.lock) as
      | { expiresAt?: string | null; expiresAfter?: string | null }
      | null
      | undefined;
    if (isActivelyLocked(lock, nowIso)) continue;
    const amount = v?.amount ?? parseAmuletAmount(arg);
    out.push({
      contractId: ev.contractId,
      createdEventBlob: ev.createdEventBlob ?? "",
      templateId: ev.templateId ?? AMULET_HOLDING_TEMPLATE_FQN,
      payload: {
        owner: party,
        amount: String(amount ?? "0"),
        instrumentId: { admin: dsoAdmin, id: "Amulet" }
      }
    });
  }
  return out;
}

export async function listCbtcHoldings(
  jwt: string,
  party: string,
  limit: number = ACS_QUERY_BATCH_LIMIT
): Promise<Holding[]> {
  const events = await queryActiveContractsByTemplate(
    jwt,
    party,
    CBTC_HOLDING_TEMPLATE_BY_NAME,
    true,
    limit
  );
  const nowIso = new Date().toISOString();
  const out: Holding[] = [];
  for (const ev of events) {
    const arg = ev.createArgument;
    const owner = typeof arg?.owner === "string" ? arg.owner : undefined;
    if (!ev.contractId || owner !== party) continue;
    const lock = arg?.lock as
      | { expiresAt?: string | null; expiresAfter?: string | null }
      | null
      | undefined;
    if (isActivelyLocked(lock, nowIso)) continue;
    const amount = typeof arg?.amount === "string" ? arg.amount : "0";
    if (!ev.createdEventBlob?.trim()) continue;
    out.push({
      contractId: ev.contractId,
      createdEventBlob: ev.createdEventBlob ?? "",
      templateId: ev.templateId ?? CBTC_HOLDING_TEMPLATE_FQN,
      payload: {
        owner: party,
        amount,
        instrumentId: NETWORK.instrumentId
      }
    });
  }

  if (isVaultCbtcCacheParty(party)) {
    if (out.length > 0) syncVaultCbtcCacheFromAcs(out);
    let cached = getVaultCbtcCachedHoldings();
    if (cached.length === 0) {
      await refreshVaultCbtcCacheIfEmpty(jwt, party);
      cached = getVaultCbtcCachedHoldings();
    }
    // Prefer update-tree cache: polluted vault ACS often returns a stale subset.
    if (cached.length > 0) return cached;
  }

  return out;
}

export async function holdingsForAsset(
  jwt: string,
  party: string,
  asset: "CBTC" | "CC",
  limit: number = ACS_QUERY_BATCH_LIMIT
): Promise<Holding[]> {
  if (asset === "CBTC") return listCbtcHoldings(jwt, party, limit);
  const dso = await getDsoPartyId(jwt);
  return listCcHoldings(jwt, party, dso, limit);
}

/** @deprecated alias — all ACS reads use documented ?limit= param now. */
export async function holdingsForAssetOrBatch(
  jwt: string,
  party: string,
  asset: "CBTC" | "CC",
  batchLimit = ACS_QUERY_BATCH_LIMIT
): Promise<Holding[]> {
  return holdingsForAsset(jwt, party, asset, batchLimit);
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
  const countOne = async (asset: "CBTC" | "CC"): Promise<number> => {
    const n = (await holdingsForAsset(jwt, party, asset)).length;
    return n >= ACS_QUERY_BATCH_LIMIT ? ACS_QUERY_BATCH_LIMIT + 51 : n;
  };
  const [cbtc, cc] = await Promise.all([countOne("CBTC"), countOne("CC")]);
  return { cbtc, cc };
}

function sumHoldingUnits(holdings: Holding[], decimals: number): bigint {
  let units = 0n;
  for (const h of holdings) {
    units += toBaseUnitsFloor(h.payload?.amount ?? "0", decimals);
  }
  return units;
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
  const { fromBaseUnits } = await import("../../../lib/amount-units");
  return fromBaseUnits(sumHoldingUnits(holdings, 10), 10);
}

export async function cbtcBalance(jwt: string, party: string): Promise<string> {
  const holdings = await listCbtcHoldings(jwt, party);
  const { fromBaseUnits } = await import("../../../lib/amount-units");
  return fromBaseUnits(sumHoldingUnits(holdings, 8), 8);
}
