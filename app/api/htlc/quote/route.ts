/**
 * POST /api/htlc/quote — RFQ-style quote, BOTH directions, price-adjusted.
 *
 * CBTC is 1:1 BTC; WBTC is NOT — so the live WBTC/BTC rate is applied
 * directionally (lib/htlc-quote.ts), with a 20bps fee on the output, a 60s quote
 * TTL, and a 2% de-peg circuit breaker (→ 503, the page shows "swaps paused").
 *
 * Body (forward, unchanged shape): { user, wbtcAmount (8dp units), cantonParty }
 * Body (reverse):                  { user, cbtcAmount (8dp units), cantonParty,
 *                                    direction: "canton-to-evm" }
 */
import { NextResponse } from "next/server";
import { NETWORK } from "@/lib/constants";
import {
  quoteWbtcToCbtc,
  quoteCbtcToWbtc,
  QuoteUnavailableError,
  DepegError
} from "@/lib/htlc-quote";
import { requirePartyOwner } from "@/lib/htlc-auth";

export async function POST(req: Request) {
  try {
    const { user, wbtcAmount, cbtcAmount, cantonParty, direction } =
      await req.json();
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
    if (inUnits <= 0n)
      return NextResponse.json(
        { error: "amount must be > 0" },
        { status: 400 }
      );

    const q = reverse
      ? await quoteCbtcToWbtc(inUnits)
      : await quoteWbtcToCbtc(inUnits);

    // Minimal order shape the page reads: inputs[0]=[token,amount], outputs[0].amount.
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
      wbtc: "", // page falls back to SWAP_CHAIN.wbtc for the lock
      wbtcPriceRaw: q.price8.toString(), // LIVE WBTC/BTC, 8dp
      wbtcPriceDecimals: 8,
      expires: q.expiresAt, // 60s quote TTL (RFQ), not the order window
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
