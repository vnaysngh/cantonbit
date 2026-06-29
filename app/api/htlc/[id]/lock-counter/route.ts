/**
 * POST /api/htlc/{id}/lock-counter — the solver locks the CBTC counter (step 4).
 * CBTC has no on-ledger hashlock (T1), so this reserves the solver's float for the
 * swap; the CBTC is released only when the user claims with the correct preimage
 * (claim-counter). Marks the swap htlc_active.
 */
import { NextResponse } from "next/server";
import { htlcService } from "@/lib/htlc-service-singleton";
import { requireDaemon } from "@/lib/htlc-auth";
import { assertDaemonOrderChain } from "@/lib/htlc-chain-binding";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const auth = requireDaemon(req);
    if (auth.error) return auth.error;
    const svc = htlcService();
    const existing = await svc.getOrder(id, { mode: "light" });
    if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });
    assertDaemonOrderChain(req, existing);
    const order =
      existing?.counterMode === "loop" ? existing : await svc.lockCounter(id);
    return NextResponse.json({ order });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 }
    );
  }
}
