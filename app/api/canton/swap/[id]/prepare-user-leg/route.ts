/**
 * POST /api/canton/swap/[id]/prepare-user-leg — Loop sell leg command (offer-only).
 */
import { NextResponse } from "next/server";

import {
  registrarAdminForAsset,
  registryKindForAsset,
  resolveSwapInstrumentId
} from "@/lib/canton-swap-holdings";
import { assertOrderNotExpired, LOOP_USER_LEG_OFFER_TTL_SECONDS } from "@/lib/canton-swap-order-logic";
import { previewLoopSwapReadiness, isDirectTransferKind } from "@/lib/canton-swap-preapproval";
import { cantonSwapService } from "@/lib/canton-swap-service";
import { requireOrderOwner } from "@/lib/canton-swap-auth";
import { userLegReceiverParty } from "@/lib/canton-swap-types";
import { prepareTransferCommand } from "@/lib/transfer";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await ctx.params;
    let order = await cantonSwapService().must(id);
    const auth = await requireOrderOwner(req, order);
    if (auth.error) return auth.error;
    if (order.walletMode !== "loop") {
      return NextResponse.json({ error: "loop only" }, { status: 400 });
    }
    order = await cantonSwapService().reopenFalseVaultMigrationIfNeeded(id);
    if (order.status !== "open") {
      return NextResponse.json(
        { error: `invalid status ${order.status}` },
        { status: 400 }
      );
    }
    try {
      assertOrderNotExpired(order);
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : String(e) },
        { status: 400 }
      );
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

    const receiverParty = userLegReceiverParty(order);
    const instrumentId = await resolveSwapInstrumentId(order.fromAsset);
    const registrarAdmin = await registrarAdminForAsset(order.fromAsset);
    const prepared = await prepareTransferCommand({
      senderParty: order.userParty,
      receiverParty,
      amountBtc: order.inAmount,
      inputHoldingCids,
      instrumentId,
      registrarAdmin,
      registryKind: registryKindForAsset(order.fromAsset),
      expirationSeconds: LOOP_USER_LEG_OFFER_TTL_SECONDS
    });

    if (isDirectTransferKind(prepared.transferKind)) {
      const preview = await previewLoopSwapReadiness({
        userParty: order.userParty,
        solverParty: order.solverParty,
        settlementParty: order.settlementParty,
        fromAsset: order.fromAsset,
        toAsset: order.toAsset,
        inAmount: order.inAmount,
        outAmount: order.outAmount
      });
      return NextResponse.json(
        {
          error:
            preview.issues[0] ??
            "Swap requires pending transfer offer — settlement receiver must not have TransferPreapproval"
        },
        { status: 400 }
      );
    }

    const counterPreview = await previewLoopSwapReadiness({
      userParty: order.userParty,
      solverParty: order.solverParty,
      settlementParty: order.settlementParty,
      fromAsset: order.fromAsset,
      toAsset: order.toAsset,
      inAmount: order.inAmount,
      outAmount: order.outAmount
    });

    return NextResponse.json({
      ...prepared,
      counterRequiresAccept: counterPreview.counterRequiresAccept
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 }
    );
  }
}
