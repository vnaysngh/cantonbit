/**
 * POST /api/canton/swap/[id]/fill — solver atomic Loop fill (daemon only).
 */
import { NextResponse } from "next/server";

import { cantonSwapService } from "@/lib/canton-swap-service";
import { requireDaemonOnly } from "@/lib/canton-swap-auth";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  try {
    const auth = requireDaemonOnly(req);
    if (auth.error) return auth.error;
    const { id } = await ctx.params;
    const filled = await cantonSwapService().fillLoop(id);
    return NextResponse.json({ order: filled });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 }
    );
  }
}
