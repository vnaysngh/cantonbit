/**
 * POST /api/htlc/{id}/lock-counter — the solver locks the cBTC counter (step 4).
 * cBTC has no on-ledger hashlock (T1), so this reserves the solver's float for the
 * swap; the cBTC is released only when the user claims with the correct preimage
 * (claim-counter). Marks the swap htlc_active.
 */
import { NextResponse } from "next/server";
import { htlcService } from "@/lib/htlc-service-singleton";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const order = await htlcService().lockCounter(id);
    return NextResponse.json({ order });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
