/**
 * POST /api/mint/process-transfers
 *
 * Triggers the mint processor — scans for new Holdings on the warpx party
 * since the last processed offset and transfers them to the correct user parties.
 *
 * Auth: daemon bearer only (HTLC_DAEMON_SECRET / CRON_SECRET / API_AUTH_TOKEN).
 * User sessions must not trigger the global processor (ledger-load amplification).
 */

import { NextResponse, type NextRequest } from "next/server";

import { processMintTransfers } from "@/lib/mint-processor";
import { requireDaemon } from "@/lib/htlc-auth";

const TAG = "[mint/process-transfers]";

export async function POST(request: NextRequest) {
  console.log(`${TAG} request received`);

  const auth = requireDaemon(request);
  if (auth.error) return auth.error;

  // Daemon/cron callers are bearer-authenticated; skip IP rate limit (no XFF on internal calls).

  try {
    const result = await processMintTransfers();
    console.log(`${TAG} result:`, JSON.stringify(result));
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${TAG} unexpected error:`, err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
