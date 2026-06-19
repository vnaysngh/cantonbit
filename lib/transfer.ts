/**
 * CBTC transfer flow — server-side TransferFactory / TransferInstruction helpers.
 *
 * Two phases:
 *   1. Sender creates a TransferInstruction (the offer) via TransferFactory_Transfer
 *   2. Receiver accepts via TransferInstruction_Accept
 *
 * Both phases use interface-style templateIds (with the `#` package-name prefix)
 * because the concrete AllocationFactory DAR isn't installed on the WarpX node —
 * but the splice-api-* interface packages are.
 *
 * The m2m JWT has authority over both the warpx party and every cbtc-user party
 * on this validator, so the same JWT can submit Phase 1 (as sender) and Phase 2
 * (as receiver) — the page-level UI controls which party acts when.
 */

import "server-only";

import { getLedgerJwt } from "./auth";
import { getPendingTransfers } from "./canton";
import type { InstrumentId } from "./constants";
import { NETWORK } from "./constants";
import { fetchCcRegistry } from "./cc-registry";
import { extractCreatedOfferCid } from "./mint-processor-logic";
import { selectTransferHoldings } from "./transfer-holdings";
import {
  buildTransferMeta,
  DEFAULT_TRANSFER_EXPIRATION_SECONDS
} from "./transfer-options";
import type { Holding } from "./types";

const TAG = "[transfer]";

// Concrete package hash for CBTC Holding disclosedContracts (Amulet uses Splice.Amulet).
const CBTC_HOLDING_TEMPLATE_FQN =
  "8107899ac4723ce986bf7d27416534e576e54b92161e46150a595fb78ff3d3a1:Utility.Registry.Holding.V0.Holding:Holding";

const AMULET_HOLDING_TEMPLATE_FQN =
  "a31be0483f3175647053f28965a4e6d97e3dbc433ea2338be303fae69bbcff6a:Splice.Amulet:Amulet";

function holdingDisclosedTemplateId(
  holding: Holding,
  registryKind: TransferRegistryKind
): string {
  if (holding.templateId) return holding.templateId;
  return registryKind === "cc"
    ? AMULET_HOLDING_TEMPLATE_FQN
    : CBTC_HOLDING_TEMPLATE_FQN;
}

const TRANSFER_FACTORY_INTERFACE =
  "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory";

const TRANSFER_INSTRUCTION_INTERFACE =
  "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction";

// 24-hour offer expiry — Splice convention. Receiver must accept within this
// window or the offer is auto-cancelled and the source holding is unlocked.
const TRANSFER_TTL_MS = 24 * 60 * 60 * 1000;

interface DisclosedContract {
  templateId: string;
  contractId: string;
  createdEventBlob: string;
  synchronizerId: string;
}

export type { DisclosedContract as TransferDisclosedContract };

interface TransferFactoryResponse {
  factoryId: string;
  transferKind: string;
  choiceContext: {
    choiceContextData: { values: Record<string, unknown> };
    disclosedContracts: DisclosedContract[];
  };
}

/** Which off-ledger registry serves TransferFactory / accept choice-contexts. */
export type TransferRegistryKind = "cbtc" | "cc";

function cbtcTransferFactoryUrl(registrarAdmin: string): string {
  return `${NETWORK.registryUrl}/api/token-standard/v0/registrars/${registrarAdmin}/registry/transfer-instruction/v1/transfer-factory`;
}

function cbtcAcceptChoiceContextUrl(
  registrarAdmin: string,
  offerContractId: string
): string {
  return `${NETWORK.registryUrl}/api/token-standard/v0/registrars/${registrarAdmin}/registry/transfer-instruction/v1/${offerContractId}/choice-contexts/accept`;
}

async function fetchTransferFactoryContext(
  kind: TransferRegistryKind,
  registrarAdmin: string,
  transferPayload: Record<string, unknown>
): Promise<Response> {
  const body = JSON.stringify({
    choiceArguments: {
      expectedAdmin: registrarAdmin,
      transfer: transferPayload,
      extraArgs: { context: { values: {} }, meta: { values: {} } }
    }
  });
  if (kind === "cc") {
    return fetchCcRegistry("/transfer-instruction/v1/transfer-factory", {
      method: "POST",
      body
    });
  }
  return fetch(cbtcTransferFactoryUrl(registrarAdmin), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    cache: "no-store"
  });
}

