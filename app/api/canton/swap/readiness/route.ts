/**
 * GET /api/canton/swap/readiness — Loop C2C pre-sign readiness (offer path + counter UX).
 */
import { NextResponse } from "next/server";

import type { CantonSwapMvpAssetId } from "@/lib/canton-swap-types";
import { previewLoopSwapReadiness } from "@/lib/canton-swap-preapproval";
import { requirePartyOwner } from "@/lib/htlc-auth";

export const dynamic = "force-dynamic";

function parseAsset(raw: string | null): CantonSwapMvpAssetId | null {
  if (raw === "CBTC" || raw === "CC") return raw;
  return null;
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const userParty = url.searchParams.get("userParty")?.trim() ?? "";
    const fromAsset = parseAsset(url.searchParams.get("fromAsset"));
    const toAsset = parseAsset(url.searchParams.get("toAsset"));
    const inAmount = url.searchParams.get("inAmount")?.trim() ?? "";
    const outAmount = url.searchParams.get("outAmount")?.trim() ?? "";

    if (!userParty || !fromAsset || !toAsset || !inAmount || !outAmount) {
      return NextResponse.json({ error: "missing query params" }, { status: 400 });
    }

    const auth = await requirePartyOwner(userParty);
    if (auth.error) return auth.error;

    const readiness = await previewLoopSwapReadiness({
      userParty,
      fromAsset,
      toAsset,
      inAmount,
      outAmount
    });
    return NextResponse.json(readiness);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
