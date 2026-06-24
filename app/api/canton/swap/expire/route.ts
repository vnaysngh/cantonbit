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
  const expiredManaged = await cantonSwapService().reconcileExpiredManaged();
  const failedLoop = await cantonSwapService().reconcileFailedLoop();
  const filling = await cantonSwapService().reconcileFilling();
  const counters = await cantonSwapService().reconcileLoopCounters();
  const filledProof = await cantonSwapService().reconcileFilledLoopCounterProof();
  const feeAccounting =
    await cantonSwapService().reconcileNetworkFeeAccounting();
  const expired = await cantonSwapService().expireStale();
  return NextResponse.json({
    reconciled,
    expiredManaged,
    failedLoop,
    filling,
    counters,
    filledProof,
    feeAccounting,
    expired
  });
}
