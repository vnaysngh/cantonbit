/**
 * POST /api/transfers/accept
 *
 * Phase 2: receiver accepts an incoming TransferOffer. The receiver party is
 * resolved from the authenticated user's Supabase mapping — the client only
 * sends the offer contract id. This prevents accepting on behalf of someone else.
 *
 * Body: { offerContractId: string }
 * Response: { updateId }
 */

import { NextResponse } from "next/server";

import { requireManagedTransferSession } from "@/lib/transfer-session";
import {
  acceptTransfer,
  listPendingOffers,
  registryKindForInstrument
} from "@/lib/transfer";
import { getDsoPartyId } from "@/lib/cc-registry";
import { NETWORK } from "@/lib/constants";

const TAG = "[transfers/accept]";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  console.log(`${TAG} request received`);

  const session = await requireManagedTransferSession();
  if (session.error) return session.error;
  const receiverParty = session.partyId;

  let body: { offerContractId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const offerContractId =
    typeof body.offerContractId === "string" ? body.offerContractId.trim() : "";
  if (!offerContractId) {
    return NextResponse.json(
      { error: "offerContractId is required" },
      { status: 400 }
    );
  }

  try {
    const offers = await listPendingOffers(receiverParty);
    const match = offers.find((o) => o.contractId === offerContractId);
    if (!match) {
      return NextResponse.json(
        { error: "No pending offer with that contract id for this party" },
        { status: 404 }
      );
    }

    const registryKind = registryKindForInstrument(match.instrumentId);
    const registrarAdmin =
      registryKind === "cc"
        ? match.instrumentId?.admin ?? (await getDsoPartyId())
        : NETWORK.decentralizedPartyId;

    const result = await acceptTransfer({
      receiverParty,
      offerContractId,
      registrarAdmin,
      registryKind
    });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${TAG} acceptTransfer failed:`, err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
