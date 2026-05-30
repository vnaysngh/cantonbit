/**
 * cBTC transfer flow — server-side TransferFactory / TransferInstruction helpers.
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
import { NETWORK } from "./constants";
import { formatSatoshis } from "./format";
import type { Holding } from "./types";

const TAG = "[transfer]";

// Concrete package hash for the Holding template — used as the disclosedContracts
// templateId for the source holding. The v2 commands endpoint rejects the
// interface-style `#` form there, but accepts it on the ExerciseCommand itself.
const HOLDING_TEMPLATE_FQN =
  "8107899ac4723ce986bf7d27416534e576e54b92161e46150a595fb78ff3d3a1:Utility.Registry.Holding.V0.Holding:Holding";

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

interface TransferFactoryResponse {
  factoryId: string;
  transferKind: string;
  choiceContext: {
    choiceContextData: { values: Record<string, unknown> };
    disclosedContracts: DisclosedContract[];
  };
}

/** Result returned by createTransfer — exposes the new offer contract id. */
export interface CreateTransferResult {
  updateId: string;
  offerContractId: string;
}

/**
 * Select holdings to cover `amount` (BTC string).
 * Greedy: largest first, accumulate until amount is met, throw on insufficient.
 * Returns the holdings actually used (callers pass these to inputHoldingCids).
 */
function selectHoldings(holdings: Holding[], amountBtc: string): Holding[] {
  const target = BigInt(Math.round(parseFloat(amountBtc) * 1e8));
  const sorted = [...holdings].sort((a, b) => {
    const aSats = BigInt(Math.round(parseFloat(a.payload.amount ?? "0") * 1e8));
    const bSats = BigInt(Math.round(parseFloat(b.payload.amount ?? "0") * 1e8));
    if (bSats > aSats) return 1;
    if (bSats < aSats) return -1;
    return 0;
  });
  const picked: Holding[] = [];
  let acc = 0n;
  for (const h of sorted) {
    if (acc >= target) break;
    picked.push(h);
    acc += BigInt(Math.round(parseFloat(h.payload.amount ?? "0") * 1e8));
  }
  if (acc < target) {
    throw new Error(
      `Insufficient balance: have ${formatSatoshis(acc)} cBTC, need ${amountBtc} cBTC`,
    );
  }
  return picked;
}

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
}): Promise<CreateTransferResult> {
  const { senderParty, receiverParty, amountBtc, inputHoldings } = params;
  const jwt = await getLedgerJwt();
  const now = new Date().toISOString();
  const executeBefore = new Date(Date.now() + TRANSFER_TTL_MS).toISOString();

  const picked = selectHoldings(inputHoldings, amountBtc);
  const inputHoldingCids = picked.map((h) => h.contractId);

  console.log(
    `${TAG} createTransfer sender=${senderParty.slice(0, 20)}... receiver=${receiverParty.slice(0, 20)}... amount=${amountBtc} inputs=${inputHoldingCids.length}`,
  );

  // Step 1: fetch TransferFactory from the registry — gives us the factoryId
  // and the disclosed contracts (instrument config, transfer rule).
  const registryUrl = `${NETWORK.registryUrl}/api/token-standard/v0/registrars/${NETWORK.decentralizedPartyId}/registry/transfer-instruction/v1/transfer-factory`;
  const factoryRes = await fetch(registryUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      choiceArguments: {
        expectedAdmin: NETWORK.decentralizedPartyId,
        transfer: {
          sender: senderParty,
          receiver: receiverParty,
          amount: amountBtc,
          instrumentId: NETWORK.instrumentId,
          lock: null,
          requestedAt: now,
          executeBefore,
          inputHoldingCids,
          meta: { values: {} },
        },
        extraArgs: { context: { values: {} }, meta: { values: {} } },
      },
    }),
    cache: "no-store",
  });

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
    // Each input holding must be disclosed so the ledger can validate it.
    ...picked.map((h) => ({
      templateId: HOLDING_TEMPLATE_FQN,
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
                expectedAdmin: NETWORK.decentralizedPartyId,
                transfer: {
                  sender: senderParty,
                  receiver: receiverParty,
                  amount: amountBtc,
                  instrumentId: NETWORK.instrumentId,
                  lock: null,
                  requestedAt: now,
                  executeBefore,
                  inputHoldingCids,
                  meta: { values: {} },
                },
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

  // The TransferInstruction we just created is the `output.value.transferInstructionCid`
  // on the ExerciseResult — but extracting it from the tree is finicky, so we
  // look it up from the receiver's ACS instead.
  const offerContractId = await findOfferForInputs(receiverParty, inputHoldingCids);
  if (!offerContractId) {
    throw new Error(
      `Transfer submitted (updateId=${updateId}) but no TransferOffer found for receiver=${receiverParty.slice(0, 30)}...`,
    );
  }

  console.log(`${TAG} ✅ createTransfer ok updateId=${updateId.slice(0, 20)}... offerCid=${offerContractId.slice(0, 20)}...`);
  return { updateId, offerContractId };
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
}

/**
 * List active TransferInstruction (a.k.a. TransferOffer) contracts where the
 * given party is the receiver.
 */
export async function listPendingOffers(partyId: string): Promise<PendingOffer[]> {
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
                  WildcardFilter: { value: { includeCreatedEventBlob: false } },
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

  const items = (await acsRes.json()) as Array<{
    contractEntry?: {
      JsActiveContract?: {
        createdEvent?: {
          contractId: string;
          templateId: string;
          createArgument?: {
            transfer?: {
              sender?: string;
              receiver?: string;
              amount?: string;
              requestedAt?: string;
              executeBefore?: string;
              inputHoldingCids?: string[];
            };
          };
        };
      };
    };
  }>;

  const out: PendingOffer[] = [];
  for (const item of items) {
    const ev = item.contractEntry?.JsActiveContract?.createdEvent;
    if (!ev) continue;
    if (
      !ev.templateId.includes("TransferOffer") &&
      !ev.templateId.includes("TransferInstruction")
    ) {
      continue;
    }
    const t = ev.createArgument?.transfer;
    if (!t?.receiver || t.receiver !== partyId) continue;
    out.push({
      contractId: ev.contractId,
      sender: t.sender ?? "",
      receiver: t.receiver,
      amountBtc: t.amount ?? "0",
      requestedAt: t.requestedAt ?? "",
      executeBefore: t.executeBefore ?? "",
      inputHoldingCids: t.inputHoldingCids ?? [],
    });
  }
  return out;
}

/**
 * Phase 2: receiver exercises TransferInstruction_Accept on the offer.
 * Unlocks the source holding and creates a new holding owned by the receiver.
 */
export async function acceptTransfer(params: {
  receiverParty: string;
  offerContractId: string;
}): Promise<{ updateId: string }> {
  const { receiverParty, offerContractId } = params;
  const jwt = await getLedgerJwt();

  // Fetch the accept choice context from the registry — it tells us which
  // disclosed contracts (transfer rule, instrument config) are needed.
  const ctxUrl = `${NETWORK.registryUrl}/api/token-standard/v0/registrars/${NETWORK.decentralizedPartyId}/registry/transfer-instruction/v1/${offerContractId}/choice-contexts/accept`;
  const ctxRes = await fetch(ctxUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ meta: {} }),
    cache: "no-store",
  });
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
