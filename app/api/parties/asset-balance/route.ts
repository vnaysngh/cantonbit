/**
 * GET /api/parties/asset-balance?asset=CBTC|CC|USDCX — session party balance for one instrument.
 */
import { NextResponse } from "next/server";

import { fromBaseUnits } from "@/lib/amount-units";
import { getSwapAsset, parseSwapAssetId } from "@/lib/canton-assets";
import { holdingsForSwapAsset } from "@/lib/canton-swap-holdings";
import { requirePartyOwner } from "@/lib/htlc-auth";
import {
  createSupabaseServerClient,
  createSupabaseServiceClient
} from "@/lib/supabase/server";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const assetId = parseSwapAssetId(url.searchParams.get("asset"));
    if (!assetId) {
      return NextResponse.json({ error: "invalid asset" }, { status: 400 });
    }

    const supabase = await createSupabaseServerClient();
    const {
      data: { user }
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "not authenticated" }, { status: 401 });
    }
    const service = await createSupabaseServiceClient();
    const { data: row } = await service
      .from("party_mappings")
      .select("canton_party_id")
      .eq("user_id", user.id)
      .maybeSingle();
    const party = row?.canton_party_id as string | undefined;
    if (!party) {
      return NextResponse.json({ total: "0", utxoCount: 0 });
    }

    const auth = await requirePartyOwner(party);
    if (auth.error) return auth.error;

    const asset = getSwapAsset(assetId);
    const holdings = await holdingsForSwapAsset(party, assetId);
    let total = 0n;
    for (const h of holdings) {
      const raw = h.payload.amount ?? "0";
      const n = parseFloat(String(raw));
      if (!Number.isFinite(n)) continue;
      total += BigInt(Math.round(n * 10 ** asset.decimals));
    }
    return NextResponse.json({
      asset: assetId,
      total: fromBaseUnits(total, asset.decimals),
      utxoCount: holdings.length
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
