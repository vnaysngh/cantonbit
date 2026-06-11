/**
 * POST /api/htlc/{id}/claim-counter — THE USER'S REVEAL (Cancore step 6).
 * Body: { preimage } (hex string of the raw secret bytes, no 0x).
 *
 * The user submits the preimage they generated. The backend verifies
 * keccak256(preimage)==hashLock (the orchestrator hash gate, since cBTC has no
 * on-ledger hashlock), releases the cBTC to the user, and stores the preimage so
 * the solver can claim the EVM "main" leg (step 7).
 *
 * Returns 400 "invalid preimage" if it doesn't match — exactly like Cancore.
 */
import { NextResponse } from "next/server";
import { htlcService } from "@/lib/htlc-service-singleton";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const { preimage } = await req.json();
    if (!preimage) return NextResponse.json({ error: "missing preimage" }, { status: 400 });
    const { order, updateId } = await htlcService().claimCounter(id, preimage);
    return NextResponse.json({ order, updateId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = msg.includes("invalid preimage") ? 400 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
