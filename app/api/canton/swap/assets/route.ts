import { NextResponse } from "next/server";

import { CBTC_ASSET, CC_ASSET } from "@/lib/canton-assets";

export const dynamic = "force-dynamic";

/** MVP swap assets: CBTC + CC only. */
export async function GET() {
  const assets = [CBTC_ASSET, CC_ASSET].map((a) => ({
    id: a.id,
    symbol: a.symbol,
    label: a.label,
    decimals: a.decimals
  }));
  return NextResponse.json({ assets });
}
