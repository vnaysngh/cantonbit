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
import { createSupabaseServiceClient } from "./supabase/server";

const TAG = "[mint-processor]";

const HOLDING_TEMPLATE = "Utility.Registry.Holding.V0.Holding:Holding";
const DEPOSIT_ACCOUNT_TEMPLATE = "CBTC.DepositAccount:CBTCDepositAccount";

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

async function getUpdates(fromExclusive: number, toInclusive: number): Promise<LedgerTransaction[]> {
  const jwt = await getLedgerJwt();
  const warpxParty = NETWORK.warpxPartyId;

  console.log(`${TAG} getUpdates fromExclusive=${fromExclusive} toInclusive=${toInclusive}`);

  const res = await fetch(`${NETWORK.ledgerHost}/v2/updates`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({
      beginExclusive: fromExclusive,
      endInclusive: toInclusive,
      filter: {
        filtersByParty: {
          [warpxParty]: {
            cumulative: [{
              identifierFilter: {
                WildcardFilter: { value: { includeCreatedEventBlob: true } },
              },
            }],
          },
        },
      },
      verbose: true,
    }),
    cache: "no-store",
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "<no body>");
    throw new Error(`getUpdates failed (${res.status}): ${text}`);
  }

  const data = await res.json() as unknown[];
  console.log(`${TAG} getUpdates returned ${data.length} updates`);

  const txns: LedgerTransaction[] = [];
  for (const item of data) {
    const txn = (item as { update?: { Transaction?: { value?: LedgerTransaction } } }).update?.Transaction?.value;
    if (txn) txns.push(txn);
  }
  return txns;
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

async function transferHoldingToUser(
  holdingContractId: string,
  holdingCreatedEventBlob: string,
  amount: string,
  fromParty: string,
  toParty: string,
): Promise<void> {
  const jwt = await getLedgerJwt();
  const now = new Date().toISOString();
  const executeBefore = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  // Step 1: fetch TransferFactory from registry API
  const registryUrl = `${NETWORK.registryUrl}/api/token-standard/v0/registrars/${NETWORK.decentralizedPartyId}/registry/transfer-instruction/v1/transfer-factory`;
  console.log(`${TAG} fetching TransferFactory from registry: ${registryUrl}`);

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
          instrumentId: {
            admin: NETWORK.decentralizedPartyId,
            id: "CBTC",
          },
          lock: null,
          requestedAt: now,
          executeBefore,
          inputHoldingCids: [holdingContractId],
          meta: { values: {} },
        },
        extraArgs: {
          context: { values: {} },
          meta: { values: {} },
        },
      },
    }),
    cache: "no-store",
  });

  if (!factoryRes.ok) {
    const text = await factoryRes.text().catch(() => "<no body>");
    throw new Error(`fetch TransferFactory failed (${factoryRes.status}): ${text}`);
  }

  const factory = await factoryRes.json() as TransferFactoryResponse;
  console.log(`${TAG} TransferFactory factoryId=${factory.factoryId.slice(0, 20)}... transferKind=${factory.transferKind}`);

  // Step 2: exercise TransferFactory_Transfer on the ledger
  const commandId = crypto.randomUUID();
  const disclosedContracts: DisclosedContract[] = [
    // Factory's own disclosed contracts (instrument config etc.)
    ...factory.choiceContext.disclosedContracts.map((dc) => ({
      ...dc,
      synchronizerId: dc.synchronizerId ?? "",
    })),
    // The holding itself
    {
      templateId: HOLDING_TEMPLATE,
      contractId: holdingContractId,
      createdEventBlob: holdingCreatedEventBlob,
      synchronizerId: "",
    },
  ];

  const submitRes = await fetch(`${NETWORK.ledgerHost}/v2/commands/submit-and-wait-for-transaction-tree`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({
      applicationId: "cbtc-app",
      workflowId: `cbtc-autotransfer-${commandId}`,
      commandId,
      actAs: [fromParty],
      readAs: [fromParty],
      commands: [{
        ExerciseCommand: {
          templateId: "82798df018301852704f210b97adaabf76d3ecd37d889e1bf96b5f31a20eea34:Utility.Registry.App.V0.Service.AllocationFactory:AllocationFactory",
          contractId: factory.factoryId,
          choice: "AllocationFactory_Transfer",
          choiceArgument: {
            transfer: {
              sender: fromParty,
              receiver: toParty,
              amount,
              instrumentId: {
                admin: NETWORK.decentralizedPartyId,
                id: "CBTC",
              },
              lock: null,
              requestedAt: now,
              executeBefore,
              inputHoldingCids: [holdingContractId],
              meta: { values: {} },
            },
            context: factory.choiceContext.choiceContextData,
            meta: { values: {} },
          },
        },
      }],
      disclosedContracts,
    }),
    cache: "no-store",
  });

  if (!submitRes.ok) {
    const text = await submitRes.text().catch(() => "<no body>");
    throw new Error(`transfer submit failed (${submitRes.status}): ${text}`);
  }

  console.log(`${TAG} ✅ transfer submitted holdingContractId=${holdingContractId.slice(0, 20)}...`);
}

// ---------- main processor ----------

