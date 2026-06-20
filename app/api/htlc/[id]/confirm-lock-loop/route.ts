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
    const rawMax = body.maxAttempts != null ? Number(body.maxAttempts) : undefined;
    const rawPoll = body.pollMs != null ? Number(body.pollMs) : undefined;
    const maxAttempts =
      rawMax != null && Number.isFinite(rawMax)
        ? Math.min(30, Math.max(1, Math.floor(rawMax)))
        : undefined;
    const pollMs =
      rawPoll != null && Number.isFinite(rawPoll)
        ? Math.min(5000, Math.max(500, Math.floor(rawPoll)))
        : undefined;
    const order = await htlcService().confirmLoopSellerLock(id, {
      maxAttempts,
      pollMs
    });
    return NextResponse.json({ order });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