async function fetchAcceptChoiceContext(
  kind: TransferRegistryKind,
  registrarAdmin: string,
  offerContractId: string
): Promise<Response> {
  const body = JSON.stringify({ meta: {} });
  if (kind === "cc") {
    return fetchCcRegistry(
      `/transfer-instruction/v1/${offerContractId}/choice-contexts/accept`,
      { method: "POST", body }
    );
  }
  return fetch(cbtcAcceptChoiceContextUrl(registrarAdmin, offerContractId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    cache: "no-store"
  });
}

function cbtcRejectChoiceContextUrl(
  registrarAdmin: string,
  offerContractId: string
): string {
  return `${NETWORK.registryUrl}/api/token-standard/v0/registrars/${registrarAdmin}/registry/transfer-instruction/v1/${offerContractId}/choice-contexts/reject`;
}

async function fetchRejectChoiceContext(
  kind: TransferRegistryKind,
  registrarAdmin: string,
  offerContractId: string
): Promise<Response> {
  const body = JSON.stringify({ meta: {}, excludeDebugFields: true });
  if (kind === "cc") {
    return fetchCcRegistry(
      `/transfer-instruction/v1/${offerContractId}/choice-contexts/reject`,
      { method: "POST", body }
    );
  }
  return fetch(cbtcRejectChoiceContextUrl(registrarAdmin, offerContractId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    cache: "no-store"
  });
}

/** Infer registry kind from an offer's instrument id. */
export function registryKindForInstrument(
  instrumentId?: InstrumentId | null
): TransferRegistryKind {
  if (instrumentId?.id === "Amulet") return "cc";
  return "cbtc";
}

