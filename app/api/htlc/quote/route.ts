/**
 * POST /api/htlc/quote — HTLC-native quote (no dependency on the old solver).
 *
 * Computes the cBTC output for a WBTC input: rate 1:1 minus a small bridge fee.
 * Returns the same shape the /swap page's QuoteResponse expects (order with
 * inputs/outputs, cantonParty, wbtc, cbtcAmount, price, expires), so the page
 * renders without changes.
 *
 * Body: { user, wbtcAmount (base units 8dp string), cantonParty }
 */
import { NextResponse } from "next/server";
import { NETWORK } from "@/lib/constants";

const BRIDGE_FEE_BPS = 20; // 0.2%
const WINDOW_SECONDS = 4 * 60 * 60;

export async function POST(req: Request) {
  try {
    const { user, wbtcAmount, cantonParty } = await req.json();
    if (!user || !wbtcAmount || !cantonParty) {
      return NextResponse.json({ error: "missing user / wbtcAmount / cantonParty" }, { status: 400 });
    }
    const wbtcUnits = BigInt(wbtcAmount); // base units (8dp)
    if (wbtcUnits <= 0n) return NextResponse.json({ error: "amount must be > 0" }, { status: 400 });

    // 1:1 rate, minus bridge fee → cBTC output (same 8dp base units).
    const cbtcUnits = wbtcUnits - (wbtcUnits * BigInt(BRIDGE_FEE_BPS)) / 10000n;
    const cbtcAmount = cbtcUnits.toString();

    const now = Math.floor(Date.now() / 1000);
    const expires = now + WINDOW_SECONDS;

    // Minimal order shape the page reads: inputs[0]=[token,amount], outputs[0].amount.
    const wbtcAddrAsUint = "0"; // page only reads inputs[0][1] (amount); token id unused here
    const order = {
      inputs: [[wbtcAddrAsUint, wbtcUnits.toString()]],
      outputs: [{ amount: cbtcUnits.toString() }],
    };

    return NextResponse.json({
      order,
      cantonParty,
      cbtcAmount,
      wbtc: "", // page falls back to SWAP_CHAIN.wbtc for the lock
      wbtcPriceRaw: "100000000", // 1:1 display
      wbtcPriceDecimals: 8,
      expires,
      // a couple of fields the page may read for display; harmless defaults
      bridgeFeeBps: BRIDGE_FEE_BPS,
      instrument: NETWORK.instrumentId,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
