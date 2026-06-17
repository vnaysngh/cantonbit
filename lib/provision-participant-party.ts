/**
 * Allocate / bind a participant-managed Canton party for the authenticated Supabase user.
 * Shared by POST /api/parties/provision and the OAuth callback.
 */
import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { partyMappingEmailPayload, syncPartyMappingEmail } from "@/lib/party-mapping-email";
import { isPartyOnCurrentNetwork } from "@/lib/party-network";
import { onboardParticipantManagedParty } from "@/lib/party-onboarding";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

const TAG = "[provision-participant-party]";

export async function provisionParticipantManagedPartyForUser(
  supabase: SupabaseClient
): Promise<{ partyId: string; isNew: boolean } | null> {
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) return null;

  const service = await createSupabaseServiceClient();

  const { data: existing } = await service
    .from("party_mappings")
    .select("canton_party_id, party_hint")
    .eq("user_id", user.id)
    .maybeSingle();

  if (existing?.canton_party_id) {
    await syncPartyMappingEmail(service, user.id, user);
    if (existing.party_hint === "loop-wallet") {
      return { partyId: existing.canton_party_id, isNew: false };
    }
    if (
      existing.party_hint === "participant-managed" &&
      isPartyOnCurrentNetwork(existing.canton_party_id)
    ) {
      return { partyId: existing.canton_party_id, isNew: false };
    }
    if (existing.party_hint === "participant-managed") {
      console.warn(
        `${TAG} repointing wrong-network party ${existing.canton_party_id.slice(0, 28)}…`
      );
    }
  }

  const { party } = await onboardParticipantManagedParty();

  if (existing?.canton_party_id) {
    const { error: updErr } = await service
      .from("party_mappings")
      .update({
        canton_party_id: party,
        party_hint: "participant-managed",
        ...partyMappingEmailPayload(user)
      })
      .eq("user_id", user.id);
    if (updErr) throw new Error("Failed to store party mapping");
    return { partyId: party, isNew: true };
  }

  const { error: insErr } = await service.from("party_mappings").insert({
    user_id: user.id,
    canton_party_id: party,
    party_hint: "participant-managed",
    ...partyMappingEmailPayload(user)
  });

  if (insErr) {
    if (insErr.code === "23505") {
      const { data: row } = await service
        .from("party_mappings")
        .select("canton_party_id")
        .eq("user_id", user.id)
        .maybeSingle();
      if (row?.canton_party_id) {
        return { partyId: row.canton_party_id, isNew: false };
      }
    }
    throw new Error("Failed to store party mapping");
  }

  console.log(
    `${TAG} provisioned participant-managed party for user=${user.id}: ${party.slice(0, 28)}…`
  );
  return { partyId: party, isNew: true };
}
