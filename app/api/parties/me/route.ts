/**
 * GET /api/parties/me — return the authenticated user's participant-managed Canton
 * party (on our warpx node). If they don't have one yet (or have an old wrong-
 * participant one), this provisions/repoints it via the same logic as /provision.
 * Used by the /swap UI to set the CBTC recipient = the session party (not Loop).
 */
import { NextResponse } from "next/server";

import {
  createSupabaseServerClient,
  createSupabaseServiceClient
} from "@/lib/supabase/server";
import { NETWORK } from "@/lib/constants";
import {
  formatPartyNetworkMismatch,
  isPartyOnCurrentNetwork
} from "@/lib/party-network";
import { partyMappingEmailPayload, syncPartyMappingEmail, type AuthUserEmail } from "@/lib/party-mapping-email";
import { onboardParticipantManagedParty } from "@/lib/party-onboarding";

const TAG = "[parties/me]";

async function bindParticipantManagedParty(
  service: Awaited<ReturnType<typeof createSupabaseServiceClient>>,
  userId: string,
  current: string | undefined,
  user: AuthUserEmail
): Promise<string> {
  const { party } = await onboardParticipantManagedParty();
  if (current) {
    console.warn(
      `${TAG} repointing user=${userId.slice(0, 8)}… from ${current.slice(0, 28)}… → ${party.slice(0, 28)}… (${NETWORK.name})`
    );
    await service
      .from("party_mappings")
      .update({
        canton_party_id: party,
        party_hint: "participant-managed",
        ...partyMappingEmailPayload(user)
      })
      .eq("user_id", userId);
  } else {
    await service.from("party_mappings").insert({
      user_id: userId,
      canton_party_id: party,
      party_hint: "participant-managed",
      ...partyMappingEmailPayload(user)
    });
  }
  return party;
}

export async function GET() {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user }
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ partyId: null, authed: false });

    const service = await createSupabaseServiceClient();

    const { data: row } = await service
      .from("party_mappings")
      .select("canton_party_id, party_hint")
      .eq("user_id", user.id)
      .maybeSingle();

    const current = (row?.canton_party_id as string | undefined) ?? undefined;

    // NEVER convert a Loop-wallet user to a warpx party. An email is locked to its
    // first auth method; a 'loop-wallet' mapping means this user signs via Loop.
    if (current && row?.party_hint === "loop-wallet") {
      await syncPartyMappingEmail(service, user.id, user);
      return NextResponse.json({
        partyId: current,
        authed: true,
        mode: "loop"
      });
    }

    // Already provisioned participant-managed party on this network — return it.
    if (
      current &&
      row?.party_hint === "participant-managed" &&
      isPartyOnCurrentNetwork(current)
    ) {
      await syncPartyMappingEmail(service, user.id, user);
      return NextResponse.json({
        partyId: current,
        authed: true,
        mode: "participant-managed"
      });
    }

    if (current && row?.party_hint === "participant-managed") {
      console.warn(`${TAG} ${formatPartyNetworkMismatch(current)}`);
    }

    // Missing mapping or wrong-network / legacy hint — provision on current stack.
    const party = await bindParticipantManagedParty(service, user.id, current, user);
    return NextResponse.json({
      partyId: party,
      authed: true,
      mode: "participant-managed"
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
