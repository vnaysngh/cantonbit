/**
 * POST /api/parties/enable-cbtc — CBTC utility TransferPreapproval for managed users.
 */
import { NextResponse } from "next/server";

import {
  getManagedPreapprovalStatus,
  previewManagedSwapReadiness
} from "@/lib/canton-swap-preapproval";
import type { CantonSwapMvpAssetId } from "@/lib/canton-swap-types";
import { enableCbtcPreapprovalForParty } from "@/lib/enable-cbtc-preapproval";
import { requireManagedTransferSession } from "@/lib/transfer-session";

export const dynamic = "force-dynamic";

function parseMvpAsset(raw: unknown): CantonSwapMvpAssetId | null {
  if (raw === "CBTC" || raw === "CC") return raw;
  return null;
}

export async function POST(req: Request) {
  try {
    const session = await requireManagedTransferSession();
    if (session.error) return session.error;

    await enableCbtcPreapprovalForParty(session.partyId);
    const after = await getManagedPreapprovalStatus(session.partyId);

    let body: Record<string, unknown> = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }
    const fromAsset = parseMvpAsset(body.fromAsset);
    const toAsset = parseMvpAsset(body.toAsset);
    const inAmount =
      typeof body.inAmount === "string" ? body.inAmount.trim() : "";
    const outAmount =
      typeof body.outAmount === "string" ? body.outAmount.trim() : "";

    if (fromAsset && toAsset && inAmount && outAmount) {
      const swap = await previewManagedSwapReadiness({
        userParty: session.partyId,
        fromAsset,
        toAsset,
        inAmount,
        outAmount
      });
      return NextResponse.json({ ...after, swap, enabled: after.cbtcEnabled });
    }

    return NextResponse.json({ ...after, enabled: after.cbtcEnabled });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 }
    );
  }
}
