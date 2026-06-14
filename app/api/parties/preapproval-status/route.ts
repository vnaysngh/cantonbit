/**
 * GET /api/parties/preapproval-status — CC EnableCC status for managed (email) users.
 * Optional swap preview: ?fromAsset=CBTC&toAsset=CC&inAmount=0.001&outAmount=1
 */
import { NextResponse } from "next/server";

import {
  getManagedPreapprovalStatus,
  previewManagedSwapReadiness
} from "@/lib/canton-swap-preapproval";
import type { CantonSwapMvpAssetId } from "@/lib/canton-swap-types";
import { requireManagedTransferSession } from "@/lib/transfer-session";

export const dynamic = "force-dynamic";

function parseMvpAsset(raw: string | null): CantonSwapMvpAssetId | null {
  if (raw === "CBTC" || raw === "CC") return raw;
  return null;
}

export async function GET(req: Request) {
  try {
    const session = await requireManagedTransferSession();
    if (session.error) return session.error;

    const status = await getManagedPreapprovalStatus(session.partyId);
    const url = new URL(req.url);
    const fromAsset = parseMvpAsset(url.searchParams.get("fromAsset"));
    const toAsset = parseMvpAsset(url.searchParams.get("toAsset"));
    const inAmount = url.searchParams.get("inAmount")?.trim();
    const outAmount = url.searchParams.get("outAmount")?.trim();

    if (fromAsset && toAsset && inAmount && outAmount) {
      const swap = await previewManagedSwapReadiness({
        userParty: session.partyId,
        fromAsset,
        toAsset,
        inAmount,
        outAmount
      });
      return NextResponse.json({ ...status, swap });
    }

    return NextResponse.json(status);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
