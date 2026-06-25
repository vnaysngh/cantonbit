import { NextResponse } from "next/server";

import { getLedgerJwt } from "@/lib/auth";
import { requireDaemon } from "@/lib/htlc-auth";
import { NETWORK } from "@/lib/constants";

export const dynamic = "force-dynamic";

/**
 * GET /api/canton/packages/<id>
 *
 * Debug helper: fetches the package reference (name + version) for a single
 * package id, so we can confirm the participant's package list endpoint
 * actually returns sensible metadata.
 *
 * AUTH: daemon-only. This exercises the privileged validator ledger JWT, so it
 * must never be reachable unauthenticated.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = requireDaemon(request);
  if (auth.error) return auth.error;
  const { id } = await ctx.params;
  const segment = encodeURIComponent(id);
  try {
    const jwt = await getLedgerJwt();
    // Try a few endpoints since Canton versions vary.
    const candidates = [
      `${NETWORK.ledgerHost}/v2/packages/${segment}/reference`,
      `${NETWORK.ledgerHost}/v2/packages/${segment}/status`,
      `${NETWORK.ledgerHost}/v2/packages/${segment}`,
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
