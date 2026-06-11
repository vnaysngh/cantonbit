/**
 * POST /api/htlc/{id}/claim-main — REVERSE step 5: the SOLVER claims the user's
 * cBTC with the preimage revealed on EVM. Body: { preimage? } (optional — falls
 * back to the stored revealedPreimage). On-ledger keccak gate enforces validity.
 */
import { NextResponse } from "next/server";
import { htlcService } from "@/lib/htlc-service-singleton";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const body = await req.json().catch(() => ({}));
    const { order, updateId } = await htlcService().claimMainAsSolver(id, body.preimage);
    return NextResponse.json({ order, updateId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: msg.includes("invalid preimage") ? 400 : 500 });
  }
}
