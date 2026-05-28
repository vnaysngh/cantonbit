/**
 * GET /api/transfers/pending
 *
 * List active TransferOffers where the authenticated user is the receiver.
 * Used by the Receive page to show Accept buttons.
 *
 * Response: { offers: PendingOffer[] }
 */

import { NextResponse } from "next/server";

import { createSupabaseServerClient, createSupabaseServiceClient } from "@/lib/supabase/server";
import { listPendingOffers } from "@/lib/transfer";

const TAG = "[transfers/pending]";

export const dynamic = "force-dynamic";

export async function GET() {
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
    return NextResponse.json({ offers: [] });
  }
  const receiverParty = partyRow.canton_party_id as string;

  try {
    const offers = await listPendingOffers(receiverParty);
    return NextResponse.json({ offers });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${TAG} listPendingOffers failed:`, err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
