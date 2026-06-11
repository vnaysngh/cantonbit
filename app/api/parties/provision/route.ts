/**
 * POST /api/parties/provision — participant-managed onboarding (R2).
 *
 * For an authenticated email/password user with NO Canton party yet: allocate a
 * party on our warpx node, grant the backend CanActAs over it (so the backend can
 * sign the on-ledger HtlcLock.Claim for them — the proven trustless path), and bind
 * it to their Supabase row in party_mappings.
 *
 * Idempotent: if the user already has a party, returns it.
 *
 * Security: identity comes from the Supabase session only (never the body). The
 * party is created server-side and bound to THIS user — no client-supplied party.
 */
import { NextResponse } from "next/server";

import { createSupabaseServerClient, createSupabaseServiceClient } from "@/lib/supabase/server";
import { onboardParticipantManagedParty } from "@/lib/party-onboarding";
import { NETWORK } from "@/lib/constants";

const TAG = "[parties/provision]";

/** The current network's warpx participant namespace (where our DAR is vetted). */
function warpxNamespace(): string {
  return NETWORK.warpxPartyId.split("::")[1] ?? "";
}

export async function POST() {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const service = await createSupabaseServiceClient();
    const ns = warpxNamespace();

    // Already provisioned ON THE CURRENT WARPX PARTICIPANT? Return it (idempotent).
    // A party on a DIFFERENT participant (e.g. an old cbtc-user::mainnet-ns one) is
    // NOT usable for the on-ledger HtlcLock claim (DAR not vetted there) — re-provision.
    const { data: existing } = await service
      .from("party_mappings")
      .select("canton_party_id, party_hint")
      .eq("user_id", user.id)
      .maybeSingle();
    if (existing?.canton_party_id) {
      // NEVER convert a Loop-wallet user to a warpx party (email locked to its
      // first auth method). Leave their Loop party alone.
      if (existing.party_hint === "loop-wallet") {
        return NextResponse.json({ partyId: existing.canton_party_id, isNew: false });
      }
      const existingNs = (existing.canton_party_id as string).split("::")[1] ?? "";
      if (ns && existingNs === ns) {
        return NextResponse.json({ partyId: existing.canton_party_id, isNew: false });
      }
      // Wrong participant — allocate a fresh warpx party and re-point the mapping.
      const { party } = await onboardParticipantManagedParty();
      const { error: updErr } = await service
        .from("party_mappings")
        .update({ canton_party_id: party, party_hint: "participant-managed" })
        .eq("user_id", user.id);
      if (updErr) {
        console.error(`${TAG} re-provision update error:`, updErr);
        return NextResponse.json({ error: "Failed to re-point party mapping" }, { status: 500 });
      }
      console.log(`${TAG} re-provisioned user=${user.id} onto warpx: ${party.slice(0, 28)}…`);
      return NextResponse.json({ partyId: party, isNew: true });
    }

    // Allocate on warpx + grant backend CanActAs (the proven participant-managed path).
    const { party } = await onboardParticipantManagedParty();

    const { error: insErr } = await service
      .from("party_mappings")
      .insert({ user_id: user.id, canton_party_id: party, party_hint: "participant-managed" });
    if (insErr) {
      // Race: someone provisioned concurrently — return whatever is now mapped.
      if (insErr.code === "23505") {
        const { data: row } = await service
          .from("party_mappings").select("canton_party_id").eq("user_id", user.id).maybeSingle();
        if (row?.canton_party_id) return NextResponse.json({ partyId: row.canton_party_id, isNew: false });
      }
      console.error(`${TAG} insert error:`, insErr);
      return NextResponse.json({ error: "Failed to store party mapping" }, { status: 500 });
    }

    console.log(`${TAG} provisioned participant-managed party for user=${user.id}: ${party.slice(0, 28)}…`);
    return NextResponse.json({ partyId: party, isNew: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
