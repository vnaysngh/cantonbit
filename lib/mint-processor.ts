/**
 * Mint processor — detects new cBTC Holdings on the warpx party and
 * transfers them to the correct user party.
 *
 * Flow:
 * 1. Read last_processed_offset from Supabase (mint_processor_state)
 * 2. Call /v2/updates from that offset to current ledger end
 * 3. For each transaction containing a Holding CreatedEvent + DepositAccount ArchivedEvent:
 *    a. Look up user via deposit_account_contract_id in Supabase
 *    b. Fallback: resolve bitcoin address from coordinator → look up user by bitcoin_address
 *    c. Insert mint_transfers row (status=pending) — skips if holding already processed (unique constraint)
 *    d. Transfer holding to user's canton_party_id
 *    e. Update mint_transfers row (status=transferred or failed)
 * 4. Update last_processed_offset to current ledger end
 */

import "server-only";

import { getLedgerJwt } from "./auth";
import { getBitcoinAddress } from "./bitsafe";
import { NETWORK } from "./constants";
import { extractCreatedOfferCid } from "./mint-processor-logic";
import { createSupabaseServiceClient } from "./supabase/server";

const TAG = "[mint-processor]";

const HOLDING_TEMPLATE = "Utility.Registry.Holding.V0.Holding:Holding";
const DEPOSIT_ACCOUNT_TEMPLATE = "CBTC.DepositAccount:CBTCDepositAccount";

// Concrete package hash for the Holding template (needed for disclosedContracts —
// the v2 commands endpoint rejects interface-style # templateIds in disclosedContracts).
// This was confirmed via /v2/packages on the warpx node.
const HOLDING_TEMPLATE_FQN =
  "8107899ac4723ce986bf7d27416534e576e54b92161e46150a595fb78ff3d3a1:Utility.Registry.Holding.V0.Holding:Holding";

// Package-NAME form of the Holding template. The ACS TemplateFilter rejects the
// package-HASH form (HOLDING_TEMPLATE_FQN) and requires a package name (the `#`
// form). Used only for the active-contracts query filter.
const HOLDING_TEMPLATE_BY_NAME =
  "#utility-registry-holding-v0:Utility.Registry.Holding.V0.Holding:Holding";

// Interface-style template IDs — these work because the splice-api-* interface
// packages ARE installed on the warpx node. The concrete AllocationFactory
// package (82798df0...) is NOT, so we must go through the interface.
const TRANSFER_FACTORY_INTERFACE =
  "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory";
const TRANSFER_INSTRUCTION_INTERFACE =
  "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction";

export interface MintProcessorResult {
  processedOffset: number;
  transactionsScanned: number;
  mintsFound: number;
  transferred: number;
  failed: number;
  skipped: number;
  errors: string[];
}

// ---------- ledger helpers ----------

