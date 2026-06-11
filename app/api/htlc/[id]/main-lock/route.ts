/**
 * POST /api/htlc/{id}/main-lock — record the maker's EVM HTLC lock (step 3).
 * Body: { mainLockTx }. The frontend submits the lock via MetaMask, then calls
 * this. The solver should verify the on-chain lock before locking the counter.
 */
import { NextResponse } from "next/server";
import { htlcService } from "@/lib/htlc-service-singleton";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const { mainLockTx } = await req.json();
    if (!mainLockTx) return NextResponse.json({ error: "missing mainLockTx" }, { status: 400 });
    const order = await htlcService().recordMainLock(id, mainLockTx);
    return NextResponse.json({ order });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
