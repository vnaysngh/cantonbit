/**
 * GET /api/canton/swap/pending?status=user_locked — daemon poll list.
 */
import { NextResponse } from "next/server";

import { cantonSwapService } from "@/lib/canton-swap-service";
import type { CantonSwapStatus } from "@/lib/canton-swap-types";
import { requireDaemon } from "@/lib/htlc-auth";

export const dynamic = "force-dynamic";

const ALLOWED: CantonSwapStatus[] = ["user_locked", "open", "filling"];

export async function GET(req: Request) {
  const auth = requireDaemon(req);
  if (auth.error) return auth.error;
  const status = new URL(req.url).searchParams.get("status") as CantonSwapStatus;
  if (!ALLOWED.includes(status)) {
    return NextResponse.json({ error: "invalid status" }, { status: 400 });
  }
  const orders = await cantonSwapService().listByStatus(status);
  return NextResponse.json({ orders });
}
