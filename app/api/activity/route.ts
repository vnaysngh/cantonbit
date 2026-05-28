/**
 * GET /api/activity
 *
 * Returns recent on-ledger activity rows (mint / redeem / send / receive)
 * for the authenticated user's Canton party.
 *
 * Auth: Supabase session cookie. The party is resolved from the session;
 * the client never names a party — that would let any user enumerate any
 * party's history.
 */

import { NextResponse } from "next/server";

import { getActivityForParty } from "@/lib/activity";
import {
  createSupabaseServerClient,
  createSupabaseServiceClient,
} from "@/lib/supabase/server";

const TAG = "[activity]";

export const dynamic = "force-dynamic";

export async function GET() {
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
    return NextResponse.json({ activity: [] });
  }

  try {
    const activity = await getActivityForParty(partyRow.canton_party_id);
    return NextResponse.json({ activity });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${TAG} failed:`, err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