/** Result returned by createTransfer — exposes the new offer contract id. */
export interface CreateTransferResult {
  updateId: string;
  offerContractId: string;
  /** Registry transferKind: "offer" needs a receiver accept; "direct"/"self" means
   *  the transfer COMPLETED in one step (receiver preapproval auto-accepted it). */
  transferKind: string;
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

function mergeDisclosed(
  batches: DisclosedContract[][]
): DisclosedContract[] {
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

/** All legs must share one synchronizer for atomic multi-command submit. */
export function assertSameSynchronizer(
  legs: { synchronizerId: string }[],
  label = "transfer legs"
): string {
  const ids = legs.map((l) => l.synchronizerId).filter(Boolean);
  if (ids.length === 0) {
    throw new Error(`${label}: missing synchronizerId`);
  }
  const syncId = ids[0]!;
  for (const id of ids) {
    if (id !== syncId) {
      throw new Error(
        `${label}: different synchronizers (${syncId.slice(0, 12)}… vs ${id.slice(0, 12)}…) — cannot submit atomically`
      );
    }
  }
  return syncId;
}

export function stampDisclosedSynchronizer(
  disclosed: DisclosedContract[],
  synchronizerId: string
): DisclosedContract[] {
  return disclosed.map((dc) => ({
    ...dc,
    synchronizerId: dc.synchronizerId || synchronizerId
  }));
}

/** Build TransferFactory_Transfer without submitting (for atomic multi-leg settlement). */
export async function buildTransferExercise(params: {
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
    senderParty,
    receiverParty,
    amount,
    inputHoldings,
    expirationSeconds = DEFAULT_TRANSFER_EXPIRATION_SECONDS,
    instrumentId = NETWORK.instrumentId,
    registrarAdmin = NETWORK.decentralizedPartyId,
    registryKind = "cbtc",
    assetSymbol = instrumentId.id === "Amulet" ? "CC" : "CBTC",
    memo
  } = params;
  const now = new Date().toISOString();
  const ttlMs = Math.max(60, expirationSeconds) * 1000;
  const executeBefore = new Date(Date.now() + ttlMs).toISOString();
  const transferMeta = buildTransferMeta(memo);
  const picked = selectTransferHoldings(inputHoldings, amount, assetSymbol);
  const inputHoldingCids = picked.map((h) => h.contractId);
  const transferPayload = {
    sender: senderParty,
    receiver: receiverParty,
    amount,
    instrumentId,
    lock: null,
    requestedAt: now,
    executeBefore,
    inputHoldingCids,
    meta: transferMeta
  };
  const factoryRes = await fetchTransferFactoryContext(
    registryKind,
    registrarAdmin,
    transferPayload
  );
  if (!factoryRes.ok) {
    const text = await factoryRes.text().catch(() => "<no body>");
    throw new Error(
      `TransferFactory registry call failed (${factoryRes.status}): ${text}`
    );
  }
  const factory = (await factoryRes.json()) as TransferFactoryResponse;
  const disclosedContracts: DisclosedContract[] = [
    ...factory.choiceContext.disclosedContracts.map((dc) => ({
      ...dc,
      synchronizerId: dc.synchronizerId ?? ""
    })),
    ...picked.map((h) => ({
      templateId: holdingDisclosedTemplateId(h, registryKind),
      contractId: h.contractId,
      createdEventBlob: h.createdEventBlob ?? "",
      synchronizerId: ""
    }))
  ];
  const synchronizerId = pickSynchronizerId([disclosedContracts]);
  const command = {
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
  };
  return {
    command,
    disclosedContracts,
    transferKind: factory.transferKind ?? "",
    synchronizerId,
    registrarAdmin,
    registryKind,
    instrumentId
  };
}

/** Build TransferInstruction_Accept without submitting. */
export async function buildAcceptExercise(params: {
  offerContractId: string;
  registrarAdmin?: string;
  registryKind?: TransferRegistryKind;
}): Promise<BuiltAcceptLeg> {
  const {
    offerContractId,
    registrarAdmin = NETWORK.decentralizedPartyId,
    registryKind = "cbtc"
  } = params;
  const ctxRes = await fetchAcceptChoiceContext(
    registryKind,
    registrarAdmin,
    offerContractId
  );
  if (!ctxRes.ok) {
    const text = await ctxRes.text().catch(() => "<no body>");
    throw new Error(`accept choice-contexts failed (${ctxRes.status}): ${text}`);
  }
  const ctx = (await ctxRes.json()) as {
    choiceContextData: unknown;
    disclosedContracts: DisclosedContract[];
  };
  const disclosedContracts = (ctx.disclosedContracts ?? []).map((dc) => ({
    ...dc,
    synchronizerId: dc.synchronizerId ?? ""
  }));
  const synchronizerId = pickSynchronizerId([disclosedContracts]);
  const command = {
    ExerciseCommand: {
      templateId: TRANSFER_INSTRUCTION_INTERFACE,
      contractId: offerContractId,
      choice: "TransferInstruction_Accept",
      choiceArgument: {
        extraArgs: { context: ctx.choiceContextData, meta: { values: {} } }
      }
    }
  };
  return { command, disclosedContracts, synchronizerId };
}

/** Build TransferInstruction_Reject (receiver declines an inbound offer). */
export async function buildRejectExercise(params: {
  offerContractId: string;
  registrarAdmin?: string;
  registryKind?: TransferRegistryKind;
}): Promise<BuiltAcceptLeg> {
  const {
    offerContractId,
    registrarAdmin = NETWORK.decentralizedPartyId,
    registryKind = "cbtc"
  } = params;
  const ctxRes = await fetchRejectChoiceContext(
    registryKind,
    registrarAdmin,
    offerContractId
  );
  if (!ctxRes.ok) {
    const text = await ctxRes.text().catch(() => "<no body>");
    throw new Error(`reject choice-contexts failed (${ctxRes.status}): ${text}`);
  }
  const ctx = (await ctxRes.json()) as {
    choiceContextData: unknown;
    disclosedContracts: DisclosedContract[];
  };
  const disclosedContracts = (ctx.disclosedContracts ?? []).map((dc) => ({
    ...dc,
    synchronizerId: dc.synchronizerId ?? ""
  }));
  const synchronizerId = pickSynchronizerId([disclosedContracts]);
  const command = {
    ExerciseCommand: {
      templateId: TRANSFER_INSTRUCTION_INTERFACE,
      contractId: offerContractId,
      choice: "TransferInstruction_Reject",
      choiceArgument: {
        extraArgs: { context: ctx.choiceContextData, meta: { values: {} } }
      }
    }
  };
  return { command, disclosedContracts, synchronizerId };
}

/** Receiver rejects a pending TransferInstruction (unlocks sender funds). */
export async function rejectTransferOffer(params: {
  offerContractId: string;
  actAs: string[];
  registrarAdmin?: string;
  registryKind?: TransferRegistryKind;
  commandId?: string;
}): Promise<{ updateId: string }> {
  const built = await buildRejectExercise(params);
  const commandId =
    params.commandId ??
    `reject-${params.offerContractId.slice(0, 16)}-${Date.now()}`;
  const { updateId } = await submitLedgerCommands({
    actAs: params.actAs,
    commands: [built.command],
    disclosedContracts: built.disclosedContracts,
    commandId,
    workflowId: commandId,
    applicationId: "canton-swap",
    synchronizerId: built.synchronizerId || undefined
  });
  return { updateId };
}

/** Submit multiple ledger commands atomically (same synchronizer). */
export async function submitLedgerCommands(params: {
  actAs: string[];
  commands: unknown[];
  disclosedContracts: DisclosedContract[];
  commandId: string;
  workflowId?: string;
  applicationId?: string;
  /** Pin submission to one synchronizer (stamped on disclosed contracts too). */
  synchronizerId?: string;
}): Promise<{
  updateId: string;
  eventsById: Record<string, unknown>;
}> {
  const jwt = await getLedgerJwt();
  const disclosedContracts = params.synchronizerId
    ? stampDisclosedSynchronizer(params.disclosedContracts, params.synchronizerId)
    : params.disclosedContracts;
  const body: Record<string, unknown> = {
    applicationId: params.applicationId ?? "cbtc-app",
    workflowId: params.workflowId ?? `canton-cmd-${params.commandId}`,
    commandId: params.commandId,
    actAs: params.actAs,
    readAs: params.actAs,
    commands: params.commands,
    disclosedContracts
  };
  if (params.synchronizerId) {
    body.synchronizerId = params.synchronizerId;
  }
  const res = await fetch(
    `${NETWORK.ledgerHost}/v2/commands/submit-and-wait-for-transaction-tree`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`
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
    throw new Error(`ledger submit failed (${res.status}): ${text}`);
  }
  const json = JSON.parse(text) as {
    transactionTree?: {
      updateId: string;
      eventsById?: Record<string, unknown>;
    };
  };
  return {
    updateId: json.transactionTree?.updateId ?? "",
    eventsById: json.transactionTree?.eventsById ?? {}
  };
}

/** POST /v2/interactive-submission/prepare — traffic byte estimate (no submit). */
export async function prepareLedgerCommands(params: {
  actAs: string[];
  commands: unknown[];
  disclosedContracts: DisclosedContract[];
  commandId?: string;
  synchronizerId?: string;
}): Promise<{
  totalTrafficBytes: number;
  costEstimation?: Record<string, unknown>;
}> {
  const jwt = await getLedgerJwt();
  const commandId =
    params.commandId ??
    `prepare-${Math.random().toString(16).slice(2)}-${Date.now()}`;
  const synchronizerId =
    params.synchronizerId?.trim() ||
    pickSynchronizerId([params.disclosedContracts]);
  if (!synchronizerId) {
    throw new Error(
      "prepare requires synchronizerId — none on disclosed contracts"
    );
  }
  const disclosedContracts = stampDisclosedSynchronizer(
    params.disclosedContracts,
    synchronizerId
  );
  const body: Record<string, unknown> = {
    commandId,
    actAs: params.actAs,
    readAs: params.actAs,
    commands: params.commands,
    disclosedContracts,
    synchronizerId,
    packageIdSelectionPreference: []
  };
  const res = await fetch(
    `${NETWORK.ledgerHost}/v2/interactive-submission/prepare`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`
      },
      cache: "no-store",
      body: JSON.stringify(body)
    }
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`prepare failed (${res.status}): ${text}`);
  }
  const json = JSON.parse(text) as {
    costEstimation?: Record<string, unknown>;
    cost_estimation?: Record<string, unknown>;
  };
  const cost =
    json.costEstimation ??
    json.cost_estimation ??
    {};
  const rawBytes =
    cost.totalTrafficCostEstimation ??
    cost.total_traffic_cost_estimation ??
    0;
  const totalTrafficBytes = Number(rawBytes);
  return {
    totalTrafficBytes: Number.isFinite(totalTrafficBytes) ? totalTrafficBytes : 0,
    costEstimation: cost
  };
}

