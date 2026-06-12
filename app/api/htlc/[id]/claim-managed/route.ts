/**
 * POST /api/htlc/{id}/claim-managed — PARTICIPANT-MANAGED claim.
 * Body: { preimage }. The backend claims the cBTC AS the hosted receiver (it has
 * CanActAs over the party). Used for email/password users whose party is on our
 * warpx node — the backend signs HtlcLock.Claim for them (on-ledger keccak gate).
 * The user supplies the preimage at claim time (secret stays client-side until now).
 */
import { NextResponse } from "next/server";
import { htlcService } from "@/lib/htlc-service-singleton";
import { requireOrderOwner } from "@/lib/htlc-auth";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const auth = await requireOrderOwner(id);
    if (auth.error) return auth.error;
    const { preimage } = await req.json();
    if (!preimage) return NextResponse.json({ error: "missing preimage" }, { status: 400 });
    const { order, updateId } = await htlcService().claimCounterAsBackend(id, preimage);
    return NextResponse.json({ ok: true, updateId, status: order.status });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = msg.includes("invalid preimage") ? 400 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
