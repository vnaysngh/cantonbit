/**
 * POST /api/canton/swap/[id]/prepare-user-leg — Loop sell leg command.
 */
import { NextResponse } from "next/server";

import {
  registrarAdminForAsset,
  registryKindForAsset,
  resolveSwapInstrumentId
} from "@/lib/canton-swap-holdings";
import { LOOP_USER_LEG_OFFER_TTL_SECONDS } from "@/lib/canton-swap-order-logic";
import { cantonSwapService } from "@/lib/canton-swap-service";
import { requireOrderOwner } from "@/lib/canton-swap-auth";
import { prepareTransferCommand } from "@/lib/transfer";

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
    if (order.walletMode !== "loop") {
      return NextResponse.json({ error: "loop only" }, { status: 400 });
    }

    const body = await req.json().catch(() => ({}));
    const inputHoldingCids = Array.isArray(body.inputHoldingCids)
      ? body.inputHoldingCids.filter((c: unknown) => typeof c === "string")
      : [];
    if (inputHoldingCids.length === 0) {
      return NextResponse.json(
        { error: "inputHoldingCids required" },
        { status: 400 }
      );
    }

    const instrumentId = await resolveSwapInstrumentId(order.fromAsset);
    const registrarAdmin = await registrarAdminForAsset(order.fromAsset);
    const prepared = await prepareTransferCommand({
      senderParty: order.userParty,
      receiverParty: order.solverParty,
      amountBtc: order.inAmount,
      inputHoldingCids,
      instrumentId,
      registrarAdmin,
      registryKind: registryKindForAsset(order.fromAsset),
      expirationSeconds: LOOP_USER_LEG_OFFER_TTL_SECONDS
    });

    return NextResponse.json(prepared);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 }
    );
  }
}
