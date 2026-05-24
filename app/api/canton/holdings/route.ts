import { NextResponse } from "next/server";

import { getHoldings } from "@/lib/canton";

export const dynamic = "force-dynamic";

/**
 * GET /api/canton/holdings?partyId=<party>
 *
 * Returns Holding interface views for the given party, queried via the
 * app's m2m JWT. Returns [] when the party has no cBTC OR when the
 * Holding interface isn't installed on this validator — those two cases
 * look the same from the wire, which is intentional.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const partyId = url.searchParams.get("partyId");

  if (!partyId) {
    return NextResponse.json(
      { error: "Missing required query param: partyId" },
      { status: 400 },
    );
  }

  try {
    const holdings = await getHoldings(partyId);
    return NextResponse.json({
      partyId,
      count: holdings.length,
      holdings,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
