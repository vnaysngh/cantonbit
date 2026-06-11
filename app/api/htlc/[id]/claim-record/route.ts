/**
 * POST /api/htlc/{id}/claim-record — the browser reports the user's successful
 * Loop-wallet Claim. Body: { preimage, updateId }. Stores the revealed preimage so
 * the solver daemon can read it and claim the EVM "main" leg.
 */
import { NextResponse } from "next/server";
import { htlcService } from "@/lib/htlc-service-singleton";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const { preimage, updateId } = await req.json();
    if (!preimage || !updateId) return NextResponse.json({ error: "missing preimage/updateId" }, { status: 400 });
    const order = await htlcService().recordCounterClaimed(id, preimage, updateId);
    return NextResponse.json({ order });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
