/**
 * POST /api/htlc/{id}/refund-main — REVERSE refund: after the LONG (Canton)
 * timelock, return the locked cBTC to the USER (HtlcLock.Refund as locker=user
 * via CanActAs → Allocation_Withdraw). Timelock enforced in the service + on-ledger.
 */
import { NextResponse } from "next/server";
import { htlcService } from "@/lib/htlc-service-singleton";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const { order, updateId } = await htlcService().refundMainCanton(id);
    return NextResponse.json({ order, updateId });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
