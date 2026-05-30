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
import { captureStep } from "@/lib/burn-capture";
import { NETWORK } from "@/lib/constants";

const APPLICATION_ID = "cbtc-app";

const WITHDRAW_CHOICE = "CBTCWithdrawAccount_Withdraw";

const TAG = "[redeem/submit-withdraw]";

export async function POST(req: NextRequest) {
  console.log(`${TAG} request received`);

  try {
    const {
      partyId,
      withdrawAccountContractId,
      withdrawAccountTemplateId,
      withdrawAccountCreatedEventBlob,
      holdingCids,
      amount,
    } = await req.json() as {
      partyId?: string;
      withdrawAccountContractId?: string;
      withdrawAccountTemplateId?: string;
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

    // The withdraw-account templateId MUST be the exact package the account's
    // createdEventBlob encodes (the caller reads both as a consistent pair from
    // the ACS). There is NO safe fallback: previously we defaulted to a
    // hardcoded f240dd5d package here, which — when paired with a 43a8452a blob
    // — produced an inconsistent disclosed contract and routed the burn to the
    // wrong (credential-demanding) package's Withdraw choice. So we now REQUIRE
    // it and fail loudly rather than guess.
    if (!withdrawAccountTemplateId) {
      console.error(`${TAG} missing withdrawAccountTemplateId — refusing to guess the package`);
      return NextResponse.json(
        { error: "withdrawAccountTemplateId is required (must match the account's createdEventBlob package)" },
        { status: 400 },
      );
    }
    const withdrawAccountTpl = withdrawAccountTemplateId;

    console.log(`${TAG} partyId=${partyId.slice(0, 30)}...`);
    console.log(`${TAG} withdrawAccountContractId=${withdrawAccountContractId}`);
    console.log(`${TAG} holdingCids count=${holdingCids.length} ids=${holdingCids.map(c => c.slice(0, 15)).join(",")}`);
    console.log(`${TAG} amount=${amount}`);
    console.log(`${TAG} network=${NETWORK.name} ledgerHost=${NETWORK.ledgerHost}`);

    console.log(`${TAG} fetching JWT from Authentik...`);
    let jwt = await getLedgerJwt();
    console.log(`${TAG} JWT obtained, length=${jwt.length}`);

    // IMPORTANT: the CBTCWithdrawAccount_Withdraw choice on the DEPLOYED DAR
    // (package 43a8452a…) takes ONLY { tokens, amount }. It does NOT accept
    // `burnMintFactoryCid` or `extraArgs` — those belong to a NEWER DAR version
    // described by cbtc-lib / Yaak / the BitSafe docs but NOT installed on this
    // node. Sending them produces `INVALID_ARGUMENT: Unexpected fields:
    // burnMintFactoryCid extraArgs`. Verified empirically (burned 0.00001 with
    // the minimal arg → success). So we send the minimal argument and disclose
    // only the withdraw account itself — no token-standard contracts needed.
    const buildBody = (commandId: string) => {
      return {
        applicationId: APPLICATION_ID,
        workflowId: `cbtc-withdraw-${commandId}`,
        commandId,
        // Burn is submitted as the HOLDING OWNER (the user party). cBTC holdings
        // are signed by [cbtc-network, the user party]; warpx is not a signatory.
        // Our m2m JWT has authority over cbtc-user-* parties.
        actAs: [partyId],
        readAs: [partyId],
        commands: [
          {
            ExerciseCommand: {
              templateId: withdrawAccountTpl,
              contractId: withdrawAccountContractId,
              choice: WITHDRAW_CHOICE,
              choiceArgument: {
                tokens: holdingCids,
                amount,
              },
            },
          },
        ],
        disclosedContracts: [
          {
            templateId: withdrawAccountTpl,
            contractId: withdrawAccountContractId,
            createdEventBlob: withdrawAccountCreatedEventBlob ?? "",
            synchronizerId: "",
          },
        ],
      };
    };

    const url = `${NETWORK.ledgerHost}/v2/commands/submit-and-wait-for-transaction-tree`;
    let commandId = randomUUID();

    // ── BURN DIFF LOG ──────────────────────────────────────────────────────
    // Exact bytes the UI is about to submit, for byte-level comparison against
    // scripts/working-burn-reference.mjs. The critical invariant: the disclosed
    // templateId package MUST equal the package the createdEventBlob encodes.
    const tplPkg = withdrawAccountTpl.split(":")[0];
    const burnBody = buildBody(commandId);
    console.log(`${TAG} ===== BURN DIFF LOG =====`);
    console.log(`${TAG} actAs=${JSON.stringify([partyId])}`);
    console.log(`${TAG} readAs=${JSON.stringify([partyId])}`);
    console.log(`${TAG} applicationId=${APPLICATION_ID}`);
    console.log(`${TAG} choice=${WITHDRAW_CHOICE}`);
    console.log(`${TAG} withdrawAccount.templateId=${withdrawAccountTpl}`);
    console.log(`${TAG} withdrawAccount.package=${tplPkg}`);
    console.log(`${TAG} withdrawAccount.contractId=${withdrawAccountContractId}`);
    console.log(`${TAG} withdrawAccount.createdEventBlob.length=${(withdrawAccountCreatedEventBlob ?? "").length}`);
    console.log(`${TAG} withdrawAccount.createdEventBlob.head=${(withdrawAccountCreatedEventBlob ?? "").slice(0, 40)}`);
    console.log(`${TAG} choiceArgument.amount=${amount}`);
    console.log(`${TAG} choiceArgument.tokens=${JSON.stringify(holdingCids)}`);
    console.log(`${TAG} ledgerHost=${NETWORK.ledgerHost}`);
    console.log(`${TAG} jwt.length=${jwt.length}`);
    console.log(`${TAG} FULL burn body=${JSON.stringify(burnBody)}`);
    console.log(`${TAG} =========================`);

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

    // Parse the burn's updateId — returned to the client and used as the stable
    // id for this redeem in the (ledger-derived) activity history.
    let burnUpdateId: string | null = null;
    let burnTree: unknown = null;
    try {
      burnTree = await res.json();
      const tree = burnTree as {
        transactionTree?: { updateId?: string; offset?: number };
        transaction?: { updateId?: string };
      };
      burnUpdateId =
        tree.transactionTree?.updateId ?? tree.transaction?.updateId ?? null;
    } catch {
      // response body not JSON / already consumed — non-fatal
    }

    // FULL CAPTURE: the burn request + response tree (the final, decisive step).
    await captureStep("burn", {
      url,
      request: burnBody,
      httpStatus: res.status,
      responseTree: burnTree,
      updateId: burnUpdateId,
    });

    console.log(
      `${TAG} success! burn submitted for amount=${amount} updateId=${burnUpdateId ?? "(unknown)"}`,
    );
    return NextResponse.json({ ok: true, burnUpdateId });

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${TAG} unexpected error:`, err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
