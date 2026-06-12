/**
 * POST /api/htlc/{id}/prepare-accept — build the LOOP user's standard
 * TransferInstruction_Accept command (no body).
 *
 * Returns { command, disclosedContracts, synchronizerId } for the browser to submit
 * via the user's Loop wallet (provider.submitAndWaitForTransaction). This is a
 * STANDARD Splice choice that runs on Loop's node — no custom DAR. The user
 * accepting the CBTC transfer is their only Canton action; the secret/claim logic
 * (claiming the WBTC) stays on our node (the solver). Loop's Option 1.
 */
import { NextResponse } from "next/server";
import { htlcService } from "@/lib/htlc-service-singleton";
import { requireOrderOwner } from "@/lib/htlc-auth";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const auth = await requireOrderOwner(id);
    if (auth.error) return auth.error;
    const { command, disclosedContracts, synchronizerId } =
      await htlcService().prepareLoopAccept(id);
    return NextResponse.json({ command, disclosedContracts, synchronizerId });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 }
    );
  }
}
