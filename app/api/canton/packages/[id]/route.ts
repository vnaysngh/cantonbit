import { NextResponse } from "next/server";

import { getLedgerJwt } from "@/lib/auth";
import { NETWORK } from "@/lib/constants";

export const dynamic = "force-dynamic";

/**
 * GET /api/canton/packages/<id>
 *
 * Debug helper: fetches the package reference (name + version) for a single
 * package id, so we can confirm the participant's package list endpoint
 * actually returns sensible metadata.
 */
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  try {
    const jwt = await getLedgerJwt();
    // Try a few endpoints since Canton versions vary.
    const candidates = [
      `${NETWORK.ledgerHost}/v2/packages/${id}/reference`,
      `${NETWORK.ledgerHost}/v2/packages/${id}/status`,
      `${NETWORK.ledgerHost}/v2/packages/${id}`,
    ];
    const probes: Array<{ url: string; status: number; body: string }> = [];
    for (const url of candidates) {
      const r = await fetch(url, {
        headers: { authorization: `Bearer ${jwt}` },
        cache: "no-store",
      });
      const body = await r.text();
      probes.push({ url, status: r.status, body: body.slice(0, 500) });
    }
    return NextResponse.json({ id, probes });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
