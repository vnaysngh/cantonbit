import { NextResponse } from "next/server";

import { getHoldings } from "@/lib/canton";

export const dynamic = "force-dynamic";

const TAG = "[canton/holdings]";

/**
 * GET /api/canton/holdings?partyId=<party>
 *
 * Returns Holding interface views for the given party, queried via the
 * app's m2m JWT. Returns [] when the party has no cBTC OR when the
 * Holding interface isn't installed on this validator — those two cases
 * look the same from the wire, which is intentional.
 */
export async function GET(request: Request) {
  console.log(`${TAG} request received`);
  const url = new URL(request.url);
  const partyId = url.searchParams.get("partyId");

  console.log(`${TAG} partyId=${partyId ? partyId.slice(0, 40) + "..." : "MISSING"}`);

  if (!partyId) {
    console.error(`${TAG} missing partyId query param`);
    return NextResponse.json(
      { error: "Missing required query param: partyId" },
      { status: 400 },
    );
  }

  try {
    const holdings = await getHoldings(partyId);
    console.log(`${TAG} returning ${holdings.length} holdings for partyId=${partyId.slice(0, 40)}...`);
    for (const h of holdings) {
      console.log(`${TAG} holding contractId=${h.contractId} payload=${JSON.stringify(h.payload)}`);
    }
    return NextResponse.json({
      partyId,
      count: holdings.length,
      holdings,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${TAG} error:`, err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
