/**
 * POST /api/canton/swap/quote — indicative same-Canton quote (CBTC↔CC MVP).
 */
import { NextResponse } from "next/server";

import {
  cantonSwapQuoteRateLimitOk,
  clientIpFromRequest
} from "@/lib/canton-swap-rate-limit";
import { quoteMvpCantonSwap } from "@/lib/canton-swap-quote";
import {
  CantonQuoteSanityError,
  CantonQuoteUnavailableError
} from "@/lib/canton-quote";
import { cantonQuoteUnavailableUserMessage } from "@/lib/canton-quote-messages";
import type { CantonSwapMvpAssetId } from "@/lib/canton-swap-types";

export const dynamic = "force-dynamic";

function parseMvpAsset(raw: unknown): CantonSwapMvpAssetId | null {
  if (raw === "CBTC" || raw === "CC") return raw;
  return null;
}

export async function POST(req: Request) {
  try {
    if (!cantonSwapQuoteRateLimitOk(clientIpFromRequest(req))) {
      return NextResponse.json({ error: "rate limit exceeded" }, { status: 429 });
    }

    const body = await req.json();
    const fromAsset = parseMvpAsset(body.fromAsset);
    const toAsset = parseMvpAsset(body.toAsset);
    const amount = body.amount ?? body.inAmount;
    if (!fromAsset || !toAsset || amount == null) {
      return NextResponse.json(
        { error: "missing fromAsset / toAsset / amount" },
        { status: 400 }
      );
    }
    const q = await quoteMvpCantonSwap(fromAsset, toAsset, String(amount));
    return NextResponse.json({
      fromAsset,
      toAsset,
      inAmount: q.inAmount,
      outAmount: q.outAmount,
      feeBps: q.feeBps,
      bridgeFeeBps: q.feeBps,
      expires: q.expiresAt,
      quoteSource: q.source
    });
  } catch (e) {
    if (e instanceof CantonQuoteSanityError) {
      return NextResponse.json({ error: e.userMessage }, { status: 503 });
    }
    if (e instanceof CantonQuoteUnavailableError) {
      return NextResponse.json(
        { error: cantonQuoteUnavailableUserMessage(e.message) },
        { status: 503 }
      );
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 }
    );
  }
}
