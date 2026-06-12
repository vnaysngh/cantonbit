/**
 * POST /api/htlc/{id}/retake-main — record the user's EVM retake (WBTC refund).
 * Body: { retakeTx }. The user signs retake(hashLock) in MetaMask after the EVM
 * timelock; this records it and marks the swap refunded.
 */
import { NextResponse } from "next/server";
import { htlcService } from "@/lib/htlc-service-singleton";
import { requireOrderOwner } from "@/lib/htlc-auth";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const auth = await requireOrderOwner(id);
    if (auth.error) return auth.error;
    const { retakeTx } = await req.json();
    if (!retakeTx) return NextResponse.json({ error: "missing retakeTx" }, { status: 400 });
    const order = await htlcService().recordMainRetake(id, retakeTx);
    return NextResponse.json({ ok: true, status: order.status });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
