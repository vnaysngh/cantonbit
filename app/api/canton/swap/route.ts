/**
 * POST /api/canton/swap — create intent order.
 */
import { NextResponse } from "next/server";

import { cantonSwapService } from "@/lib/canton-swap-service";
import type { CantonSwapMvpAssetId, CantonSwapWalletMode } from "@/lib/canton-swap-types";
import {
  expectedSolverCanton,
  isParticipantManagedParty,
  requirePartyOwner
} from "@/lib/htlc-auth";
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
    const walletModeRaw = String(body.walletMode ?? body.counterMode ?? "managed");

    if (!fromAsset || !toAsset || !inAmount || !outAmount || !userParty) {
      return NextResponse.json({ error: "missing fields" }, { status: 400 });
    }
    if (fromAsset === toAsset) {
      return NextResponse.json({ error: "same asset" }, { status: 400 });
    }

    const auth = await requirePartyOwner(userParty);
    if (auth.error) return auth.error;

    const managed = await isParticipantManagedParty(userParty);
    let walletMode: CantonSwapWalletMode;
    if (managed) {
      // Participant-managed parties always settle via backend — never Loop workflow.
      walletMode = "managed";
    } else if (walletModeRaw === "managed") {
      return NextResponse.json(
        { error: "managed mode requires participant-managed party" },
        { status: 400 }
      );
    } else {
      walletMode = "loop";
    }

    const order = await cantonSwapService().createOrder({
      fromAsset,
      toAsset,
      inAmount,
      outAmount,
      userParty,
      walletMode,
      orderId: typeof body.id === "string" ? body.id : undefined
    });

    return NextResponse.json({
      order,
      solverParty: expectedSolverCanton()
    });
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
