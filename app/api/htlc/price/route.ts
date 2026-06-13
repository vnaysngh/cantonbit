/**
 * GET /api/htlc/price — live WBTC/BTC + platform fee for form estimates.
 * Same price cache as POST /api/htlc/quote (lib/htlc-quote.ts).
 */
import { NextResponse } from "next/server";
import {
  getWbtcBtcPrice8,
  BRIDGE_FEE_BPS,
  QuoteUnavailableError,
  DepegError
} from "@/lib/htlc-quote";

export async function GET() {
  try {
    const price8 = await getWbtcBtcPrice8();
    return NextResponse.json({
      wbtcPriceRaw: price8.toString(),
      wbtcPriceDecimals: 8,
      feeBps: BRIDGE_FEE_BPS
    });
  } catch (e) {
    if (e instanceof DepegError || e instanceof QuoteUnavailableError) {
      return NextResponse.json({ error: e.message }, { status: 503 });
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
