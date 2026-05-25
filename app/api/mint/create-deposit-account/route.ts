/**
 * POST /api/mint/create-deposit-account
 *
 * Server-side handler for creating a CBTCDepositAccount.
 * Must be server-side: calls getLedgerJwt() — m2m secret never exposed to browser.
 *
 * Body: { partyId: string }
 * Response: { contractId: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";

import { getLedgerJwt, invalidateLedgerJwtCache } from "@/lib/auth";
import { getAccountContractRules } from "@/lib/bitsafe";
import { NETWORK } from "@/lib/constants";

const APPLICATION_ID = "cbtc-app";


// Template ID for the Utility Credential contract issued by BitSafe.
// Package hash is derived from the credentialBlob; template path is stable across versions.
const CREDENTIAL_TEMPLATE_ID =
  "5a29ead611a0abd5f5b3fc3caf7d0f67c0ff802032ab6d392824aa9060e56d70:Utility.Credential.V0.Credential:Credential";

const CREATE_DEPOSIT_ACCOUNT_CHOICE =
  "CBTCDepositAccountRules_CreateDepositAccount";

const TAG = "[mint/create-deposit-account]";

export async function POST(req: NextRequest) {
  console.log(`${TAG} request received`);

  try {
    const { partyId } = await req.json() as { partyId?: string };

    if (!partyId) {
      console.error(`${TAG} missing partyId in request body`);
      return NextResponse.json({ error: "partyId required" }, { status: 400 });
    }

    // All signing uses the WarpX-hosted party — m2m JWT has authority over it
    // and cBTC DARs are vetted on the WarpX node. Owner is also WarpX party
    // (Canton requires owner to be in actAs, and the m2m JWT only covers WarpX).
    const warpxParty = NETWORK.warpxPartyId;
    if (!warpxParty) {
      console.error(`${TAG} no warpxPartyId configured for network=${NETWORK.name}`);
      return NextResponse.json({ error: `No WarpX party configured for ${NETWORK.name}` }, { status: 500 });
    }

    const credentialCid = NETWORK.credentialCid;
    if (!credentialCid) {
      console.error(`${TAG} no credentialCid configured for network=${NETWORK.name}`);
      return NextResponse.json({ error: `No minter credential configured for ${NETWORK.name}` }, { status: 500 });
    }

    const credentialBlob = NETWORK.credentialBlob;
    if (!credentialBlob) {
      console.error(`${TAG} no credentialBlob configured for network=${NETWORK.name}`);
      return NextResponse.json({ error: `No minter credential blob configured for ${NETWORK.name}` }, { status: 500 });
    }

    console.log(`${TAG} partyId (caller)=${partyId.slice(0, 30)}...`);
    console.log(`${TAG} warpxParty (actAs)=${warpxParty.slice(0, 30)}...`);
    console.log(`${TAG} credentialCid=${credentialCid.slice(0, 30)}...`);
    console.log(`${TAG} credentialBlob length=${credentialBlob.length}`);
    console.log(`${TAG} network=${NETWORK.name} ledgerHost=${NETWORK.ledgerHost}`);
    console.log(`${TAG} coordinatorUrl=${NETWORK.coordinatorUrl}`);

    // Step 1: fetch da_rules from coordinator
    console.log(`${TAG} fetching account contract rules from coordinator...`);
    const rules = await getAccountContractRules();
    console.log(`${TAG} da_rules contractId=${rules.da_rules.contract_id}`);
    console.log(`${TAG} da_rules templateId=${rules.da_rules.template_id}`);
    console.log(`${TAG} da_rules createdEventBlob length=${rules.da_rules.created_event_blob?.length ?? 0}`);

    // Step 2: get JWT
    console.log(`${TAG} fetching JWT from Authentik...`);
    let jwt = await getLedgerJwt();
    console.log(`${TAG} JWT obtained, length=${jwt.length}`);

    const buildBody = (commandId: string) => ({
      applicationId: APPLICATION_ID,
      workflowId: `cbtc-mint-${commandId}`,
      commandId,
      // actAs + readAs: WarpX party only — m2m JWT has authority only over this party.
      // owner must also be in actAs (Canton requires owner authorization).
      // Since we can't put the Loop wallet party in actAs (m2m JWT has no authority over it),
      // the WarpX party is the owner. cBTC lands on the WarpX party and can be
      // transferred to the user's Loop party in a subsequent step.
      actAs: [warpxParty],
      readAs: [warpxParty],
      commands: [
        {
          ExerciseCommand: {
            // Use templateId from coordinator response — it has the correct package hash.
            templateId: rules.da_rules.template_id,
            contractId: rules.da_rules.contract_id,
            choice: CREATE_DEPOSIT_ACCOUNT_CHOICE,
            // credentialCids is NOT a field in this choice — credential is validated
            // via the disclosedContracts entry, not as a choiceArgument field.
            choiceArgument: {
              owner: warpxParty,
            },
          },
        },
      ],
      disclosedContracts: [
        {
          // templateId must match what's encoded in the blob — use coordinator value directly.
          templateId: rules.da_rules.template_id,
          contractId: rules.da_rules.contract_id,
          createdEventBlob: rules.da_rules.created_event_blob,
          synchronizerId: "",
        },
        // Credential contract lives on BitSafe's node — must be disclosed so
        // our WarpX node can validate credentialCids in CreateDepositAccount.
        {
          templateId: CREDENTIAL_TEMPLATE_ID,
          contractId: credentialCid,
          createdEventBlob: credentialBlob,
          synchronizerId: "",
        },
      ],
    });

    const url = `${NETWORK.ledgerHost}/v2/commands/submit-and-wait-for-transaction-tree`;
    let commandId = randomUUID();

    console.log(`${TAG} submitting CreateDepositAccount to ledger...`);
    console.log(`${TAG} POST ${url}`);
    console.log(`${TAG} commandId=${commandId}`);

    let res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
      body: JSON.stringify(buildBody(commandId)),
      cache: "no-store",
    });

    console.log(`${TAG} ledger response status=${res.status}`);

    // 401: JWT expired — invalidate cache, refresh, retry once
    if (res.status === 401) {
      console.warn(`${TAG} 401 from ledger — invalidating JWT cache and retrying...`);
      invalidateLedgerJwtCache();
      jwt = await getLedgerJwt();
      commandId = randomUUID();
      console.log(`${TAG} retrying with fresh JWT, commandId=${commandId}`);
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
        body: JSON.stringify(buildBody(commandId)),
        cache: "no-store",
      });
      console.log(`${TAG} retry response status=${res.status}`);
    }

    // 409: deduplication conflict — retry with new commandId (JWT already fresh)
    if (res.status === 409) {
      console.warn(`${TAG} 409 conflict — retrying with new commandId...`);
      commandId = randomUUID();
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
        body: JSON.stringify(buildBody(commandId)),
        cache: "no-store",
      });
      console.log(`${TAG} conflict retry response status=${res.status}`);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "<no body>");
      console.error(`${TAG} ledger error status=${res.status} body=${text}`);

      if (res.status === 404 && text.includes("unknown template")) {
        return NextResponse.json(
          { error: "Node configuration required: cBTC DARs not uploaded to node. Contact support." },
          { status: 502 },
        );
      }
      return NextResponse.json({ error: `Ledger error (${res.status}): ${text}` }, { status: 502 });
    }

    const data = await res.json();
    console.log(`${TAG} raw tx response keys=${Object.keys(data as object).join(",")}`);

    const contractId = extractDepositAccountContractId(data);
    if (!contractId) {
      console.error(`${TAG} could not extract contractId from response:`, JSON.stringify(data).slice(0, 1000));
      return NextResponse.json(
        { error: "Deposit account created but contract ID not found in transaction response." },
        { status: 502 },
      );
    }

    console.log(`${TAG} success! depositAccount contractId=${contractId}`);
    return NextResponse.json({ contractId });

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${TAG} unexpected error:`, err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function extractDepositAccountContractId(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;

  // Primary shape per BitSafe docs: response.transaction.eventsById[key].created.contractId
  const txn = (data as { transaction?: { eventsById?: Record<string, unknown> } }).transaction;
  if (txn?.eventsById) {
    for (const ev of Object.values(txn.eventsById)) {
      const created = (ev as { created?: { contractId?: string; templateId?: string } }).created;
      if (created?.contractId && created.templateId?.includes("CBTCDepositAccount")) {
        console.log(`[mint/create-deposit-account] found contractId via transaction.eventsById (template match)`);
        return created.contractId;
      }
    }
    for (const ev of Object.values(txn.eventsById)) {
      const created = (ev as { created?: { contractId?: string } }).created;
      if (created?.contractId) {
        console.log(`[mint/create-deposit-account] found contractId via transaction.eventsById (first created)`);
        return created.contractId;
      }
    }
  }

  // Actual Canton v2 response shape: transactionTree.eventsById[key].CreatedTreeEvent.value
  // (not CreatedEvent directly on the event — that's an older/different shape)
  const tree = (data as { transactionTree?: { eventsById?: Record<string, unknown> } }).transactionTree;
  if (tree?.eventsById) {
    // Pass 1: template match on CBTCDepositAccount (exclude the Rules contract)
    for (const ev of Object.values(tree.eventsById)) {
      const val =
        (ev as { CreatedTreeEvent?: { value?: { contractId?: string; templateId?: string } } }).CreatedTreeEvent?.value ??
        (ev as { CreatedEvent?: { contractId?: string; templateId?: string } }).CreatedEvent;
      if (val?.contractId && val.templateId?.includes("CBTCDepositAccount") && !val.templateId.includes("Rules")) {
        console.log(`[mint/create-deposit-account] found contractId via CreatedTreeEvent.value (template match)`);
        return val.contractId;
      }
    }
    // Pass 2: first CreatedTreeEvent (fallback)
    for (const ev of Object.values(tree.eventsById)) {
      const val =
        (ev as { CreatedTreeEvent?: { value?: { contractId?: string; templateId?: string } } }).CreatedTreeEvent?.value ??
        (ev as { CreatedEvent?: { contractId?: string } }).CreatedEvent;
      if (val?.contractId) {
        console.log(`[mint/create-deposit-account] found contractId via CreatedTreeEvent.value (first created)`);
        return val.contractId;
      }
    }
    // Pass 3: exerciseResult.depositAccountCid from ExercisedTreeEvent (belt-and-suspenders)
    for (const ev of Object.values(tree.eventsById)) {
      const exercised = (ev as { ExercisedTreeEvent?: { value?: { exerciseResult?: { depositAccountCid?: string } } } }).ExercisedTreeEvent?.value;
      if (exercised?.exerciseResult?.depositAccountCid) {
        console.log(`[mint/create-deposit-account] found contractId via ExercisedTreeEvent.exerciseResult.depositAccountCid`);
        return exercised.exerciseResult.depositAccountCid;
      }
    }
  }

  return null;
}
