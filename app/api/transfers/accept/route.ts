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

import { createSupabaseServerClient, createSupabaseServiceClient } from "@/lib/supabase/server";
import { acceptTransfer, listPendingOffers } from "@/lib/transfer";

const TAG = "[transfers/accept]";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  console.log(`${TAG} request received`);

  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const serviceClient = await createSupabaseServiceClient();
  const { data: partyRow } = await serviceClient
    .from("party_mappings")
    .select("canton_party_id")
    .eq("user_id", user.id)
    .single();
  if (!partyRow?.canton_party_id) {
    return NextResponse.json(
      { error: "No Canton party allocated for this account" },
      { status: 400 },
    );
  }
  const receiverParty = partyRow.canton_party_id as string;

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
      { status: 400 },
    );
  }

  try {
    // Verify the offer actually exists for this receiver — protects against a
    // user passing an arbitrary contract id and getting an opaque ledger error.
    const offers = await listPendingOffers(receiverParty);
    const match = offers.find((o) => o.contractId === offerContractId);
    if (!match) {
      return NextResponse.json(
        { error: "No pending offer with that contract id for this party" },
        { status: 404 },
      );
    }

    const result = await acceptTransfer({ receiverParty, offerContractId });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${TAG} acceptTransfer failed:`, err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
