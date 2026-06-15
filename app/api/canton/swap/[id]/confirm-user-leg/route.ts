/**
 * POST /api/canton/swap/[id]/confirm-user-leg — Loop after user signed sell transfer.
 */
import { NextResponse } from "next/server";

import { cantonSwapService } from "@/lib/canton-swap-service";
import { requireOrderOwner } from "@/lib/canton-swap-auth";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await ctx.params;
    const order = await cantonSwapService().must(id);
    const auth = await requireOrderOwner(req, order);
    if (auth.error) return auth.error;

    const body = await req.json().catch(() => ({}));
    const offerCid =
      typeof body.offerContractId === "string" ? body.offerContractId.trim() : undefined;
    const submitUpdateId =
      typeof body.submitUpdateId === "string" ? body.submitUpdateId.trim() : undefined;

    const updated = await cantonSwapService().confirmUserLeg(id, {
      offerCid,
      submitUpdateId
    });
    return NextResponse.json({ order: updated });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 }
    );
  }
}
