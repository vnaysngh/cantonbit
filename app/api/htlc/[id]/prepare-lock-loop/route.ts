/**
 * POST /api/htlc/{id}/prepare-lock-loop — LOOP SELLER step 2a: build the STANDARD
 * transfer (user → venue) for the user's wallet. Pay network fee via
 * prepare-seller-network-fee first (separate Loop submit).
 */
import { NextResponse } from "next/server";
import { htlcService } from "@/lib/htlc-service-singleton";
import { requireOrderOwner } from "@/lib/htlc-auth";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const auth = await requireOrderOwner(id);
    if (auth.error) return auth.error;
    const { holdingCids, ccHoldingCids } = await req.json();
    const out = await htlcService().prepareLoopSellerLockWithFee(
      id,
      holdingCids ?? [],
      Array.isArray(ccHoldingCids) ? ccHoldingCids : undefined
    );
    return NextResponse.json(out);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 }
    );
  }
}
