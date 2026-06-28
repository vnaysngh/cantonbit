/**
 * POST /api/htlc/{id}/claim-as-receiver — TEST ONLY (disabled unless HTLC_ENABLE_TEST_ROUTES=true).
 */
import { NextResponse } from "next/server";
import { htlcService } from "@/lib/htlc-service-singleton";
import { claimAsReceiver } from "@/lib/htlc-onledger";
import { requireDaemon } from "@/lib/htlc-auth";
import { assertDaemonOrderChain } from "@/lib/htlc-chain-binding";

function testRouteEnabled(): boolean {
  return (
    process.env.NODE_ENV !== "production" &&
    process.env.HTLC_ENABLE_TEST_ROUTES === "true"
  );
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!testRouteEnabled()) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { id } = await params;
  try {
    const auth = requireDaemon(req);
    if (auth.error) return auth.error;
    const { preimage } = await req.json();
    const order = await htlcService().getOrder(id);
    if (!order) return NextResponse.json({ error: "not found" }, { status: 404 });
    assertDaemonOrderChain(req, order);
    if (!order.htlcCid || !order.allocationCid) {
      return NextResponse.json({ error: "counter not locked" }, { status: 400 });
    }
    const commandId = `htlc-test-claim-receiver-${id}`;
    const { updateId } = await claimAsReceiver({
      receiverParty: order.userCantonParty,
      solverParty: order.solverCantonParty,
      htlcCid: order.htlcCid,
      htlcBlob: order.htlcBlob,
      allocationCid: order.allocationCid,
      preimageHex: preimage,
      commandId
    });
    await htlcService().recordCounterClaimed(id, preimage, updateId);
    return NextResponse.json({ ok: true, updateId });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
