import { NextResponse } from "next/server";

import { requireDaemon } from "@/lib/htlc-auth";
import { assertDaemonOrderChain } from "@/lib/htlc-chain-binding";
import { htlcService } from "@/lib/htlc-service-singleton";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = requireDaemon(req);
    if (auth.error) return auth.error;
    const { id } = await params;
    const service = htlcService();
    const existing = await service.getOrder(id);
    if (!existing) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    assertDaemonOrderChain(req, existing);
    const order = await service.abortCounterLock(id);
    return NextResponse.json({ order });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 409 }
    );
  }
}