export async function processMintTransfers(): Promise<MintProcessorResult> {
  const result: MintProcessorResult = {
    processedOffset: 0,
    transactionsScanned: 0,
    mintsFound: 0,
    transferred: 0,
    failed: 0,
    skipped: 0,
    errors: [],
  };

  const supabase = await createSupabaseServiceClient();
  const warpxParty = NETWORK.warpxPartyId;

  // Step 1: get last processed offset
  const { data: stateRow } = await supabase
    .from("mint_processor_state")
    .select("last_processed_offset")
    .eq("network", NETWORK.name)
    .single();

  const ledgerEnd = await getLedgerEnd();
  result.processedOffset = ledgerEnd;

  // If no state row, initialize to current ledger end - 1 and return
  // (don't reprocess historical transactions on first run)
  if (!stateRow) {
    console.log(`${TAG} first run — initializing offset to ${ledgerEnd}`);
    await supabase.from("mint_processor_state").upsert({
      network: NETWORK.name,
      last_processed_offset: ledgerEnd,
      updated_at: new Date().toISOString(),
    }, { onConflict: "network" });
    return result;
  }

  const fromOffset = stateRow.last_processed_offset as number;

  if (fromOffset >= ledgerEnd) {
    console.log(`${TAG} already up to date at offset=${fromOffset}`);
    return result;
  }

  console.log(`${TAG} processing offsets ${fromOffset} → ${ledgerEnd}`);

  // Step 2: fetch updates
  const transactions = await getUpdates(fromOffset, ledgerEnd);
  result.transactionsScanned = transactions.length;

  // Step 3: find mint transactions
  for (const txn of transactions) {
    // Find Holding CreatedEvent
    const holdingEvent = txn.events.find(
      (e) => e.CreatedEvent?.templateId?.includes(HOLDING_TEMPLATE)
    )?.CreatedEvent;

    if (!holdingEvent) continue;

    // Find DepositAccount ArchivedEvent in same transaction
    const archivedDepositAccount = txn.events.find(
      (e) => e.ArchivedEvent?.templateId?.includes(DEPOSIT_ACCOUNT_TEMPLATE)
    )?.ArchivedEvent;

    if (!archivedDepositAccount) continue;

    result.mintsFound++;

    const holdingContractId = holdingEvent.contractId;
    const holdingBlob = holdingEvent.createdEventBlob ?? "";
    const depositAccountContractId = archivedDepositAccount.contractId;
    const amount = (holdingEvent.createArgument?.amount as string | undefined) ?? "0";

    console.log(`${TAG} mint found holdingContractId=${holdingContractId.slice(0, 20)}... depositAccountContractId=${depositAccountContractId.slice(0, 20)}... amount=${amount}`);

    // Step 4: check if already processed (unique constraint on holding_contract_id)
    const { data: existing } = await supabase
      .from("mint_transfers")
      .select("id, status")
      .eq("holding_contract_id", holdingContractId)
      .single();

    if (existing) {
      console.log(`${TAG} already processed holdingContractId=${holdingContractId.slice(0, 20)}... status=${existing.status}`);
      result.skipped++;
      continue;
    }

    // Step 5: look up user via deposit_account_contract_id
    let userId: string | null = null;
    let cantonPartyId: string | null = null;
    let bitcoinAddress: string | null = null;

    const { data: depositRow } = await supabase
      .from("deposit_accounts")
      .select("user_id, canton_party_id, bitcoin_address")
      .eq("deposit_account_contract_id", depositAccountContractId)
      .single();

    if (depositRow) {
      userId = depositRow.user_id;
      cantonPartyId = depositRow.canton_party_id;
      bitcoinAddress = depositRow.bitcoin_address;
      console.log(`${TAG} found user via deposit_account userId=${userId} partyId=${cantonPartyId?.slice(0, 30)}...`);
    } else {
      // Fallback: resolve bitcoin address from coordinator → look up by bitcoin_address
      console.warn(`${TAG} deposit account not found in Supabase, trying coordinator fallback...`);
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
          console.log(`${TAG} found user via bitcoin_address fallback userId=${userId}`);
        }
      } catch (fallbackErr) {
        console.error(`${TAG} coordinator fallback failed:`, fallbackErr);
      }
    }

    // Step 6: insert mint_transfers row
    await supabase.from("mint_transfers").insert({
      network: NETWORK.name,
      ledger_offset: txn.offset,
      holding_contract_id: holdingContractId,
      deposit_account_contract_id: depositAccountContractId,
      bitcoin_address: bitcoinAddress,
      user_id: userId,
      canton_party_id: cantonPartyId,
      amount,
      status: "pending",
    });

    if (!cantonPartyId) {
      const errMsg = `Could not resolve user for depositAccountContractId=${depositAccountContractId}`;
      console.error(`${TAG} ${errMsg}`);
      await supabase.from("mint_transfers")
        .update({ status: "failed", error: errMsg, updated_at: new Date().toISOString() })
        .eq("holding_contract_id", holdingContractId);
      result.failed++;
      result.errors.push(errMsg);
      continue;
    }

    // Step 7: transfer holding to user party
    try {
      await transferHoldingToUser(holdingContractId, holdingBlob, amount, warpxParty, cantonPartyId);
      await supabase.from("mint_transfers")
        .update({ status: "transferred", updated_at: new Date().toISOString() })
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
    }
  }

  // Step 8: update last processed offset
  await supabase.from("mint_processor_state").upsert({
    network: NETWORK.name,
    last_processed_offset: ledgerEnd,
    updated_at: new Date().toISOString(),
  }, { onConflict: "network" });

  console.log(`${TAG} done — scanned=${result.transactionsScanned} mints=${result.mintsFound} transferred=${result.transferred} failed=${result.failed} skipped=${result.skipped}`);
  return result;
}
