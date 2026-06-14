/**
 * POST /api/htlc/quote — RFQ-style quote for cross-chain WBTC↔CBTC swaps.
 */
import { NextResponse } from "next/server";
import { requirePartyOwner } from "@/lib/htlc-auth";
import {
  quoteWbtcToCbtc,
  quoteCbtcToWbtc,
  QuoteUnavailableError,
  DepegError
} from "@/lib/htlc-quote";
import { NETWORK } from "@/lib/constants";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { user, wbtcAmount, cbtcAmount, cantonParty, direction } = body;

    const reverse = direction === "canton-to-evm";
    const inRaw = reverse ? cbtcAmount : wbtcAmount;
    if (!user || !inRaw || !cantonParty) {
      return NextResponse.json(
        { error: "missing user / amount / cantonParty" },
        { status: 400 }
      );
    }
    const partyAuth = await requirePartyOwner(String(cantonParty));
    if (partyAuth.error) return partyAuth.error;
    const inUnits = BigInt(inRaw);
    if (inUnits <= 0n) {
      return NextResponse.json({ error: "amount must be > 0" }, { status: 400 });
    }

    const q = reverse
      ? await quoteCbtcToWbtc(inUnits)
      : await quoteWbtcToCbtc(inUnits);

    const order = {
      inputs: [["0", q.inUnits.toString()]],
      outputs: [{ amount: q.outUnits.toString() }]
    };
    return NextResponse.json({
      order,
      direction: reverse ? "canton-to-evm" : "evm-to-canton",
      cantonParty,
      cbtcAmount: (reverse ? q.inUnits : q.outUnits).toString(),
      wbtcAmount: (reverse ? q.outUnits : q.inUnits).toString(),
      wbtc: "",
      wbtcPriceRaw: q.price8.toString(),
      wbtcPriceDecimals: 8,
      expires: q.expiresAt,
      feeBps: q.feeBps,
      bridgeFeeBps: q.feeBps,
      instrument: NETWORK.instrumentId
    });
  } catch (e) {
    if (e instanceof DepegError || e instanceof QuoteUnavailableError) {
      return NextResponse.json({ error: e.message }, { status: 503 });
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 }
    );
  }
}
