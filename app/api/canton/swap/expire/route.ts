/**
 * POST /api/canton/swap/expire — daemon: reconcile then expire (never before fill pass).
 */
import { NextResponse } from "next/server";

import { cantonSwapService } from "@/lib/canton-swap-service";
import { requireDaemon } from "@/lib/htlc-auth";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const auth = requireDaemon(req);
  if (auth.error) return auth.error;
  const reconciled = await cantonSwapService().reconcileSettling();
  const counters = await cantonSwapService().reconcileLoopCounters();
  const expired = await cantonSwapService().expireStale();
  return NextResponse.json({ reconciled, counters, expired });
}
