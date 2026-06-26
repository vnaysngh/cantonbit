/**
 * POST /api/parties/provision — participant-managed onboarding (R2).
 *
 * For an authenticated user with NO Canton party yet: allocate a party on our warpx
 * node, grant CanActAs, and bind it in party_mappings. Idempotent.
 */
import { NextResponse } from "next/server";

import { provisionParticipantManagedPartyForUser } from "@/lib/provision-participant-party";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { mainnetBlockedResponse } from "@/lib/mainnet-guard";

export async function POST() {
  try {
    const mainnetBlocked = mainnetBlockedResponse();
    if (mainnetBlocked) return mainnetBlocked;

    const supabase = await createSupabaseServerClient();
    const result = await provisionParticipantManagedPartyForUser(supabase);
    if (!result) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
