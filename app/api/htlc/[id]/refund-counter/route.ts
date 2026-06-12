/**
 * POST /api/htlc/{id}/refund-counter — refund the locked CBTC (Cancore "Refund").
 * After the Canton timelock, the solver withdraws via HtlcLock.Refund →
 * Allocation_Withdraw (backend signs as locker). Only valid after solverTimelock.
 */
import { NextResponse } from "next/server";
import { htlcService } from "@/lib/htlc-service-singleton";
import { requireDaemon } from "@/lib/htlc-auth";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const auth = requireDaemon(req);
    if (auth.error) return auth.error;
    const { order, updateId } = await htlcService().refundCounter(id);
    return NextResponse.json({ ok: true, updateId, status: order.status });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = msg.includes("too early") ? 409 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
