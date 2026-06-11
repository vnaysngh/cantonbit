/**
 * POST /api/htlc — create an HTLC swap order (Cancore step 1).
 * GET  /api/htlc — list orders (debug / order book).
 *
 * The user has generated the secret client-side and committed to H + timelocks in
 * a signed order; this records the order server-side so the solver can match it.
 */
import { NextResponse } from "next/server";
import { htlcService } from "@/lib/htlc-service-singleton";
import { NETWORK } from "@/lib/constants";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const required = [
      "id", "direction", "hashLock", "userEvmAddress", "solverEvmAddress",
      "wbtcAmount", "userTimelock", "userCantonParty", "solverCantonParty",
      "cbtcAmount", "solverTimelock",
    ];
    for (const k of required) {
      if (body[k] === undefined) return NextResponse.json({ error: `missing ${k}` }, { status: 400 });
    }
    // AUTHORITATIVE counterMode — derived from WHERE the receiver party lives, not
    // from the client (a UI race once sent "loop" for a warpx-hosted party). A party
    // in OUR warpx namespace → managed (on-ledger HtlcLock, backend CanActAs claim);
    // anything else (e.g. a Loop party) → loop (standard transfer + auto-accept).
    const warpxNs = NETWORK.warpxPartyId.split("::")[1] ?? "";
    const receiverNs = String(body.userCantonParty).split("::")[1] ?? "";
    body.counterMode = warpxNs && receiverNs === warpxNs ? "managed" : "loop";
    const order = await htlcService().createOrder(body);
    return NextResponse.json({ order });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
