/**
 * POST /api/htlc/{id}/confirm-lock-loop — LOOP SELLER step 2b: VERIFY the user's
 * allocation landed on-ledger with the right terms (solver's own ACS — never trust
 * the browser) → main_locked. The daemon then locks the WBTC counter.
 */
import { NextResponse } from "next/server";
import { htlcService } from "@/lib/htlc-service-singleton";
import { requireOrderOwner } from "@/lib/htlc-auth";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const auth = await requireOrderOwner(id);
    if (auth.error) return auth.error;
    const body = await req.json().catch(() => ({}));
    const order = await htlcService().confirmLoopSellerLock(id, {
      maxAttempts:
        body.maxAttempts != null ? Number(body.maxAttempts) : undefined,
      pollMs: body.pollMs != null ? Number(body.pollMs) : undefined
    });
    return NextResponse.json({ order });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
