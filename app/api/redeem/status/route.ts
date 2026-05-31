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
import { NETWORK } from "@/lib/constants";

const TAG = "[redeem/status]";

export async function POST(req: NextRequest) {
  try {
    const { partyId, destinationBtcAddress } = (await req.json()) as {
      partyId?: string;
      destinationBtcAddress?: string;
    };

    if (!partyId || !destinationBtcAddress) {
      return NextResponse.json(
        { error: "partyId and destinationBtcAddress required" },
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
    // Check mempool for a confirmed incoming tx to the destination address.
    const explorerBase =
      NETWORK.name === "mainnet" ? "https://mempool.space/api"
      : NETWORK.name === "testnet" ? "https://mempool.space/testnet/api"
      : null;

    if (explorerBase) {
      try {
        const mRes = await fetch(
          `${explorerBase}/address/${encodeURIComponent(destinationBtcAddress)}/txs`,
          { cache: "no-store" },
        );
        if (mRes.ok) {
          const txs = (await mRes.json()) as Array<{
            txid: string;
            status?: { confirmed?: boolean };
            vout?: Array<{ scriptpubkey_address?: string }>;
          }>;
          const confirmed = txs.find(
            (tx) =>
              tx.status?.confirmed &&
              tx.vout?.some((v) => v.scriptpubkey_address === destinationBtcAddress),
          );
          if (confirmed) {
            console.log(`${TAG} completed — confirmed btc tx ${confirmed.txid}`);
            return NextResponse.json({
              state: "completed",
              btcTxId: confirmed.txid,
              amount: null,
              withdrawRequestCid: null,
            });
          }
        }
      } catch {
        // mempool unreachable — fall through to pending
      }
    }

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
