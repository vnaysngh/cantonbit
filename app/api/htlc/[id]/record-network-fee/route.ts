/**
 * POST /api/htlc/{id}/record-network-fee — record Loop HTLC network fee after
 * a successful Loop wallet submit (forward claim path only).
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
    const { settlementUpdateId } = await req.json();
    const settlementId =
      settlementUpdateId != null ? String(settlementUpdateId).trim() : "";
    if (!settlementId) {
      return NextResponse.json(
        { error: "missing settlementUpdateId" },
        { status: 400 }
      );
    }
    const order = await htlcService().recordLoopNetworkFeeCollected(
      id,
      settlementId
    );
    return NextResponse.json({ order });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 }
    );
  }
}
