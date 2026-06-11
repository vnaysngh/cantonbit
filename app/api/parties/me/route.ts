/**
 * GET /api/parties/me — return the authenticated user's participant-managed Canton
 * party (on our warpx node). If they don't have one yet (or have an old wrong-
 * participant one), this provisions/repoints it via the same logic as /provision.
 * Used by the /swap UI to set the cBTC recipient = the session party (not Loop).
 */
import { NextResponse } from "next/server";

import { createSupabaseServerClient, createSupabaseServiceClient } from "@/lib/supabase/server";
import { onboardParticipantManagedParty } from "@/lib/party-onboarding";
import { NETWORK } from "@/lib/constants";

function warpxNs(): string {
  return NETWORK.warpxPartyId.split("::")[1] ?? "";
}

export async function GET() {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ partyId: null, authed: false });

    const service = await createSupabaseServiceClient();
    const ns = warpxNs();

    const { data: row } = await service
      .from("party_mappings")
      .select("canton_party_id, party_hint")
      .eq("user_id", user.id)
      .maybeSingle();

    const current = (row?.canton_party_id as string | undefined) ?? undefined;
    const currentNs = current?.split("::")[1] ?? "";

    // NEVER convert a Loop-wallet user to a warpx party. An email is locked to its
    // first auth method; a 'loop-wallet' mapping means this user signs via Loop.
    if (current && row?.party_hint === "loop-wallet") {
      return NextResponse.json({ partyId: current, authed: true, mode: "loop" });
    }

    // Right participant already — return it.
    if (current && ns && currentNs === ns) {
      return NextResponse.json({ partyId: current, authed: true, mode: "participant-managed" });
    }

    // Missing or wrong participant — provision a warpx party now and (re)bind it.
    const { party } = await onboardParticipantManagedParty();
    if (current) {
      await service.from("party_mappings")
        .update({ canton_party_id: party, party_hint: "participant-managed" })
        .eq("user_id", user.id);
    } else {
      await service.from("party_mappings")
        .insert({ user_id: user.id, canton_party_id: party, party_hint: "participant-managed" });
    }
    return NextResponse.json({ partyId: party, authed: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