async function getLedgerEnd(): Promise<number> {
  const jwt = await getLedgerJwt();
  const res = await fetch(`${NETWORK.ledgerHost}/v2/state/ledger-end`, {
    headers: { Authorization: `Bearer ${jwt}` },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`getLedgerEnd failed (${res.status})`);
  const data = await res.json() as { offset?: number };
  return data.offset ?? 0;
}

interface LedgerEvent {
  ArchivedEvent?: {
    offset: number;
    contractId: string;
    templateId: string;
  };
  CreatedEvent?: {
    offset: number;
    contractId: string;
    templateId: string;
    createArgument?: Record<string, unknown>;
    createdEventBlob?: string;
    interfaceViews?: Array<{
      interfaceId: string;
      viewValue?: unknown;
      viewStatus?: { code?: number };
    }>;
  };
}

interface LedgerTransaction {
  updateId: string;
  offset: number;
  effectiveAt: string;
  events: LedgerEvent[];
}

// ---------- holding-based discovery (offset-independent) ----------

interface ActiveHolding {
  contractId: string;
  amount: string;
  createdEventBlob: string;
  createOffset: number;
}

/**
 * The to-do list: every active cBTC Holding currently OWNED BY WARPX.
 *
 * This is the source of truth for "unfinished mint work" — a holding sitting on
 * warpx has not yet reached a user. Unlike an offset cursor, this snapshot can
 * never strand a holding: the moment one is transferred it's archived on warpx
 * and disappears from this list. Re-running just re-reads the current state.
 *
 * We request createdEventBlob because the transfer's disclosedContracts needs it.
 */
async function getActiveWarpxHoldings(): Promise<ActiveHolding[]> {
  const jwt = await getLedgerJwt();
  const warpxParty = NETWORK.warpxPartyId;

  const endRes = await fetch(`${NETWORK.ledgerHost}/v2/state/ledger-end`, {
    headers: { Authorization: `Bearer ${jwt}` },
    cache: "no-store",
  });
  const { offset } = (await endRes.json()) as { offset: number };

  const res = await fetch(`${NETWORK.ledgerHost}/v2/state/active-contracts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({
      filter: {
        filtersByParty: {
          [warpxParty]: {
            cumulative: [
              {
                identifierFilter: {
                  TemplateFilter: {
                    value: {
                      templateId: HOLDING_TEMPLATE_BY_NAME,
                      includeCreatedEventBlob: true,
                    },
                  },
                },
              },
            ],
          },
        },
      },
      verbose: true,
      activeAtOffset: offset,
    }),
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "<no body>");
    throw new Error(`getActiveWarpxHoldings failed (${res.status}): ${text}`);
  }

  const items = (await res.json()) as Array<{
    contractEntry?: {
      JsActiveContract?: {
        createdEvent?: {
          contractId: string;
          offset: number;
          templateId: string;
          createdEventBlob?: string;
          createArgument?: { amount?: string; owner?: string };
        };
      };
    };
  }>;

  const holdings: ActiveHolding[] = [];
  for (const item of Array.isArray(items) ? items : []) {
    const ev = item.contractEntry?.JsActiveContract?.createdEvent;
    if (!ev?.contractId) continue;
    if (!ev.templateId.includes(HOLDING_TEMPLATE)) continue;
    if (ev.createArgument?.owner !== warpxParty) continue; // defensive: only warpx-owned
    holdings.push({
      contractId: ev.contractId,
      amount: ev.createArgument?.amount ?? "0",
      createdEventBlob: ev.createdEventBlob ?? "",
      createOffset: ev.offset,
    });
  }
  return holdings;
}

interface MintInfo {
  archivedDepositAccountCid: string;
  rolledForwardDaOriginalId: string | null;
  createOffset: number;
}

/**
 * Given an active warpx holding, determine whether it is a MINT (its creating
 * transaction archived a CBTCDepositAccount) and, if so, return the data needed
 * to resolve the owning user.
 *
 * Returns null if the holding's creating transaction did NOT archive a deposit
 * account — i.e. it's change/leftover from a transfer, not a mint, and must be
 * left alone.
 *
 * Offset is used here only as a LOOKUP key (find this specific holding's create
 * transaction), never as a scan window — so nothing can be stranded.
 */
async function findMintForHolding(holding: ActiveHolding): Promise<MintInfo | null> {
  const jwt = await getLedgerJwt();
  const warpxParty = NETWORK.warpxPartyId;

  // We already know the create offset from the ACS entry. Fetch just that one
  // transaction and inspect its events.
  const off = holding.createOffset;
  const res = await fetch(`${NETWORK.ledgerHost}/v2/updates`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({
      beginExclusive: off - 1,
      endInclusive: off,
      filter: {
        filtersByParty: {
          [warpxParty]: {
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
      verbose: true,
    }),
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "<no body>");
    throw new Error(`findMintForHolding updates failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as unknown[];
  const txn = data
    .map((i) => (i as { update?: { Transaction?: { value?: LedgerTransaction } } }).update?.Transaction?.value)
    .find(Boolean);
  if (!txn) return null;

  const archivedDA = txn.events.find(
    (e) => e.ArchivedEvent?.templateId?.includes(DEPOSIT_ACCOUNT_TEMPLATE),
  )?.ArchivedEvent;

  // Not a mint — its creating txn didn't archive a deposit account (it's change
  // from a transfer, or some other non-mint operation). Leave it alone.
  if (!archivedDA) return null;

  const createdDA = txn.events.find(
    (e) => e.CreatedEvent?.templateId?.includes(DEPOSIT_ACCOUNT_TEMPLATE),
  )?.CreatedEvent;
  const rolledForwardDaOriginalId =
    (createdDA?.createArgument as { id?: string } | undefined)?.id ?? null;

  return {
    archivedDepositAccountCid: archivedDA.contractId,
    rolledForwardDaOriginalId,
    createOffset: off,
  };
}

// ---------- transfer helper ----------

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

/**
 * Phase 1: sender exercises TransferFactory_Transfer to create a TransferInstruction
 * (the offer). Uses the interface-style templateId so we don't need the concrete
 * AllocationFactory DAR on the node.
 *
 * Returns the contractId of the created TransferInstruction.
 */
async function createTransferOffer(
  holdingContractId: string,
  holdingCreatedEventBlob: string,
  amount: string,
  fromParty: string,
  toParty: string,
): Promise<{ offerCid: string; updateId: string | null }> {
  const jwt = await getLedgerJwt();
  const now = new Date().toISOString();
  const executeBefore = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  // Step 1: fetch TransferFactory from registry API
  const registryUrl = `${NETWORK.registryUrl}/api/token-standard/v0/registrars/${NETWORK.decentralizedPartyId}/registry/transfer-instruction/v1/transfer-factory`;
  console.log(`${TAG} fetching TransferFactory from registry`);

  const factoryRes = await fetch(registryUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      choiceArguments: {
        expectedAdmin: NETWORK.decentralizedPartyId,
        transfer: {
          sender: fromParty,
          receiver: toParty,
          amount,
          instrumentId: { admin: NETWORK.decentralizedPartyId, id: "CBTC" },
          lock: null,
          requestedAt: now,
          executeBefore,
          inputHoldingCids: [holdingContractId],
          meta: { values: {} },
        },
        extraArgs: { context: { values: {} }, meta: { values: {} } },
      },
    }),
    cache: "no-store",
  });

  if (!factoryRes.ok) {
    const text = await factoryRes.text().catch(() => "<no body>");
    throw new Error(`fetch TransferFactory failed (${factoryRes.status}): ${text}`);
  }

  const factory = (await factoryRes.json()) as TransferFactoryResponse;
  console.log(
    `${TAG} TransferFactory factoryId=${factory.factoryId.slice(0, 20)}... transferKind=${factory.transferKind}`,
  );

  // Step 2: exercise TransferFactory_Transfer via the interface templateId
  const commandId = crypto.randomUUID();
  const disclosedContracts: DisclosedContract[] = [
    ...factory.choiceContext.disclosedContracts.map((dc) => ({
      ...dc,
      synchronizerId: dc.synchronizerId ?? "",
    })),
    // The holding itself — must use the concrete package-hash templateId
    // (the # interface form is rejected here).
    {
      templateId: HOLDING_TEMPLATE_FQN,
      contractId: holdingContractId,
      createdEventBlob: holdingCreatedEventBlob,
      synchronizerId: "",
    },
  ];

  const submitRes = await fetch(
    `${NETWORK.ledgerHost}/v2/commands/submit-and-wait-for-transaction-tree`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({
        applicationId: "cbtc-app",
        workflowId: `cbtc-mint-transfer-${commandId}`,
        commandId,
        actAs: [fromParty],
        readAs: [fromParty],
        commands: [
          {
            ExerciseCommand: {
              templateId: TRANSFER_FACTORY_INTERFACE,
              contractId: factory.factoryId,
              choice: "TransferFactory_Transfer",
              choiceArgument: {
                expectedAdmin: NETWORK.decentralizedPartyId,
                transfer: {
                  sender: fromParty,
                  receiver: toParty,
                  amount,
                  instrumentId: { admin: NETWORK.decentralizedPartyId, id: "CBTC" },
                  lock: null,
                  requestedAt: now,
                  executeBefore,
                  inputHoldingCids: [holdingContractId],
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
        disclosedContracts,
      }),
      cache: "no-store",
    },
  );

  if (!submitRes.ok) {
    const text = await submitRes.text().catch(() => "<no body>");
    throw new Error(`Phase 1 (TransferFactory_Transfer) submit failed (${submitRes.status}): ${text}`);
  }

  const submitJson = (await submitRes.json()) as {
    transactionTree?: {
      updateId?: string;
      eventsById?: Record<string, unknown>;
    };
  };
  const updateId = submitJson.transactionTree?.updateId;
  console.log(`${TAG} ✅ Phase 1 done updateId=${updateId?.slice(0, 20)}...`);

  // Step 3: extract the created TransferOffer/TransferInstruction contractId
  // DIRECTLY from the transaction tree response. This is race-free — the
  // contract is in the very response of the command that created it, so we
  // never depend on the ACS index catching up. (The old code queried the ACS
  // separately, which raced and sometimes returned nothing → "no offer found"
  // → the mint was marked failed and a retry created a DUPLICATE offer.)
  let offerCid = extractCreatedOfferCid(submitJson.transactionTree?.eventsById);

  // Fallback: if the tree shape was unexpected and extraction missed the
  // contract, fall back to the (retrying) ACS lookup so we still find the
  // offer we just created rather than throwing — throwing would mark the mint
  // failed and a retry would risk a duplicate. The ACS lookup is keyed on the
  // input holding so it only matches THIS offer.
  if (!offerCid) {
    console.warn(`${TAG} tree extraction missed offer CID — falling back to ACS lookup`);
    offerCid = await findNewTransferOfferForReceiver(toParty, holdingContractId);
  }

  if (!offerCid) {
    throw new Error(
      `Phase 1 succeeded (updateId=${updateId?.slice(0, 20)}...) but no ` +
      `TransferOffer/TransferInstruction found (tree + ACS fallback both empty)`,
    );
  }
  return { offerCid, updateId: updateId ?? null };
}

/**
 * Find the TransferOffer that was just created for the receiver, where the
 * inputHoldingCids include our source holding. The m2m JWT can read as the
 * receiver party (it's a node-managed party).
 *
 * Retries with backoff because `submit-and-wait-for-transaction-tree` returns
 * once the transaction is sequenced, but the ACS index can lag by a few
 * hundred ms. A single ACS query right after submit will sometimes miss the
 * newly-created contract.
 */
async function findNewTransferOfferForReceiver(
  receiverParty: string,
  sourceHoldingCid: string,
): Promise<string | null> {
  const RETRY_DELAYS_MS = [0, 500, 1000, 2000, 3000];

  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
    if (RETRY_DELAYS_MS[attempt] > 0) {
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
    }

    const jwt = await getLedgerJwt();
    const endRes = await fetch(`${NETWORK.ledgerHost}/v2/state/ledger-end`, {
      headers: { Authorization: `Bearer ${jwt}` },
      cache: "no-store",
    });
    const { offset } = (await endRes.json()) as { offset: number };

    const acsRes = await fetch(`${NETWORK.ledgerHost}/v2/state/active-contracts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({
        filter: {
          filtersByParty: {
            [receiverParty]: {
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

    if (!acsRes.ok) continue;
    const items = (await acsRes.json()) as Array<{
      contractEntry?: {
        JsActiveContract?: {
          createdEvent?: {
            contractId: string;
            templateId: string;
            createArgument?: { transfer?: { inputHoldingCids?: string[] } };
          };
        };
      };
    }>;

    for (const item of items) {
      const ev = item.contractEntry?.JsActiveContract?.createdEvent;
      if (!ev) continue;
      if (!ev.templateId.includes("TransferOffer") && !ev.templateId.includes("TransferInstruction")) continue;
      const inputCids = ev.createArgument?.transfer?.inputHoldingCids ?? [];
      if (inputCids.includes(sourceHoldingCid)) {
        console.log(`${TAG} found offer on attempt ${attempt + 1}: ${ev.contractId.slice(0, 20)}...`);
        return ev.contractId;
      }
    }
  }
  return null;
}

/**
 * Phase 2: receiver accepts the TransferInstruction. After this the cBTC is
 * unlocked and owned by the receiver party.
 */
async function acceptTransferOffer(
  offerContractId: string,
  receiverParty: string,
): Promise<void> {
  const jwt = await getLedgerJwt();

  // Fetch accept choice context from the registry API
  const ctxUrl = `${NETWORK.registryUrl}/api/token-standard/v0/registrars/${NETWORK.decentralizedPartyId}/registry/transfer-instruction/v1/${offerContractId}/choice-contexts/accept`;
  const ctxRes = await fetch(ctxUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ meta: {} }),
    cache: "no-store",
  });
  if (!ctxRes.ok) {
    const text = await ctxRes.text().catch(() => "<no body>");
    throw new Error(`fetch accept choice context failed (${ctxRes.status}): ${text}`);
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
        workflowId: `cbtc-mint-accept-${commandId}`,
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
    throw new Error(`Phase 2 (TransferInstruction_Accept) submit failed (${submitRes.status}): ${text}`);
  }
  console.log(`${TAG} ✅ Phase 2 (accept) done offerCid=${offerContractId.slice(0, 20)}...`);
}

/**
 * Two-phase transfer warpx → user, with the created offer persisted between
 * phases so a crash/retry can never create a duplicate offer.
 *
 * @param existingOfferCid  If the DB already recorded an offer_contract_id for
 *   this mint, pass it here — Phase 1 is skipped entirely and we go straight
 *   to accept. This is the duplicate-offer guard: once an offer exists, we
 *   NEVER create another.
 * @param persistOffer  Callback invoked with the newly-created offer CID + the
 *   Phase-1 updateId, BEFORE Phase 2 runs. The caller persists it to the DB
 *   (status='offer_created') so a subsequent retry takes the skip-Phase-1 path.
 */
async function transferHoldingToUser(params: {
  holdingContractId: string;
  holdingCreatedEventBlob: string;
  amount: string;
  fromParty: string;
  toParty: string;
  existingOfferCid: string | null;
  persistOffer: (offerCid: string, updateId: string | null) => Promise<void>;
}): Promise<void> {
  const {
    holdingContractId,
    holdingCreatedEventBlob,
    amount,
    fromParty,
    toParty,
    existingOfferCid,
    persistOffer,
  } = params;

  console.log(
    `${TAG} transferHoldingToUser amount=${amount} from=${fromParty.slice(0, 20)}... to=${toParty.slice(0, 20)}...`,
  );

  // Duplicate-offer guard #1 (authoritative): the DB already has an offer for
  // this mint. Skip Phase 1 — accept the recorded offer. No new offer created.
  if (existingOfferCid) {
    console.log(`${TAG} DB has offer ${existingOfferCid.slice(0, 20)}... skipping Phase 1, accepting`);
    await acceptTransferOffer(existingOfferCid, toParty);
    return;
  }

  // Phase 1: create offer. The CID comes straight from the transaction tree
  // (race-free). Persist it BEFORE accepting so a crash between phases leaves a
  // recoverable 'offer_created' row instead of orphaning the offer.
  const { offerCid, updateId } = await createTransferOffer(
    holdingContractId,
    holdingCreatedEventBlob,
    amount,
    fromParty,
    toParty,
  );
  await persistOffer(offerCid, updateId);

  // Phase 2: accept on behalf of receiver (m2m JWT has authority).
  await acceptTransferOffer(offerCid, toParty);
}

// ---------- main processor ----------

export async function processMintTransfers(): Promise<MintProcessorResult> {
  const supabase = await createSupabaseServiceClient();

  // ── Global lease lock: serialize the entire processor per network. ──
  // Two triggers can fire this concurrently (frontend poll + cron). Without a
  // lock, both scan the same offset window and both create offers → duplicates.
  // This is a LEASE (single atomic UPDATE), not a pg advisory lock — advisory
  // locks are session-scoped and don't survive across separate PostgREST RPC
  // calls. The lease auto-expires so a crashed run can't deadlock the system.
  // (The per-holding claim_mint_transfer RPC is the second, authoritative
  // guard against duplicate offers even if two runs somehow overlap.)
  const LEASE_SECONDS = 300;
  const { data: lockAcquired, error: lockErr } = await supabase.rpc(
    "try_lock_mint_processor",
    { p_network: NETWORK.name, p_lease_seconds: LEASE_SECONDS },
  );
  if (lockErr) {
    console.error(`${TAG} could not acquire lease RPC:`, lockErr);
    throw new Error(`lease RPC failed: ${lockErr.message}`);
  }
  if (!lockAcquired) {
    console.log(`${TAG} another run holds the lease — skipping this invocation`);
    return {
      processedOffset: 0,
      transactionsScanned: 0,
      mintsFound: 0,
      transferred: 0,
      failed: 0,
      skipped: 0,
      errors: ["already running (lease held)"],
    };
  }

  try {
    return await runProcessorLocked(supabase);
  } finally {
    // Always release the lease, even on error. (It also auto-expires.)
    const { error: unlockErr } = await supabase.rpc("unlock_mint_processor", {
      p_network: NETWORK.name,
    });
    if (unlockErr) console.error(`${TAG} lease release failed:`, unlockErr);
  }
}

/**
 * The actual processing body. Runs only while the global lease lock is held.
 *
 * HOLDING-BASED design (offset-independent):
 *   1. The to-do list = all active cBTC Holdings owned by warpx (ACS query).
 *      A holding on warpx = unfinished work; once transferred it's archived and
 *      leaves the list. Nothing can be stranded by a moving cursor.
 *   2. For each holding, classify it: is its creating transaction a MINT (it
 *      archived a DepositAccount)? Non-mints (transfer change, etc.) are left
 *      alone.
 *   3. Resolve the owning user, claim the row, and run the (hardened) two-phase
 *      transfer with offer-persist + dedup guards.
 */
async function runProcessorLocked(
  supabase: Awaited<ReturnType<typeof createSupabaseServiceClient>>,
): Promise<MintProcessorResult> {
  const result: MintProcessorResult = {
    processedOffset: 0,
    transactionsScanned: 0,
    mintsFound: 0,
    transferred: 0,
    failed: 0,
    skipped: 0,
    errors: [],
  };

  const warpxParty = NETWORK.warpxPartyId;

  // Step 1: the to-do list — active warpx holdings (offset-independent).
  const holdings = await getActiveWarpxHoldings();
  result.transactionsScanned = holdings.length; // (reused field: # holdings inspected)
  console.log(`${TAG} ${holdings.length} active holding(s) on warpx`);

  for (const holding of holdings) {
    const holdingContractId = holding.contractId;
    const amount = holding.amount;
    const holdingBlob = holding.createdEventBlob;

    // Guard: zero/missing amount means the ACS shape is wrong — skip loudly.
    if (!amount || amount === "0") {
      console.error(`${TAG} skipping holding with zero/missing amount: ${holdingContractId.slice(0, 20)}...`);
      result.errors.push(`amount zero/missing for holding ${holdingContractId.slice(0, 20)}`);
      continue;
    }

    // Step 2: dedup — if this holding was already transferred, skip. (A
    // transferred holding shouldn't still be on warpx, but this is belt-and-
    // suspenders against ACS lag right after a transfer.)
    const { data: existing } = await supabase
      .from("mint_transfers")
      .select("id, status, offer_contract_id")
      .eq("holding_contract_id", holdingContractId)
      .maybeSingle();

    if (existing?.status === "transferred") {
      console.log(`${TAG} holding ${holdingContractId.slice(0, 20)}... already transferred — skipping`);
      result.skipped++;
      continue;
    }
    const recordedOfferCid = existing?.offer_contract_id ?? null;

    // Step 3: classify — is this holding a MINT? (Its creating txn archived a
    // DepositAccount.) Non-mints (transfer change, etc.) are left untouched.
    let mint: MintInfo | null;
    try {
      mint = await findMintForHolding(holding);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${TAG} classify failed for ${holdingContractId.slice(0, 20)}...:`, msg);
      result.errors.push(`classify failed for ${holdingContractId.slice(0, 20)}: ${msg}`);
      continue;
    }
    if (!mint) {
      // Not a mint — leave it alone (don't even count it as a mint).
      console.log(`${TAG} holding ${holdingContractId.slice(0, 20)}... is not a mint (no archived DepositAccount) — leaving`);
      result.skipped++;
      continue;
    }

    result.mintsFound++;
    const depositAccountContractId = mint.archivedDepositAccountCid;
    console.log(`${TAG} MINT holding=${holdingContractId.slice(0, 20)}... da=${depositAccountContractId.slice(0, 20)}... amount=${amount}`);

    // Step 4: resolve user. Match by archived DA cid OR the rolled-forward DA
    // `id` (subsequent mints to the same address), with a coordinator fallback.
    let userId: string | null = null;
    let cantonPartyId: string | null = null;
    let bitcoinAddress: string | null = null;

    const candidateDaIds = [depositAccountContractId];
    if (mint.rolledForwardDaOriginalId && mint.rolledForwardDaOriginalId !== depositAccountContractId) {
      candidateDaIds.push(mint.rolledForwardDaOriginalId);
    }

    const { data: depositRow } = await supabase
      .from("deposit_accounts")
      .select("user_id, canton_party_id, bitcoin_address")
      .in("deposit_account_contract_id", candidateDaIds)
      .maybeSingle();

    if (depositRow) {
      userId = depositRow.user_id;
      cantonPartyId = depositRow.canton_party_id;
      bitcoinAddress = depositRow.bitcoin_address;
      console.log(`${TAG} resolved user=${userId} party=${cantonPartyId?.slice(0, 30)}...`);
    } else {
      console.warn(`${TAG} deposit account not in Supabase, trying coordinator fallback...`);
      try {
        bitcoinAddress = await getBitcoinAddress(depositAccountContractId);
        const { data: addrRow } = await supabase
          .from("deposit_accounts")
          .select("user_id, canton_party_id")
          .eq("bitcoin_address", bitcoinAddress)
          .single();
        if (addrRow) {
          userId = addrRow.user_id;
          cantonPartyId = addrRow.canton_party_id;
          console.log(`${TAG} resolved via bitcoin_address fallback user=${userId}`);
        }
      } catch (fallbackErr) {
        console.error(`${TAG} coordinator fallback failed:`, fallbackErr);
      }
    }

    // Step 5: upsert the row (preserving any recorded offer_contract_id).
    await supabase.from("mint_transfers").upsert(
      {
        network: NETWORK.name,
        ledger_offset: mint.createOffset,
        holding_contract_id: holdingContractId,
        deposit_account_contract_id: depositAccountContractId,
        bitcoin_address: bitcoinAddress,
        user_id: userId,
        canton_party_id: cantonPartyId,
        amount,
        status: "pending",
        error: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "holding_contract_id" },
    );

    if (!cantonPartyId) {
      const errMsg = `Could not resolve user for depositAccountContractId=${depositAccountContractId}`;
      console.error(`${TAG} ${errMsg}`);
      await supabase.from("mint_transfers")
        .update({ status: "failed", error: errMsg, updated_at: new Date().toISOString() })
        .eq("holding_contract_id", holdingContractId);
      result.failed++;
      result.errors.push(errMsg);
      // No cursor to worry about — the holding stays on warpx and is re-seen
      // next run automatically once the deposit_account row exists.
      continue;
    }

    // Step 6: atomically claim the row (pending/failed/offer_created →
    // processing). If owned elsewhere, skip — the holding stays on warpx and
    // is re-seen next run.
    const { data: claimedId, error: claimErr } = await supabase.rpc(
      "claim_mint_transfer",
      { p_holding_contract_id: holdingContractId },
    );
    if (claimErr) {
      console.error(`${TAG} claim RPC failed:`, claimErr);
      result.errors.push(`claim failed for ${holdingContractId.slice(0, 20)}: ${claimErr.message}`);
      continue;
    }
    if (!claimedId) {
      console.log(`${TAG} could not claim ${holdingContractId.slice(0, 20)}... (owned elsewhere) — skipping`);
      result.skipped++;
      continue;
    }

    // Step 7: transfer. Offer CID is persisted BEFORE accept; on retry an
    // already-recorded offer is accepted, never recreated.
    try {
      await transferHoldingToUser({
        holdingContractId,
        holdingCreatedEventBlob: holdingBlob,
        amount,
        fromParty: warpxParty,
        toParty: cantonPartyId,
        existingOfferCid: recordedOfferCid,
        persistOffer: async (offerCid, updateId) => {
          await supabase.from("mint_transfers")
            .update({
              status: "offer_created",
              offer_contract_id: offerCid,
              offer_update_id: updateId,
              updated_at: new Date().toISOString(),
            })
            .eq("holding_contract_id", holdingContractId);
        },
      });
      await supabase.from("mint_transfers")
        .update({ status: "transferred", error: null, updated_at: new Date().toISOString() })
        .eq("holding_contract_id", holdingContractId);
      result.transferred++;
      console.log(`${TAG} ✅ transferred ${amount} cBTC to ${cantonPartyId.slice(0, 30)}...`);
    } catch (transferErr) {
      const errMsg = transferErr instanceof Error ? transferErr.message : String(transferErr);
      console.error(`${TAG} transfer failed:`, errMsg);
      await supabase.from("mint_transfers")
        .update({ status: "failed", error: errMsg, updated_at: new Date().toISOString() })
        .eq("holding_contract_id", holdingContractId);
      result.failed++;
      result.errors.push(errMsg);
      // Holding stays on warpx → re-seen and retried next run. No stranding.
    }
  }

  // No cursor to advance — the warpx ACS is the source of truth. We keep the
  // ledger-end in processedOffset purely for observability.
  result.processedOffset = await getLedgerEnd();

  console.log(
    `${TAG} done — holdingsInspected=${result.transactionsScanned} mints=${result.mintsFound} ` +
    `transferred=${result.transferred} failed=${result.failed} skipped=${result.skipped}`,
  );
  return result;
}
