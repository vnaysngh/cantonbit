/**
 * POST /api/htlc/{id}/refund-main — REVERSE refund: after the LONG (Canton)
 * timelock, return the locked CBTC to the USER (HtlcLock.Refund as locker=user
 * via CanActAs → Allocation_Withdraw). Timelock enforced in the service + on-ledger.
 */
import { NextResponse } from "next/server";
import { htlcService } from "@/lib/htlc-service-singleton";
import { requireOrderOwnerOrDaemon } from "@/lib/htlc-auth";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const auth = await requireOrderOwnerOrDaemon(req, id);
    if (auth.error) return auth.error;
    const { order, updateId } = await htlcService().refundMainCanton(id);
    return NextResponse.json({ order, updateId });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 }
    );
  }
}
