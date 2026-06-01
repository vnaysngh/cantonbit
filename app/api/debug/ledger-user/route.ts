/**
 * GET /api/debug/ledger-user  — TEMPORARY DIAGNOSTIC, REMOVE AFTER USE.
 *
 * Decodes the m2m ledger JWT's `sub` and lists that ledger user's current
 * rights via GET /v2/users/{user-id}/rights. Use this to confirm whether the
 * m2m token has ParticipantAdmin — which is REQUIRED (per the JSON Ledger API
 * spec) to grant CanActAs/CanReadAs rights on newly-allocated parties.
 *
 * Gated behind a logged-in Supabase session so it isn't publicly open.
 * Returns the raw rights array so you can eyeball it for a ParticipantAdmin /
 * IdentityProviderAdmin entry.
 */

import { NextResponse } from "next/server";

import { listSelfUserRights } from "@/lib/canton";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const TAG = "[debug/ledger-user]";

export async function GET() {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { userId, rights } = await listSelfUserRights();

    // Best-effort scan for an admin entry so the answer is obvious at a glance.
    const rightsStr = JSON.stringify(rights);
    const hasParticipantAdmin = rightsStr.includes("ParticipantAdmin");
    const hasIdpAdmin = rightsStr.includes("IdentityProviderAdmin");

    console.log(
      `${TAG} userId=${userId} participantAdmin=${hasParticipantAdmin} idpAdmin=${hasIdpAdmin}`,
    );

    return NextResponse.json({
      ledgerUserId: userId,
      hasParticipantAdmin,
      hasIdentityProviderAdmin: hasIdpAdmin,
      canGrantRights: hasParticipantAdmin || hasIdpAdmin,
      rights,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${TAG} error:`, err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
