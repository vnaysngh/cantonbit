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
import { captureReset, captureStep } from "@/lib/burn-capture";
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

    // ── FULL CAPTURE (debug) — start a fresh snapshot for this UI burn. ──
    await captureReset({ party: partyId, btcAddress: destinationBtcAddress });
    let jwtClaims: Record<string, unknown> = {};
    try {
      jwtClaims = JSON.parse(Buffer.from(jwt.split(".")[1], "base64").toString());
    } catch { /* ignore */ }
    await captureStep("auth", {
      scope: process.env.KEYCLOAK_SCOPE ?? "daml_ledger_api",
      clientId: process.env.KEYCLOAK_CLIENT_ID,
      jwtLength: jwt.length,
      jwtClaims,
    });
    await captureStep("coordinator", {
      wa_rules: rules.wa_rules,
      da_rules: rules.da_rules,
    });

    const buildBody = (commandId: string) => ({
      applicationId: APPLICATION_ID,
      workflowId: `cbtc-redeem-${commandId}`,
      commandId,
      // The withdraw account must be OWNED BY THE USER, not warpx — the burn
      // choice (CBTCWithdrawAccount_Withdraw) is exercised by the owner, and the
      // cBTC holdings being burned are signed by the user party. So owner +
      // actAs must be the user. Our m2m JWT has authority over cbtc-user-*
      // parties. Matches the official cbtc-lib reference (act_as: [params.party]).
      actAs: [partyId],
      readAs: [partyId],
      commands: [
        {
          ExerciseCommand: {
            // Use templateId from coordinator response — correct package hash, no guessing.
            templateId: rules.wa_rules.template_id,
            contractId: rules.wa_rules.contract_id,
            choice: CREATE_WITHDRAW_ACCOUNT_CHOICE,
            choiceArgument: {
              owner: partyId,
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

    await captureStep("createWithdrawAccount", {
      request: buildBody(commandId),
      httpStatus: res.status,
      responseTree: data,
    });

    const account = extractWithdrawAccount(data);
    if (!account) {
      console.error(`${TAG} could not extract contractId from response:`, JSON.stringify(data).slice(0, 1000));
      return NextResponse.json(
        { error: "Withdraw account created but contract ID not found in transaction response." },
        { status: 502 },
      );
    }

    console.log(`${TAG} success! withdrawAccount contractId=${account.contractId}`);
    console.log(`${TAG} createdEventBlob from tx length=${account.createdEventBlob.length}`);

    // ALWAYS fetch the authoritative templateId + blob from active-contracts as
    // a CONSISTENT PAIR. The transaction-tree templateId can lag/differ from the
    // package the blob actually encodes; if we disclose a templateId that
    // doesn't match the blob's package, the subsequent burn resolves the
    // Withdraw choice against the wrong package (the stale f240dd5d one, which
    // demands credentials) and fails/stalls. The ACS row is the single source
    // of truth — its templateId and blob always match. (This is exactly what
    // the working manual burn does: it reads both from the same ACS row.)
    {
      console.log(`${TAG} fetching authoritative templateId+blob from active-contracts...`);
      try {
        const ledgerEndRes = await fetch(`${NETWORK.ledgerHost}/v2/state/ledger-end`, {
          headers: { Authorization: `Bearer ${jwt}` },
          cache: "no-store",
        });
        const { offset } = await ledgerEndRes.json() as { offset?: number };

        const acsRes = await fetch(`${NETWORK.ledgerHost}/v2/state/active-contracts`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
          body: JSON.stringify({
            filter: {
              filtersByParty: {
                [partyId]: {
                  cumulative: [{
                    identifierFilter: {
                      TemplateFilter: {
                        value: {
                          templateId: "#cbtc:CBTC.WithdrawAccount:CBTCWithdrawAccount",
                          includeCreatedEventBlob: true,
                        },
                      },
                    },
                  }],
                },
              },
            },
            verbose: false,
            activeAtOffset: offset ?? 0,
          }),
          cache: "no-store",
        });

        const raw = await acsRes.json() as unknown;
        const entries = Array.isArray(raw) ? raw : [];
        for (const entry of entries) {
          const e = entry as { contractEntry?: { JsActiveContract?: { createdEvent?: { contractId?: string; templateId?: string; createdEventBlob?: string } } } };
          const ev = e.contractEntry?.JsActiveContract?.createdEvent;
          if (ev?.contractId === account.contractId) {
            // Take BOTH from the same ACS row — a guaranteed-consistent pair.
            // templateId and blob MUST encode the same package or the burn's
            // disclosed contract is rejected / routed to the wrong package.
            if (ev.createdEventBlob) account.createdEventBlob = ev.createdEventBlob;
            if (ev.templateId) account.templateId = ev.templateId;
            console.log(`${TAG} authoritative from ACS: templateId=${account.templateId} blobLen=${account.createdEventBlob.length}`);
            break;
          }
        }
      } catch (blobErr) {
        // Non-fatal — but the burn may fail if we couldn't get the authoritative pair.
        console.warn(`${TAG} failed to fetch authoritative templateId/blob from ACS:`, blobErr);
      }
    }

    // ── CREATE DIFF LOG ────────────────────────────────────────────────────
    // What the UI hands to the burn step. templateId + blob MUST be a consistent
    // pair from the same ACS row (this is the invariant the working script holds).
    console.log(`${TAG} ===== CREATE DIFF LOG =====`);
    console.log(`${TAG} returned.contractId=${account.contractId}`);
    console.log(`${TAG} returned.templateId=${account.templateId}`);
    console.log(`${TAG} returned.package=${account.templateId.split(":")[0]}`);
    console.log(`${TAG} returned.createdEventBlob.length=${account.createdEventBlob.length}`);
    if (!account.templateId) {
      console.error(`${TAG} WARNING: templateId is EMPTY — the burn will reject (submit-withdraw now requires it)`);
    }
    console.log(`${TAG} ===========================`);
    await captureStep("fetchAccountFromACS", {
      foundContractId: account.contractId,
      templateId: account.templateId,
      package: account.templateId.split(":")[0],
      createdEventBlobLength: account.createdEventBlob.length,
      createdEventBlob: account.createdEventBlob,
    });
    return NextResponse.json(account);

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${TAG} unexpected error:`, err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function extractWithdrawAccount(data: unknown): { contractId: string; templateId: string; createdEventBlob: string } | null {
  if (!data || typeof data !== "object") return null;

  const txn = (data as { transaction?: { eventsById?: Record<string, unknown> } }).transaction;
  if (txn?.eventsById) {
    for (const ev of Object.values(txn.eventsById)) {
      const created = (ev as { created?: { contractId?: string; templateId?: string; createdEventBlob?: string } }).created;
      if (created?.contractId && created.templateId?.includes("CBTCWithdrawAccount")) {
        console.log(`[redeem/create-withdraw-account] found via transaction.eventsById (template match)`);
        return { contractId: created.contractId, templateId: created.templateId, createdEventBlob: created.createdEventBlob ?? "" };
      }
    }
    for (const ev of Object.values(txn.eventsById)) {
      const created = (ev as { created?: { contractId?: string; templateId?: string; createdEventBlob?: string } }).created;
      if (created?.contractId) {
        console.log(`[redeem/create-withdraw-account] found via transaction.eventsById (first created)`);
        return { contractId: created.contractId, templateId: created.templateId ?? "", createdEventBlob: created.createdEventBlob ?? "" };
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
        return { contractId: val.contractId, templateId: val.templateId, createdEventBlob: val.createdEventBlob ?? "" };
      }
    }
    // fallback: first created
    for (const ev of Object.values(tree.eventsById)) {
      const val =
        (ev as { CreatedTreeEvent?: { value?: { contractId?: string; templateId?: string; createdEventBlob?: string } } }).CreatedTreeEvent?.value ??
        (ev as { CreatedEvent?: { contractId?: string; templateId?: string; createdEventBlob?: string } }).CreatedEvent;
      if (val?.contractId) {
        console.log(`[redeem/create-withdraw-account] found via CreatedTreeEvent.value (first created)`);
        return { contractId: val.contractId, templateId: val.templateId ?? "", createdEventBlob: val.createdEventBlob ?? "" };
      }
    }
    // belt-and-suspenders: exerciseResult
    for (const ev of Object.values(tree.eventsById)) {
      const exercised = (ev as { ExercisedTreeEvent?: { value?: { exerciseResult?: { withdrawAccountCid?: string } } } }).ExercisedTreeEvent?.value;
      if (exercised?.exerciseResult?.withdrawAccountCid) {
        console.log(`[redeem/create-withdraw-account] found via ExercisedTreeEvent.exerciseResult.withdrawAccountCid`);
        return { contractId: exercised.exerciseResult.withdrawAccountCid, templateId: "", createdEventBlob: "" };
      }
    }
  }

  return null;
}
