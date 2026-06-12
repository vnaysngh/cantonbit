/**
 * POST /api/htlc/{id}/prepare-withdraw-loop — LOOP SELLER refund: build the STANDARD
 * Allocation_Withdraw (sender-alone) for the user's wallet — their unilateral exit.
 */
import { NextResponse } from "next/server";
import { htlcService } from "@/lib/htlc-service-singleton";
import { requireOrderOwner } from "@/lib/htlc-auth";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const auth = await requireOrderOwner(id);
    if (auth.error) return auth.error;
    const out = await htlcService().prepareLoopSellerWithdraw(id);
    return NextResponse.json(out);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
