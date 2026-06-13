/**
 * POST /api/htlc — create an HTLC swap order (Cancore step 1).
 * Order history is GET /api/htlc/history (authenticated), not this route.
 *
 * The user has generated the secret client-side and committed to H + timelocks in
 * a signed order; this records the order server-side so the solver can match it.
 */
import { NextResponse } from "next/server";
import { htlcService } from "@/lib/htlc-service-singleton";
import { assertValidTimelocks } from "@/lib/htlc-timelock";
import { assertOrderAmounts, QuoteUnavailableError, DepegError } from "@/lib/htlc-quote";
import { expectedSolverCanton, expectedSolverEvm, isParticipantManagedParty, requirePartyOwner } from "@/lib/htlc-auth";

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
    if (body.direction !== "evm-to-canton" && body.direction !== "canton-to-evm") {
      return NextResponse.json({ error: "invalid direction" }, { status: 400 });
    }
    const partyAuth = await requirePartyOwner(String(body.userCantonParty));
    if (partyAuth.error) return partyAuth.error;
    const solverCanton = expectedSolverCanton();
    if (solverCanton && body.solverCantonParty !== solverCanton) {
      return NextResponse.json({ error: "solver Canton party mismatch" }, { status: 403 });
    }
    const solverEvm = expectedSolverEvm();
    if (solverEvm && String(body.solverEvmAddress).toLowerCase() !== solverEvm.toLowerCase()) {
      return NextResponse.json({ error: "solver EVM address mismatch" }, { status: 403 });
    }
    // SECURITY — never trust client timelocks. The party who reveals the secret
    // SECOND must have the longer window; userTimelock is the longer leg in BOTH
    // directions. A hostile client that inverts the ladder (or skips the gap) is
    // rejected here, closing the "claim-then-refund both legs" robbery.
    assertValidTimelocks(Math.floor(Date.now() / 1000), Number(body.userTimelock), Number(body.solverTimelock));
    // SECURITY — re-quote NOW and reject a manipulated/stale amount ratio. The
    // client can't submit an output more favorable than a fresh quote (+tolerance).
    const cbtcUnits = BigInt(Math.round(parseFloat(String(body.cbtcAmount)) * 1e8));
    await assertOrderAmounts(body.direction, BigInt(body.wbtcAmount), cbtcUnits);
    // AUTHORITATIVE counterMode — participant-managed (email) vs Loop external wallet.
    body.counterMode = (await isParticipantManagedParty(String(body.userCantonParty)))
      ? "managed"
      : "loop";
    const order = await htlcService().createOrder(body);
    return NextResponse.json({ order });
  } catch (e) {
    // Price unavailable / de-pegged → 503 so the page shows "swaps paused" not a hard error.
    if (e instanceof QuoteUnavailableError || e instanceof DepegError) {
      return NextResponse.json({ error: e.message }, { status: 503 });
    }
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
