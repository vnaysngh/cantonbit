/**
 * GET /api/htlc/{id}/preimage — the revealed preimage (Cancore's GET .../preimage).
 * Available only after the user claimed the counter (revealed it). The solver
 * reads this to claim the EVM "main" leg (step 7).
 */
import { NextResponse } from "next/server";
import { htlcService } from "@/lib/htlc-service-singleton";
import { expectedSettlementParty, requireDaemon } from "@/lib/htlc-auth";
import { assertDaemonOrderChain } from "@/lib/htlc-chain-binding";
import { htlcCanExposePreimageToSolver } from "@/lib/swap-product-invariants";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const auth = requireDaemon(req);
    if (auth.error) return auth.error;
    const order = await htlcService().getOrder(id);
    if (!order) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    assertDaemonOrderChain(req, order);
    const vault = expectedSettlementParty();
    if (vault && order.solverCantonParty !== vault) {
      return NextResponse.json({ error: "order vault party mismatch" }, { status: 403 });
    }
    const gate = htlcCanExposePreimageToSolver(order);
    if (!gate.ok) {
      return NextResponse.json({ error: gate.reason }, { status: 409 });
    }
    const preimage = order.revealedPreimage;
    if (!preimage) return NextResponse.json({ error: "not revealed yet" }, { status: 404 });
    return NextResponse.json({ preimage });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
