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
import { isPartyOnCurrentNetwork } from "@/lib/party-network";
import { onboardParticipantManagedParty } from "@/lib/party-onboarding";

const TAG = "[parties/provision]";

export async function POST() {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const service = await createSupabaseServiceClient();

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
      if (existing.party_hint === "participant-managed") {
        if (isPartyOnCurrentNetwork(existing.canton_party_id)) {
          return NextResponse.json({ partyId: existing.canton_party_id, isNew: false });
        }
        console.warn(
          `${TAG} repointing wrong-network party ${existing.canton_party_id.slice(0, 28)}…`
        );
      }
    }

    const { party } = await onboardParticipantManagedParty();

    if (existing?.canton_party_id) {
      const { error: updErr } = await service
        .from("party_mappings")
        .update({ canton_party_id: party, party_hint: "participant-managed" })
        .eq("user_id", user.id);
      if (updErr) {
        console.error(`${TAG} update error:`, updErr);
        return NextResponse.json({ error: "Failed to store party mapping" }, { status: 500 });
      }
      console.log(`${TAG} repointed participant-managed party for user=${user.id}`);
      return NextResponse.json({ partyId: party, isNew: true });
    }

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
