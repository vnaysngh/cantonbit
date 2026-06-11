/**
 * GET /api/htlc/{id}/preimage — the revealed preimage (Cancore's GET .../preimage).
 * Available only after the user claimed the counter (revealed it). The solver
 * reads this to claim the EVM "main" leg (step 7).
 */
import { NextResponse } from "next/server";
import { htlcService } from "@/lib/htlc-service-singleton";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const preimage = await htlcService().getRevealedPreimage(id);
    if (!preimage) return NextResponse.json({ error: "not revealed yet" }, { status: 404 });
    return NextResponse.json({ preimage });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