export {
  mergeDisclosed,
  pickSynchronizerId
};

/**
 * Phase 1: sender exercises TransferFactory_Transfer to create a TransferInstruction.
 *
 * The sender party must be one the m2m JWT has authority over (warpx party or
 * any cbtc-user party on this node). The holdings passed in inputHoldings must
 * all be owned by the sender.
 *
 * Returns the new TransferInstruction contract id, which the receiver later
 * passes to acceptTransfer().
 */
export async function createTransfer(params: {
  senderParty: string;
  receiverParty: string;
  amountBtc: string;
  inputHoldings: Holding[];
  /** Optional human-readable memo (CIP-0056 reason meta). */
  memo?: string;
  /** Offer accept window in seconds (maps to executeBefore). Default 1h. */
  expirationSeconds?: number;
  instrumentId?: InstrumentId;
  registrarAdmin?: string;
  registryKind?: TransferRegistryKind;
  /** Asset symbol for balance-selection errors. */
  assetSymbol?: string;
}): Promise<CreateTransferResult> {
  const {
    senderParty,
    receiverParty,
    amountBtc,
    inputHoldings,
    memo,
    expirationSeconds = DEFAULT_TRANSFER_EXPIRATION_SECONDS,
    instrumentId = NETWORK.instrumentId,
    registrarAdmin = NETWORK.decentralizedPartyId,
    registryKind = "cbtc",
    assetSymbol = instrumentId.id === "Amulet" ? "CC" : "CBTC"
  } = params;
  const jwt = await getLedgerJwt();
  const now = new Date().toISOString();
  const ttlMs = Math.max(60, expirationSeconds) * 1000;
  const executeBefore = new Date(Date.now() + ttlMs).toISOString();
  const transferMeta = buildTransferMeta(memo);

  const picked = selectTransferHoldings(inputHoldings, amountBtc, assetSymbol);
  const inputHoldingCids = picked.map((h) => h.contractId);

  console.log(
    `${TAG} createTransfer sender=${senderParty.slice(0, 20)}... receiver=${receiverParty.slice(0, 20)}... amount=${amountBtc} ttl=${expirationSeconds}s inputs=${inputHoldingCids.length}`,
  );

  const transferPayload = {
    sender: senderParty,
    receiver: receiverParty,
    amount: amountBtc,
    instrumentId,
    lock: null,
    requestedAt: now,
    executeBefore,
    inputHoldingCids,
    meta: transferMeta
  };

  // Step 1: fetch TransferFactory from the registry — gives us the factoryId
  // and the disclosed contracts (instrument config, transfer rule).
  const factoryRes = await fetchTransferFactoryContext(
    registryKind,
    registrarAdmin,
    transferPayload
  );

  if (!factoryRes.ok) {
    const text = await factoryRes.text().catch(() => "<no body>");
    throw new Error(`TransferFactory registry call failed (${factoryRes.status}): ${text}`);
  }
  const factory = (await factoryRes.json()) as TransferFactoryResponse;

  // Step 2: submit TransferFactory_Transfer on the ledger as the sender.
  const commandId = crypto.randomUUID();
  const disclosed: DisclosedContract[] = [
    ...factory.choiceContext.disclosedContracts.map((dc) => ({
      ...dc,
      synchronizerId: dc.synchronizerId ?? "",
    })),
    // Each input holding must be disclosed — templateId must match createdEventBlob.
    ...picked.map((h) => ({
      templateId: holdingDisclosedTemplateId(h, registryKind),
      contractId: h.contractId,
      createdEventBlob: h.createdEventBlob ?? "",
      synchronizerId: "",
    })),
  ];

  const submitRes = await fetch(
    `${NETWORK.ledgerHost}/v2/commands/submit-and-wait-for-transaction-tree`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({
        applicationId: "cbtc-app",
        workflowId: `cbtc-transfer-${commandId}`,
        commandId,
        actAs: [senderParty],
        readAs: [senderParty],
        commands: [
          {
            ExerciseCommand: {
              templateId: TRANSFER_FACTORY_INTERFACE,
              contractId: factory.factoryId,
              choice: "TransferFactory_Transfer",
              choiceArgument: {
                expectedAdmin: registrarAdmin,
                transfer: transferPayload,
                extraArgs: {
                  context: factory.choiceContext.choiceContextData,
                  meta: { values: {} },
                },
              },
            },
          },
        ],
        disclosedContracts: disclosed,
      }),
      cache: "no-store",
    },
  );

  if (!submitRes.ok) {
    const text = await submitRes.text().catch(() => "<no body>");
    throw new Error(`TransferFactory_Transfer submit failed (${submitRes.status}): ${text}`);
  }

  const submitJson = (await submitRes.json()) as {
    transactionTree?: {
      updateId: string;
      eventsById: Record<string, unknown>;
    };
  };
  const updateId = submitJson.transactionTree?.updateId ?? "";

  // The created TransferInstruction is in OUR OWN tx tree (the sender always sees
  // what it created) — read it from there, NO cross-participant ACS read needed.
  // This is the cid the Loop receiver accepts. Reuse the tested extractCreatedOfferCid
  // (handles both the CreatedTreeEvent and flat CreatedEvent shapes). Fall back to the
  // receiver-ACS lookup only if the tree didn't surface it (best-effort; a 403 must
  // NOT fail the transfer).
  let offerContractId = extractCreatedOfferCid(submitJson.transactionTree?.eventsById) ?? "";
  if (!offerContractId) {
    try {
      offerContractId = (await findOfferForInputs(receiverParty, inputHoldingCids)) ?? "";
    } catch (e) {
      console.log(`${TAG} offer lookup skipped (cross-participant / ${e instanceof Error ? e.message.slice(0, 60) : e})`);
    }
  }

  console.log(`${TAG} ✅ createTransfer ok updateId=${updateId.slice(0, 20)}... kind=${factory.transferKind} offerCid=${offerContractId.slice(0, 20) || "(none — direct/auto-accepted)"}`);
  return { updateId, offerContractId, transferKind: factory.transferKind ?? "" };
}

