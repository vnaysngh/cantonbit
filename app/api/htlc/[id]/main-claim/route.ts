/**
 * POST /api/htlc/{id}/main-claim — record the solver's EVM claim (step 7).
 * Body: { mainClaimTx }. The solver reads the revealed preimage and claims the
 * EVM "main" HTLC; this records it and marks the swap complete (main_claimed).
 */
import { NextResponse } from "next/server";
import { htlcService } from "@/lib/htlc-service-singleton";
import { requireDaemon } from "@/lib/htlc-auth";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const auth = requireDaemon(req);
    if (auth.error) return auth.error;
    const { mainClaimTx } = await req.json();
    if (!mainClaimTx) return NextResponse.json({ error: "missing mainClaimTx" }, { status: 400 });
    const order = await htlcService().recordMainClaim(id, mainClaimTx);
    return NextResponse.json({ order });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
