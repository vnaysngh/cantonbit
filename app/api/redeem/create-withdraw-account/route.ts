/**
 * POST /api/redeem/create-withdraw-account
 *
 * Server-side handler for creating a CBTCWithdrawAccount.
 * Must be server-side: calls getLedgerJwt() — m2m secret never exposed to browser.
 *
 * Body: { partyId: string; destinationBtcAddress: string }
 * Response: { contractId: string; createdEventBlob: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";

import { getLedgerJwt, invalidateLedgerJwtCache } from "@/lib/auth";
import { getAccountContractRules } from "@/lib/bitsafe";
import { NETWORK } from "@/lib/constants";

const APPLICATION_ID = "cbtc-app";


const CREATE_WITHDRAW_ACCOUNT_CHOICE =
  "CBTCWithdrawAccountRules_CreateWithdrawAccount";

const TAG = "[redeem/create-withdraw-account]";

export async function POST(req: NextRequest) {
  console.log(`${TAG} request received`);

  try {
    const { partyId, destinationBtcAddress } = await req.json() as {
      partyId?: string;
      destinationBtcAddress?: string;
    };

    if (!partyId || !destinationBtcAddress) {
      console.error(`${TAG} missing partyId or destinationBtcAddress`);
      return NextResponse.json(
        { error: "partyId and destinationBtcAddress required" },
        { status: 400 },
      );
    }

    console.log(`${TAG} partyId=${partyId.slice(0, 30)}... btcAddress=${destinationBtcAddress}`);
    console.log(`${TAG} network=${NETWORK.name} ledgerHost=${NETWORK.ledgerHost}`);

    console.log(`${TAG} fetching account contract rules from coordinator...`);
    const rules = await getAccountContractRules();
    console.log(`${TAG} wa_rules contractId=${rules.wa_rules.contract_id}`);
    console.log(`${TAG} wa_rules templateId=${rules.wa_rules.template_id}`);
    console.log(`${TAG} wa_rules createdEventBlob length=${rules.wa_rules.created_event_blob?.length ?? 0}`);

    console.log(`${TAG} fetching JWT from Authentik...`);
    let jwt = await getLedgerJwt();
    console.log(`${TAG} JWT obtained, length=${jwt.length}`);

    const warpxParty = NETWORK.warpxPartyId;

    const buildBody = (commandId: string) => ({
      applicationId: APPLICATION_ID,
      workflowId: `cbtc-redeem-${commandId}`,
      commandId,
      // actAs + readAs: WarpX party only — m2m JWT authority, owner must be in actAs.
      actAs: [warpxParty],
      readAs: [warpxParty],
      commands: [
        {
          ExerciseCommand: {
            // Use templateId from coordinator response — correct package hash, no guessing.
            templateId: rules.wa_rules.template_id,
            contractId: rules.wa_rules.contract_id,
            choice: CREATE_WITHDRAW_ACCOUNT_CHOICE,
            choiceArgument: {
              owner: warpxParty,
              destinationBtcAddress,
            },
          },
        },
      ],
      disclosedContracts: [
        {
          templateId: rules.wa_rules.template_id,
          contractId: rules.wa_rules.contract_id,
          createdEventBlob: rules.wa_rules.created_event_blob,
          synchronizerId: "",
        },
      ],
    });

    const url = `${NETWORK.ledgerHost}/v2/commands/submit-and-wait-for-transaction-tree`;
    let commandId = randomUUID();

    console.log(`${TAG} submitting CreateWithdrawAccount to ledger...`);
    console.log(`${TAG} POST ${url}`);
    console.log(`${TAG} commandId=${commandId}`);

    let res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
      body: JSON.stringify(buildBody(commandId)),
      cache: "no-store",
    });

    console.log(`${TAG} ledger response status=${res.status}`);

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
        throw new Error("Node configuration required: cBTC DARs not uploaded to node. Contact support.");
      }
      throw new Error(`Ledger error (${res.status}): ${text}`);
    }

    const data = await res.json();
    console.log(`${TAG} raw tx response keys=${Object.keys(data as object).join(",")}`);

    const account = extractWithdrawAccount(data);
    if (!account) {
      console.error(`${TAG} could not extract contractId from response:`, JSON.stringify(data).slice(0, 1000));
      return NextResponse.json(
        { error: "Withdraw account created but contract ID not found in transaction response." },
        { status: 502 },
      );
    }

    console.log(`${TAG} success! withdrawAccount contractId=${account.contractId}`);
    console.log(`${TAG} createdEventBlob length=${account.createdEventBlob.length}`);
    return NextResponse.json(account);

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${TAG} unexpected error:`, err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function extractWithdrawAccount(data: unknown): { contractId: string; createdEventBlob: string } | null {
  if (!data || typeof data !== "object") return null;

  const txn = (data as { transaction?: { eventsById?: Record<string, unknown> } }).transaction;
  if (txn?.eventsById) {
    for (const ev of Object.values(txn.eventsById)) {
      const created = (ev as { created?: { contractId?: string; templateId?: string; createdEventBlob?: string } }).created;
      if (created?.contractId && created.templateId?.includes("CBTCWithdrawAccount")) {
        console.log(`[redeem/create-withdraw-account] found via transaction.eventsById (template match)`);
        return { contractId: created.contractId, createdEventBlob: created.createdEventBlob ?? "" };
      }
    }
    for (const ev of Object.values(txn.eventsById)) {
      const created = (ev as { created?: { contractId?: string; createdEventBlob?: string } }).created;
      if (created?.contractId) {
        console.log(`[redeem/create-withdraw-account] found via transaction.eventsById (first created)`);
        return { contractId: created.contractId, createdEventBlob: created.createdEventBlob ?? "" };
      }
    }
  }

  // Canton v2 actual shape: CreatedTreeEvent.value (not CreatedEvent)
  const tree = (data as { transactionTree?: { eventsById?: Record<string, unknown> } }).transactionTree;
  if (tree?.eventsById) {
    for (const ev of Object.values(tree.eventsById)) {
      const val =
        (ev as { CreatedTreeEvent?: { value?: { contractId?: string; templateId?: string; createdEventBlob?: string } } }).CreatedTreeEvent?.value ??
        (ev as { CreatedEvent?: { contractId?: string; templateId?: string; createdEventBlob?: string } }).CreatedEvent;
      if (val?.contractId && val.templateId?.includes("CBTCWithdrawAccount") && !val.templateId.includes("Rules")) {
        console.log(`[redeem/create-withdraw-account] found via CreatedTreeEvent.value (template match)`);
        return { contractId: val.contractId, createdEventBlob: val.createdEventBlob ?? "" };
      }
    }
    // fallback: first created
    for (const ev of Object.values(tree.eventsById)) {
      const val =
        (ev as { CreatedTreeEvent?: { value?: { contractId?: string; createdEventBlob?: string } } }).CreatedTreeEvent?.value ??
        (ev as { CreatedEvent?: { contractId?: string; createdEventBlob?: string } }).CreatedEvent;
      if (val?.contractId) {
        console.log(`[redeem/create-withdraw-account] found via CreatedTreeEvent.value (first created)`);
        return { contractId: val.contractId, createdEventBlob: val.createdEventBlob ?? "" };
      }
    }
    // belt-and-suspenders: exerciseResult
    for (const ev of Object.values(tree.eventsById)) {
      const exercised = (ev as { ExercisedTreeEvent?: { value?: { exerciseResult?: { withdrawAccountCid?: string } } } }).ExercisedTreeEvent?.value;
      if (exercised?.exerciseResult?.withdrawAccountCid) {
        console.log(`[redeem/create-withdraw-account] found via ExercisedTreeEvent.exerciseResult.withdrawAccountCid`);
        return { contractId: exercised.exerciseResult.withdrawAccountCid, createdEventBlob: "" };
      }
    }
  }

  return null;
}
