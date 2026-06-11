/**
 * POST /api/htlc/{id}/claim-prepare — build the USER's HtlcLock.Claim command.
 * Body: { preimage }. Returns { command, disclosedContracts } for the browser to
 * submit via the user's Loop wallet (provider.submitTransaction). The backend does
 * NOT submit — the Claim is controller=receiver, so only the user's wallet can
 * sign it (their participant supplies the receiver authority; Preapproval accepts).
 */
import { NextResponse } from "next/server";
import { htlcService } from "@/lib/htlc-service-singleton";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const { preimage } = await req.json();
    if (!preimage) return NextResponse.json({ error: "missing preimage" }, { status: 400 });
    const { command, disclosedContracts, synchronizerId } = await htlcService().prepareClaim(id, preimage);
    return NextResponse.json({ command, disclosedContracts, synchronizerId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = msg.includes("invalid preimage") ? 400 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
