/**
 * POST /api/canton/swap/[id]/settle — managed vault-backed settle (offer + fill).
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
    const settled = await cantonSwapService().settleManaged(id);
    return NextResponse.json({ order: settled });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 }
    );
  }
}
