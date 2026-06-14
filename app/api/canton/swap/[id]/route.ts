/**
 * GET /api/canton/swap/[id]
 */
import { NextResponse } from "next/server";

import { cantonSwapService } from "@/lib/canton-swap-service";
import { requireOrderOwner } from "@/lib/canton-swap-auth";

export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await ctx.params;
    const order = await cantonSwapService().get(id);
    if (!order) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    const auth = await requireOrderOwner(req, order);
    if (auth.error) return auth.error;
    return NextResponse.json({ order });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
