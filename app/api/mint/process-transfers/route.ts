/**
 * POST /api/mint/process-transfers
 *
 * Triggers the mint processor — scans for new Holdings on the warpx party
 * since the last processed offset and transfers them to the correct user parties.
 *
 * Auth (either is accepted):
 *   1. External cron worker — Authorization: Bearer $CRON_SECRET header
 *      (CRON_SECRET set in the deployment env; rotate periodically)
 *   2. Authenticated user session — valid Supabase auth cookie
 *      (so the mint page can trigger it after detecting a balance change)
 *
 * Requests without either of those return 401 to prevent unauthenticated
 * callers from flooding the ledger API.
 */

import { NextResponse, type NextRequest } from "next/server";

import { processMintTransfers } from "@/lib/mint-processor";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const TAG = "[mint/process-transfers]";

/** Constant-time comparison to avoid leaking secret length via timing. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

async function isAuthorized(request: NextRequest): Promise<boolean> {
  // Path 1: cron worker bearer token
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const header = request.headers.get("authorization") ?? "";
    const prefix = "Bearer ";
    if (header.startsWith(prefix)) {
      const presented = header.slice(prefix.length);
      if (safeEqual(presented, cronSecret)) return true;
    }
  }

  // Path 2: authenticated Supabase session (user-triggered from the mint page)
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (user) return true;
  } catch {
    // fall through to deny
  }

  return false;
}

export async function POST(request: NextRequest) {
  console.log(`${TAG} request received`);

  if (!(await isAuthorized(request))) {
    console.warn(`${TAG} unauthorized request rejected`);
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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
