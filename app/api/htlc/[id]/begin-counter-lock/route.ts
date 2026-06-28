import { NextResponse } from "next/server";

import { requireDaemon } from "@/lib/htlc-auth";
import { htlcService } from "@/lib/htlc-service-singleton";
import { assertDaemonOrderChain } from "@/lib/htlc-chain-binding";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = requireDaemon(req);
    if (auth.error) return auth.error;
    const { id } = await params;
    const body = (await req.json().catch(() => ({}))) as {
      evmFloatUnits?: string;
    };
    const svc = htlcService();
    const existing = await svc.getOrder(id, { mode: "light" });
    if (!existing) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    assertDaemonOrderChain(req, existing);
    const order = await svc.beginCounterLock(
      id,
      body.evmFloatUnits == null ? undefined : BigInt(body.evmFloatUnits)
    );
    return NextResponse.json({ order });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 409 }
    );
  }
}
