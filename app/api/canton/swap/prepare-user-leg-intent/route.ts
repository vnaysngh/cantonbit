/**
 * POST /api/canton/swap/prepare-user-leg-intent — Loop C2C sell leg before DB order exists.
 */
import { NextResponse } from "next/server";

import { cantonSwapService } from "@/lib/canton-swap-service";
import { requireC2cLoopIntentRateLimit, requirePartyOwner } from "@/lib/htlc-auth";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const userParty = String(body.userParty ?? "").trim();
    const auth = await requirePartyOwner(userParty);
    if (auth.error) return auth.error;
    const rateLimit = await requireC2cLoopIntentRateLimit(auth.partyId);
    if (rateLimit) return rateLimit.error;
    const out = await cantonSwapService().prepareUserLegIntent({
      fromAsset: body.fromAsset,
      toAsset: body.toAsset,
      inAmount: String(body.inAmount),
      outAmount: String(body.outAmount),
      userParty,
      inputHoldingCids: Array.isArray(body.inputHoldingCids)
        ? body.inputHoldingCids
        : [],
      orderId: body.orderId ? String(body.orderId) : undefined
    });
    return NextResponse.json(out);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 }
    );
  }
}
