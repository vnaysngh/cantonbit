/**
 * POST /api/redeem/submit-withdraw
 *
 * Server-side handler for exercising CBTCWithdrawAccount_Withdraw.
 * Must be server-side: calls getLedgerJwt() — m2m secret never exposed to browser.
 *
 * Body: {
 *   partyId: string;
 *   withdrawAccountContractId: string;
 *   withdrawAccountCreatedEventBlob: string;
 *   holdingCids: string[];
 *   amount: string;
 * }
 * Response: { ok: true }
 */

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";

import { getLedgerJwt, invalidateLedgerJwtCache } from "@/lib/auth";
import { getTokenStandardContracts } from "@/lib/bitsafe";
import { NETWORK } from "@/lib/constants";

const APPLICATION_ID = "cbtc-app";

// Full package hash required — "#cbtc" alias rejected by v2 Ledger API.
const WITHDRAW_ACCOUNT_TEMPLATE_ID =
  "f240dd5d1a98079f37c0f93272cf5b28d4523027c42d0003c4c7a530eed6c313:CBTC.WithdrawAccount:CBTCWithdrawAccount";

const WITHDRAW_CHOICE = "CBTCWithdrawAccount_Withdraw";

const TAG = "[redeem/submit-withdraw]";

export async function POST(req: NextRequest) {
  console.log(`${TAG} request received`);

  try {
    const {
      partyId,
      withdrawAccountContractId,
      withdrawAccountCreatedEventBlob,
      holdingCids,
      amount,
    } = await req.json() as {
      partyId?: string;
      withdrawAccountContractId?: string;
      withdrawAccountCreatedEventBlob?: string;
      holdingCids?: string[];
      amount?: string;
    };

    if (!partyId || !withdrawAccountContractId || !holdingCids?.length || !amount) {
      console.error(`${TAG} missing required fields`);
      return NextResponse.json(
        { error: "partyId, withdrawAccountContractId, holdingCids, and amount required" },
        { status: 400 },
      );
    }

    console.log(`${TAG} partyId=${partyId.slice(0, 30)}...`);
    console.log(`${TAG} withdrawAccountContractId=${withdrawAccountContractId}`);
    console.log(`${TAG} holdingCids count=${holdingCids.length} ids=${holdingCids.map(c => c.slice(0, 15)).join(",")}`);
    console.log(`${TAG} amount=${amount}`);
    console.log(`${TAG} network=${NETWORK.name} ledgerHost=${NETWORK.ledgerHost}`);
    console.log(`${TAG} coordinatorUrl=${NETWORK.coordinatorUrl}`);

    // Fetch 5 token-standard contracts needed for choiceArgument + disclosures
    console.log(`${TAG} fetching token-standard contracts from coordinator...`);
    const ts = await getTokenStandardContracts();
    console.log(`${TAG} burn_mint_factory contractId=${ts.burn_mint_factory.contract_id}`);
    console.log(`${TAG} instrument_configuration contractId=${ts.instrument_configuration.contract_id}`);
    console.log(`${TAG} app_reward_configuration contractId=${ts.app_reward_configuration.contract_id}`);
    console.log(`${TAG} featured_app_right contractId=${ts.featured_app_right.contract_id}`);
    console.log(`${TAG} issuer_credential contractId=${ts.issuer_credential.contract_id}`);

    console.log(`${TAG} fetching JWT from Authentik...`);
    let jwt = await getLedgerJwt();
    console.log(`${TAG} JWT obtained, length=${jwt.length}`);

    const warpxParty = NETWORK.warpxPartyId;

    const buildBody = (commandId: string) => ({
      applicationId: APPLICATION_ID,
      workflowId: `cbtc-withdraw-${commandId}`,
      commandId,
      // actAs + readAs: WarpX party only — m2m JWT authority.
      actAs: [warpxParty],
      readAs: [warpxParty],
      commands: [
        {
          ExerciseCommand: {
            templateId: WITHDRAW_ACCOUNT_TEMPLATE_ID,
            contractId: withdrawAccountContractId,
            choice: WITHDRAW_CHOICE,
            choiceArgument: {
              tokens: holdingCids,
              amount,
              burnMintFactoryCid: ts.burn_mint_factory.contract_id,
              extraArgs: {
                context: {
                  values: {
                    "utility.digitalasset.com/instrument-configuration": {
                      tag: "AV_ContractId",
                      value: ts.instrument_configuration.contract_id,
                    },
                    "utility.digitalasset.com/app-reward-configuration": {
                      tag: "AV_ContractId",
                      value: ts.app_reward_configuration.contract_id,
                    },
                    "utility.digitalasset.com/featured-app-right": {
                      tag: "AV_ContractId",
                      value: ts.featured_app_right.contract_id,
                    },
                    "utility.digitalasset.com/issuer-credentials": {
                      tag: "AV_List",
                      value: [
                        {
                          tag: "AV_ContractId",
                          value: ts.issuer_credential.contract_id,
                        },
                      ],
                    },
                  },
                },
                meta: {
                  values: {
                    "splice.lfdecentralizedtrust.org/reason": "CBTC Burn",
                  },
                },
              },
            },
          },
        },
      ],
      disclosedContracts: [
        {
          templateId: WITHDRAW_ACCOUNT_TEMPLATE_ID,
          contractId: withdrawAccountContractId,
          createdEventBlob: withdrawAccountCreatedEventBlob ?? "",
          synchronizerId: "",
        },
        {
          templateId: ts.burn_mint_factory.template_id,
          contractId: ts.burn_mint_factory.contract_id,
          createdEventBlob: ts.burn_mint_factory.created_event_blob,
          synchronizerId: "",
        },
        {
          templateId: ts.instrument_configuration.template_id,
          contractId: ts.instrument_configuration.contract_id,
          createdEventBlob: ts.instrument_configuration.created_event_blob,
          synchronizerId: "",
        },
        {
          templateId: ts.app_reward_configuration.template_id,
          contractId: ts.app_reward_configuration.contract_id,
          createdEventBlob: ts.app_reward_configuration.created_event_blob,
          synchronizerId: "",
        },
        {
          templateId: ts.featured_app_right.template_id,
          contractId: ts.featured_app_right.contract_id,
          createdEventBlob: ts.featured_app_right.created_event_blob,
          synchronizerId: "",
        },
        {
          templateId: ts.issuer_credential.template_id,
          contractId: ts.issuer_credential.contract_id,
          createdEventBlob: ts.issuer_credential.created_event_blob,
          synchronizerId: "",
        },
      ],
    });

    const url = `${NETWORK.ledgerHost}/v2/commands/submit-and-wait-for-transaction-tree`;
    let commandId = randomUUID();

    console.log(`${TAG} submitting CBTCWithdrawAccount_Withdraw to ledger...`);
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
        return NextResponse.json(
          { error: "Node configuration required: cBTC DARs not uploaded to node. Contact support." },
          { status: 502 },
        );
      }
      return NextResponse.json({ error: `Ledger error (${res.status}): ${text}` }, { status: 502 });
    }

    console.log(`${TAG} success! burn submitted for amount=${amount}`);
    return NextResponse.json({ ok: true });

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${TAG} unexpected error:`, err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
