/**
 * POST /api/canton/swap/commit-user-leg — create C2C order only after verified Loop payment.
 */
import { NextResponse } from "next/server";

import { cantonSwapService } from "@/lib/canton-swap-service";
import { requireC2cLoopIntentRateLimit, requirePartyOwner } from "@/lib/htlc-auth";
import { c2cDisabledResponse } from "@/lib/swap-feature-flags-server";

export async function POST(req: Request) {
  const blocked = c2cDisabledResponse();
  if (blocked) return blocked;
  try {
    const body = await req.json();
    const userParty = String(body.userParty ?? "").trim();
    const auth = await requirePartyOwner(userParty);
    if (auth.error) return auth.error;
    const rateLimit = await requireC2cLoopIntentRateLimit(auth.partyId);
    if (rateLimit) return rateLimit.error;
    const submitUpdateId = String(body.submitUpdateId ?? "").trim();
    if (!submitUpdateId) {
      return NextResponse.json({ error: "missing submitUpdateId" }, { status: 400 });
    }
    const createdAt = Math.floor(Number(body.createdAt));
    if (!Number.isFinite(createdAt) || createdAt <= 0) {
      return NextResponse.json({ error: "invalid createdAt" }, { status: 400 });
    }
    const order = await cantonSwapService().commitUserLegOrder({
      fromAsset: body.fromAsset,
      toAsset: body.toAsset,
      inAmount: String(body.inAmount),
      outAmount: String(body.outAmount),
      userParty,
      orderId: String(body.orderId),
      createdAt,
      submitUpdateId,
      offerCidHint: body.offerCidHint
        ? String(body.offerCidHint)
        : undefined
    });
    return NextResponse.json({ order });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 }
    );
  }
}
