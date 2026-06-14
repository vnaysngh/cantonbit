/**
 * POST /api/canton/swap/[id]/cancel — maker cancels before locking a sell leg.
 */
import { NextResponse } from "next/server";

import { cantonSwapService } from "@/lib/canton-swap-service";
import { requireOrderOwner } from "@/lib/canton-swap-auth";

export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await ctx.params;
    const order = await cantonSwapService().must(id);
    const auth = await requireOrderOwner(_req, order);
    if (auth.error) return auth.error;
    const cancelled = await cantonSwapService().cancel(id);
    return NextResponse.json({ order: cancelled });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 }
    );
  }
}