/**
 * RECOVERY: find a pending TransferOffer/TransferInstruction from the SENDER's own
 * ACS (the sender is a stakeholder, so this works even when the receiver is on
 * another participant). Used when the offer cid wasn't captured at create time.
 * Returns the newest matching offer to `receiverParty`, or null.
 */
export async function findOfferFromSender(
  senderParty: string,
  receiverParty: string,
): Promise<string | null> {
  const offers = await listPendingOffersAs(senderParty);
  const match = offers.filter((o) => o.receiver === receiverParty && o.sender === senderParty);
  // Newest first by requestedAt — if several, the latest is ours.
  match.sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : -1));
  return match[0]?.contractId ?? null;
}

/**
 * Find the TransferOffer just created for `receiverParty` whose
 * inputHoldingCids include one of the source holdings we passed in.
 */
async function findOfferForInputs(
  receiverParty: string,
  sourceHoldingCids: string[],
): Promise<string | null> {
  const offers = await listPendingOffers(receiverParty);
  const sourceSet = new Set(sourceHoldingCids);
  for (const o of offers) {
    if (o.inputHoldingCids.some((c) => sourceSet.has(c))) return o.contractId;
  }
  return null;
}

export interface PendingOffer {
  contractId: string;
  sender: string;
  receiver: string;
  amountBtc: string;
  requestedAt: string;
  executeBefore: string;
  inputHoldingCids: string[];
  instrumentId?: InstrumentId;
}

