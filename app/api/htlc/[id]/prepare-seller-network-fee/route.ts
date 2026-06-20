/**
 * POST /api/htlc/{id}/prepare-seller-network-fee — Loop reverse fee-only CC submit.
 * Call BEFORE prepare-lock-loop (fee-before-lock gate). Body: { ccHoldingCids }.
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
    const body = await req.json().catch(() => ({}));
    const ccHoldingCids = Array.isArray(body.ccHoldingCids)
      ? (body.ccHoldingCids as string[])
      : undefined;
    if (!ccHoldingCids?.length) {
      return NextResponse.json(
        { error: "missing ccHoldingCids — read CC holdings from Loop wallet" },
        { status: 400 }
      );
    }
    const out = await htlcService().prepareLoopSellerNetworkFee(id, ccHoldingCids);
    return NextResponse.json(out);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 }
    );
  }
}
