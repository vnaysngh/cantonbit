/**
 * POST /api/htlc/{id}/counter-lock — REVERSE step 3 record: the solver daemon
 * locked the WBTC on EVM (short timelock). Body: { counterLockTx }.
 */
import { NextResponse } from "next/server";
import { htlcService } from "@/lib/htlc-service-singleton";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const { counterLockTx } = await req.json();
    if (!counterLockTx) return NextResponse.json({ error: "missing counterLockTx" }, { status: 400 });
    const order = await htlcService().recordCounterLocked(id, counterLockTx);
    return NextResponse.json({ order });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
