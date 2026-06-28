/**
 * POST /api/htlc/{id}/counter-lock — REVERSE step 3 record: the solver daemon
 * locked the WBTC on EVM (short timelock). Body: { counterLockTx }.
 */
import { NextResponse } from "next/server";
import { htlcService } from "@/lib/htlc-service-singleton";
import { requireDaemon } from "@/lib/htlc-auth";
import { assertDaemonOrderChain } from "@/lib/htlc-chain-binding";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const auth = requireDaemon(req);
    if (auth.error) return auth.error;
    const { counterLockTx } = await req.json();
    if (!counterLockTx) return NextResponse.json({ error: "missing counterLockTx" }, { status: 400 });
    const svc = htlcService();
    const existing = await svc.getOrder(id, { mode: "light" });
    if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });
    assertDaemonOrderChain(req, existing);
    const order = await svc.recordCounterLocked(id, counterLockTx);
    return NextResponse.json({ order });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
