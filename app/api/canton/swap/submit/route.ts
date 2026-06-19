/**
 * POST /api/canton/swap/submit — managed create + settle in one request.
 */
import { NextResponse } from "next/server";

import { cantonSwapService } from "@/lib/canton-swap-service";
import type { CantonSwapMvpAssetId } from "@/lib/canton-swap-types";
import { isParticipantManagedParty, requirePartyOwner } from "@/lib/htlc-auth";
import { CantonQuoteUnavailableError } from "@/lib/canton-quote";

export const dynamic = "force-dynamic";

function parseAsset(raw: unknown): CantonSwapMvpAssetId | null {
  if (raw === "CBTC" || raw === "CC") return raw;
  return null;
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const fromAsset = parseAsset(body.fromAsset);
    const toAsset = parseAsset(body.toAsset);
    const inAmount = String(body.inAmount ?? body.amount ?? "").trim();
    const outAmount = String(body.outAmount ?? "").trim();
    const userParty = String(body.userParty ?? body.cantonParty ?? "").trim();

    if (!fromAsset || !toAsset || !inAmount || !outAmount || !userParty) {
      return NextResponse.json({ error: "missing fields" }, { status: 400 });
    }
    if (fromAsset === toAsset) {
      return NextResponse.json({ error: "same asset" }, { status: 400 });
    }

    const auth = await requirePartyOwner(userParty);
    if (auth.error) return auth.error;

    if (!(await isParticipantManagedParty(userParty))) {
      return NextResponse.json(
        { error: "submit is for participant-managed parties only" },
        { status: 400 }
      );
    }

    const order = await cantonSwapService().submitManaged({
      fromAsset,
      toAsset,
      inAmount,
      outAmount,
      userParty,
      orderId: typeof body.id === "string" ? body.id : undefined
    });

    return NextResponse.json({ order });
  } catch (e) {
    if (e instanceof CantonQuoteUnavailableError) {
      return NextResponse.json({ error: e.message }, { status: 503 });
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 }
    );
  }
}
