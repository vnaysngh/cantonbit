/**
 * POST /api/htlc/{id}/claim-as-receiver — TEST ONLY.
 * Submits HtlcLock.Claim AS the receiver via the m2m JWT (works when the receiver
 * party is hosted on this validator). Proves the on-ledger keccak check + Execute
 * Transfer fire. In production the user's Loop wallet does this; this endpoint is
 * a server-side proof for a validator-local receiver.
 */
import { NextResponse } from "next/server";
import { htlcService } from "@/lib/htlc-service-singleton";
import { claimAsReceiver } from "@/lib/htlc-onledger";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const { preimage } = await req.json();
    const order = await htlcService().getOrder(id);
    if (!order) return NextResponse.json({ error: "not found" }, { status: 404 });
    if (!order.htlcCid || !order.allocationCid) {
      return NextResponse.json({ error: "counter not locked" }, { status: 400 });
    }
    const { updateId } = await claimAsReceiver({
      receiverParty: order.userCantonParty,
      solverParty: order.solverCantonParty,
      htlcCid: order.htlcCid,
      htlcBlob: order.htlcBlob,
      allocationCid: order.allocationCid,
      preimageHex: preimage,
    });
    await htlcService().recordCounterClaimed(id, preimage, updateId);
    return NextResponse.json({ ok: true, updateId });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
