/**
 * POST /api/htlc/{id}/record-counter-retake — daemon records solver WBTC retake on reverse swaps.
 */
import { NextResponse } from "next/server";

import { htlcService } from "@/lib/htlc-service-singleton";
import { requireDaemon } from "@/lib/htlc-auth";
import { assertDaemonOrderChain } from "@/lib/htlc-chain-binding";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = requireDaemon(req);
  if (auth.error) return auth.error;
  const { id } = await params;
  try {
    const { retakeTx } = (await req.json()) as { retakeTx?: string };
    if (!retakeTx) {
      return NextResponse.json({ error: "missing retakeTx" }, { status: 400 });
    }
    const svc = htlcService();
    const existing = await svc.getOrder(id, { mode: "light" });
    if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });
    assertDaemonOrderChain(req, existing);
    const order = await svc.recordCounterRetake(id, retakeTx);
    return NextResponse.json({ order });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 }
    );
  }
}