/**
 * List active TransferInstruction contracts where the given party is the receiver.
 * Uses the Canton interface-filter ACS path (same as getPendingTransfers).
 */
export async function listPendingOffers(partyId: string): Promise<PendingOffer[]> {
  const transfers = await getPendingTransfers(partyId);
  return transfers.map((t) => ({
    contractId: t.contractId,
    sender: t.payload.sender,
    receiver: t.payload.receiver,
    amountBtc: t.payload.amount,
    requestedAt: "",
    executeBefore: "",
    inputHoldingCids: [] as string[],
    instrumentId: t.payload.instrumentId
  }));
}

/** Outgoing offers the sender created and are still pending acceptance. */
export async function listOutgoingOffers(senderParty: string): Promise<PendingOffer[]> {
  const all = await listPendingOffersAs(senderParty);
  return all.filter((o) => o.sender === senderParty);
}

type RawTransferFields = {
  sender?: string;
  receiver?: string;
  amount?: string;
  requestedAt?: string;
  executeBefore?: string;
  inputHoldingCids?: string[];
  instrumentId?: InstrumentId;
};

function pickTransferInstructionSuffix(interfaceId: string): string {
  return interfaceId.split(":").slice(1).join(":");
}

/** Read transfer fields from createArgument or Splice interfaceViews (required for ACS). */
function readTransferInstructionFields(ev: {
  createArgument?: { transfer?: RawTransferFields };
  interfaceViews?: Array<{
    interfaceId?: string;
    viewValue?: unknown;
    viewStatus?: { code?: number };
  }>;
}): RawTransferFields | null {
  const arg = ev.createArgument?.transfer;
  if (arg?.receiver) return arg;

  const wantSuffix = pickTransferInstructionSuffix(TRANSFER_INSTRUCTION_INTERFACE);
  for (const view of ev.interfaceViews ?? []) {
    if (view.viewStatus?.code) continue;
    const id = view.interfaceId ?? "";
    if (
      id !== TRANSFER_INSTRUCTION_INTERFACE &&
      pickTransferInstructionSuffix(id) !== wantSuffix
    ) {
      continue;
    }
    const vv = view.viewValue as
      | { transfer?: RawTransferFields }
      | RawTransferFields
      | undefined;
    if (!vv || typeof vv !== "object") continue;
    const t = ("transfer" in vv ? vv.transfer : vv) as RawTransferFields | undefined;
    if (t?.receiver) return t;
  }
  return null;
}

function unwrapAcsEntries(raw: unknown): Array<{
  JsActiveContract: {
    createdEvent: {
      contractId: string;
      templateId?: string;
      createArgument?: { transfer?: RawTransferFields };
      interfaceViews?: Array<{
        interfaceId?: string;
        viewValue?: unknown;
        viewStatus?: { code?: number };
      }>;
    };
  };
}> {
  if (!Array.isArray(raw)) return [];
  const out: ReturnType<typeof unwrapAcsEntries> = [];
  for (const item of raw) {
    const entry =
      (item as { contractEntry?: { JsActiveContract?: unknown } })?.contractEntry
        ?.JsActiveContract ??
      (item as { JsActiveContract?: unknown })?.JsActiveContract;
    if (entry && typeof entry === "object") {
      out.push(entry as ReturnType<typeof unwrapAcsEntries>[number]);
    }
  }
  return out;
}

