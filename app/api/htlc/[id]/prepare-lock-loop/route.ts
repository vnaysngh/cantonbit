/**
 * POST /api/htlc/{id}/prepare-lock-loop — LOOP SELLER step 2a: build the STANDARD
 * AllocationFactory_Allocate command for the user's wallet. Body: { holdingCids }
 * (the user's CBTC holding cids, read in the browser via provider.getActiveContracts
 * — we cannot see a Loop party's holdings cross-participant).
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
    const { holdingCids } = await req.json();
    const out = await htlcService().prepareLoopSellerLock(
      id,
      holdingCids ?? []
    );
    return NextResponse.json(out);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 }
    );
  }
}
