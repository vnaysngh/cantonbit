/**
 * POST /api/canton/swap/[id]/prepare-counter-accept — Loop accept incoming counter leg.
 */
import { NextResponse } from "next/server";

import {
  registrarAdminForAsset,
  registryKindForAsset
} from "@/lib/canton-swap-holdings";
import { cantonSwapService } from "@/lib/canton-swap-service";
import { requireOrderOwner } from "@/lib/canton-swap-auth";
import { prepareAcceptCommand } from "@/lib/transfer";

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
    if (!order.counterLegOfferCid) {
      return NextResponse.json({ error: "no counter offer" }, { status: 400 });
    }
    const prepared = await prepareAcceptCommand({
      offerContractId: order.counterLegOfferCid,
      registrarAdmin: await registrarAdminForAsset(order.toAsset),
      registryKind: registryKindForAsset(order.toAsset)
    });
    return NextResponse.json(prepared);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 }
    );
  }
}