/**
 * List ALL active TransferInstruction/TransferOffer contracts visible to `partyId`
 * (no receiver filter — a SENDER sees the offers it created, even cross-participant).
 */
async function listPendingOffersAs(partyId: string): Promise<PendingOffer[]> {
  const jwt = await getLedgerJwt();
  const endRes = await fetch(`${NETWORK.ledgerHost}/v2/state/ledger-end`, {
    headers: { Authorization: `Bearer ${jwt}` },
    cache: "no-store",
  });
  if (!endRes.ok) throw new Error(`getLedgerEnd failed (${endRes.status})`);
  const { offset } = (await endRes.json()) as { offset: number };

  const acsRes = await fetch(`${NETWORK.ledgerHost}/v2/state/active-contracts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({
      filter: {
        filtersByParty: {
          [partyId]: {
            cumulative: [
              {
                identifierFilter: {
                  InterfaceFilter: {
                    value: {
                      interfaceId: TRANSFER_INSTRUCTION_INTERFACE,
                      includeInterfaceView: true,
                      includeCreatedEventBlob: false,
                    },
                  },
                },
              },
            ],
          },
        },
      },
      verbose: false,
      activeAtOffset: offset,
    }),
    cache: "no-store",
  });

  if (!acsRes.ok) {
    const text = await acsRes.text().catch(() => "<no body>");
    throw new Error(`listPendingOffers ACS query failed (${acsRes.status}): ${text}`);
  }

  const out: PendingOffer[] = [];
  for (const entry of unwrapAcsEntries(await acsRes.json())) {
    const ev =
      (entry as { JsActiveContract?: { createdEvent?: { contractId?: string } } })
        .JsActiveContract?.createdEvent ??
      (entry as { createdEvent?: { contractId?: string } }).createdEvent;
    if (!ev?.contractId) continue;
    const t = readTransferInstructionFields(ev);
    if (!t?.receiver) continue;
    out.push({
      contractId: ev.contractId,
      sender: t.sender ?? "",
      receiver: t.receiver,
      amountBtc: t.amount ?? "0",
      requestedAt: t.requestedAt ?? "",
      executeBefore: t.executeBefore ?? "",
      inputHoldingCids: t.inputHoldingCids ?? [],
      instrumentId: t.instrumentId,
    });
  }
  return out;
}

/**
 * LOOP SELLER (Variant A — transfer-to-venue custody, = Cancore): PREPARE the
 * standard TransferFactory_Transfer for the USER to sign in their own wallet
 * (sender = their Loop party, receiver = our venue/solver party). Their holdings
 * live on THEIR participant (cids read in the browser); the registry rule/config
 * contracts are disclosed via the factory choice-context.
 */
export async function prepareTransferCommand(params: {
  senderParty: string;
  receiverParty: string;
  amountBtc: string;
  inputHoldingCids: string[];
  instrumentId?: InstrumentId;
  registrarAdmin?: string;
  registryKind?: TransferRegistryKind;
  expirationSeconds?: number;
}): Promise<{
  command: unknown;
  disclosedContracts: DisclosedContract[];
  synchronizerId: string;
  transferKind: string;
}> {
  const instrumentId = params.instrumentId ?? NETWORK.instrumentId;
  const registryKind =
    params.registryKind ?? registryKindForInstrument(instrumentId);
  const registrarAdmin =
    params.registrarAdmin ??
    instrumentId.admin ??
    NETWORK.decentralizedPartyId;
  const ttlMs =
    Math.max(60, params.expirationSeconds ?? DEFAULT_TRANSFER_EXPIRATION_SECONDS) *
    1000;
  const now = new Date().toISOString();
  const executeBefore = new Date(Date.now() + ttlMs).toISOString();
  const transfer = {
    sender: params.senderParty,
    receiver: params.receiverParty,
    amount: params.amountBtc,
    instrumentId,
    lock: null,
    requestedAt: now,
    executeBefore,
    inputHoldingCids: params.inputHoldingCids,
    meta: { values: {} }
  };
  const factoryRes = await fetchTransferFactoryContext(
    registryKind,
    registrarAdmin,
    transfer
  );
  if (!factoryRes.ok) {
    throw new Error(
      `TransferFactory registry call failed (${factoryRes.status}): ${await factoryRes.text()}`
    );
  }
  const factory = (await factoryRes.json()) as TransferFactoryResponse;
  const disclosedContracts = factory.choiceContext.disclosedContracts.map(
    (dc) => ({
      ...dc,
      synchronizerId: dc.synchronizerId ?? ""
    })
  );
  const synchronizerId =
    disclosedContracts.find((d) => d.synchronizerId)?.synchronizerId ?? "";
  const command = {
    ExerciseCommand: {
      templateId: TRANSFER_FACTORY_INTERFACE,
      contractId: factory.factoryId,
      choice: "TransferFactory_Transfer",
      choiceArgument: {
        expectedAdmin: registrarAdmin,
        transfer,
        extraArgs: {
          context: factory.choiceContext.choiceContextData,
          meta: { values: {} }
        }
      }
    }
  };
  return {
    command,
    disclosedContracts,
    synchronizerId,
    transferKind: factory.transferKind ?? ""
  };
}

/**
 * Phase 2 (LOOP / cross-participant receiver) — PREPARE the standard
 * TransferInstruction_Accept command for the USER to sign in their own wallet.
 *
 * For a Loop receiver we CANNOT backend-submit (we lack authority over their
 * party), so the user signs the accept themselves. This is a STANDARD Splice
 * choice (TransferInstruction_Accept) that runs on Loop's node — no custom DAR.
 * Returns the command + disclosed contracts + synchronizerId for the browser to
 * hand to provider.submitAndWaitForTransaction(). The secret/claim logic stays on
 * our node (the solver claims the WBTC); the user only signs this standard accept.
 */
export async function prepareAcceptCommand(params: {
  offerContractId: string;
  registrarAdmin?: string;
  registryKind?: TransferRegistryKind;
}): Promise<{ command: unknown; disclosedContracts: DisclosedContract[]; synchronizerId: string }> {
  const built = await buildAcceptExercise({
    offerContractId: params.offerContractId,
    registrarAdmin: params.registrarAdmin,
    registryKind: params.registryKind
  });
  return {
    command: built.command,
    disclosedContracts: built.disclosedContracts,
    synchronizerId: built.synchronizerId
  };
}

/**
 * Phase 2: receiver exercises TransferInstruction_Accept on the offer.
 * Unlocks the source holding and creates a new holding owned by the receiver.
 */
export async function acceptTransfer(params: {
  receiverParty: string;
  offerContractId: string;
  registrarAdmin?: string;
  registryKind?: TransferRegistryKind;
}): Promise<{ updateId: string }> {
  const {
    receiverParty,
    offerContractId,
    registrarAdmin = NETWORK.decentralizedPartyId,
    registryKind = "cbtc"
  } = params;
  const jwt = await getLedgerJwt();

  const ctxRes = await fetchAcceptChoiceContext(
    registryKind,
    registrarAdmin,
    offerContractId
  );
  if (!ctxRes.ok) {
    const text = await ctxRes.text().catch(() => "<no body>");
    throw new Error(`accept choice-contexts failed (${ctxRes.status}): ${text}`);
  }
  const ctx = (await ctxRes.json()) as {
    choiceContextData: unknown;
    disclosedContracts: DisclosedContract[];
  };

  const commandId = crypto.randomUUID();
  const submitRes = await fetch(
    `${NETWORK.ledgerHost}/v2/commands/submit-and-wait-for-transaction-tree`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({
        applicationId: "cbtc-app",
        workflowId: `cbtc-accept-${commandId}`,
        commandId,
        actAs: [receiverParty],
        readAs: [receiverParty],
        commands: [
          {
            ExerciseCommand: {
              templateId: TRANSFER_INSTRUCTION_INTERFACE,
              contractId: offerContractId,
              choice: "TransferInstruction_Accept",
              choiceArgument: {
                extraArgs: {
                  context: ctx.choiceContextData,
                  meta: { values: {} },
                },
              },
            },
          },
        ],
        disclosedContracts: ctx.disclosedContracts.map((dc) => ({
          ...dc,
          synchronizerId: dc.synchronizerId ?? "",
        })),
      }),
      cache: "no-store",
    },
  );

  if (!submitRes.ok) {
    const text = await submitRes.text().catch(() => "<no body>");
    throw new Error(`TransferInstruction_Accept submit failed (${submitRes.status}): ${text}`);
  }
  const { transactionTree } = (await submitRes.json()) as {
    transactionTree?: { updateId: string };
  };
  const updateId = transactionTree?.updateId ?? "";
  console.log(`${TAG} ✅ acceptTransfer ok updateId=${updateId.slice(0, 20)}...`);
  return { updateId };
}
