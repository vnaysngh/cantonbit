/**
 * POST /api/parties/enable-cc — run EnableCC (ValidatorRight + TransferPreapproval)
 * for the authenticated managed user's Canton party. Idempotent.
 */
import { NextResponse } from "next/server";

import {
  getManagedPreapprovalStatus,
  previewManagedSwapReadiness
} from "@/lib/canton-swap-preapproval";
import type { CantonSwapMvpAssetId } from "@/lib/canton-swap-types";
import { enableCcForParty } from "@/lib/enable-cc";
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

    const before = await getManagedPreapprovalStatus(session.partyId);
    if (!before.ccReadyForEnable) {
      return NextResponse.json(
        {
          error: `Deposit at least ${before.ccMinToEnable} CC on your Canton party before enabling CC transfers.`,
          ...before
        },
        { status: 400 }
      );
    }

    await enableCcForParty(session.partyId);
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
      return NextResponse.json({ ...after, swap, enabled: after.ccEnabled });
    }

    return NextResponse.json({ ...after, enabled: after.ccEnabled });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 }
    );
  }
}
