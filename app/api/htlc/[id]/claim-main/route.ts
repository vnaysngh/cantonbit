/**
 * POST /api/htlc/{id}/claim-main — REVERSE step 5: the SOLVER claims the user's
 * CBTC with the preimage revealed on EVM. Body: { preimage? } (optional — falls
 * back to the stored revealedPreimage). On-ledger keccak gate enforces validity.
 */
import { NextResponse } from "next/server";
import { htlcClaimErrorStatus } from "@/lib/htlc-claim-http";
import { htlcService } from "@/lib/htlc-service-singleton";
import { requireDaemon } from "@/lib/htlc-auth";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const auth = requireDaemon(req);
    if (auth.error) return auth.error;
    const body = await req.json().catch(() => ({}));
    const { order, updateId } = await htlcService().claimMainAsSolver(
      id,
      body.preimage
    );
    return NextResponse.json({ order, updateId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { error: msg },
      { status: htlcClaimErrorStatus(msg) }
    );
  }
}
