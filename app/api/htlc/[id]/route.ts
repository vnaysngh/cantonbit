/**
 * GET /api/htlc/{id} — fetch a swap order's status (drives the UI timeline).
 * ?light=1 — poll-friendly reconcile (Loop delivery repair only, no EVM scans).
 */
import { NextResponse } from "next/server";
import { requireOrderOwnerOrDaemon } from "@/lib/htlc-auth";
import { htlcService } from "@/lib/htlc-service-singleton";
import { htlcCanExposePreimageToSolver } from "@/lib/swap-product-invariants";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const auth = await requireOrderOwnerOrDaemon(req, id);
    if (auth.error) return auth.error;
    const light = new URL(req.url).searchParams.get("light") === "1";
    const order = await htlcService().getOrder(id, { mode: light ? "light" : "full" });
    if (!order) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    let out = order.counterMode === "loop" ? { ...order, networkFeeCc: undefined } : order;
    if (
      auth.daemon &&
      out.direction === "evm-to-canton" &&
      !htlcCanExposePreimageToSolver(out).ok
    ) {
      out = { ...out, revealedPreimage: undefined };
    }
    return NextResponse.json({ order: out });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
