/**
 * POST /api/mint/process-transfers
 *
 * Triggers the mint processor — scans for new Holdings on the warpx party
 * since the last processed offset and transfers them to the correct user parties.
 *
 * Called by the cron job every 60 seconds.
 * Can also be triggered manually for testing.
 */

import { NextResponse } from "next/server";

import { processMintTransfers } from "@/lib/mint-processor";

const TAG = "[mint/process-transfers]";

export async function POST() {
  console.log(`${TAG} request received`);

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
