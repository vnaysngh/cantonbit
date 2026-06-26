/**
 * POST /api/redeem/status
 *
 * Live single-shot status of a redeem for a party + destination address, read
 * from the on-ledger CBTCWithdrawRequest. Used by the redeem success screen's
 * tracker. (The DB-backed history uses /api/redeem/sync instead.)
 *
 *   "broadcasting" — attestor created the request + assigned a btcTxId.
 *   "pending"      — no active request (not yet created, or already completed).
 *
 * Body: { partyId: string; destinationBtcAddress: string }
 * Response: { state; btcTxId; amount; withdrawRequestCid }
 */

import { NextRequest, NextResponse } from "next/server";

import { findWithdrawRequest } from "@/lib/redeem-ledger";
import { resolveSessionParty } from "@/lib/session-party";
import { requireMintRedeemRateLimit } from "@/lib/mint-redeem-guard";

const TAG = "[redeem/status]";

export async function POST(req: NextRequest) {
  try {
    const { partyId: clientPartyId, destinationBtcAddress } = (await req.json()) as {
      partyId?: string;
      destinationBtcAddress?: string;
    };

    // SECURITY: read only the session's own party's redeem status.
    const sess = await resolveSessionParty(clientPartyId);
    if (sess.error) return sess.error;
    const rate = await requireMintRedeemRateLimit(req, sess.partyId);
    if (rate) return rate;
    const partyId = sess.partyId;

    if (!destinationBtcAddress) {
      return NextResponse.json(
        { error: "destinationBtcAddress required" },
        { status: 400 },
      );
    }

    const request = await findWithdrawRequest(partyId, destinationBtcAddress);

    if (request) {
      console.log(
        `${TAG} request active cid=${request.contractId.slice(0, 16)} btcTxId=${request.btcTxId ?? "(none)"}`,
      );
      return NextResponse.json({
        state: "broadcasting",
        btcTxId: request.btcTxId,
        amount: request.amount,
        withdrawRequestCid: request.contractId,
      });
    }

    // No active request — either not picked up yet, or already completed+archived.
    // Do not infer completion from arbitrary BTC transactions to the address:
    // completion must come from the on-ledger withdraw lifecycle/history so a
    // third-party payment cannot make this route report a redeem as complete.

    console.log(`${TAG} no active request for ${destinationBtcAddress}`);
    return NextResponse.json({
      state: "pending",
      btcTxId: null,
      amount: null,
      withdrawRequestCid: null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${TAG} unexpected error:`, err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
