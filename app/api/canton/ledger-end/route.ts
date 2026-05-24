import { NextResponse } from "next/server";

import { getLedgerEnd } from "@/lib/canton";

export const dynamic = "force-dynamic";

/**
 * GET /api/canton/ledger-end
 *
 * Returns the current Canton ledger offset for the configured network.
 * Thin wrapper around lib/canton.ts → no business logic. JWT auth is
 * handled server-side by getLedgerJwt() inside ledgerFetch.
 */
export async function GET() {
  try {
    const offset = await getLedgerEnd();
    return NextResponse.json({ offset });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
