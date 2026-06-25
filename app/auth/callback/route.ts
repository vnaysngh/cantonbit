/**
 * GET /auth/callback
 *
 * Supabase OAuth / magic-link redirect target. Exchanges the one-time code for a
 * session cookie, provisions a participant-managed Canton party when needed, then
 * sends the user into the app.
 */
import { NextRequest, NextResponse } from "next/server";

import { provisionParticipantManagedPartyForUser } from "@/lib/provision-participant-party";
import { publicRequestOrigin } from "@/lib/request-origin";
import { safeRedirectPath } from "@/lib/safe-redirect-path";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const origin = publicRequestOrigin(request);
  const code = searchParams.get("code");
  const next = safeRedirectPath(searchParams.get("next"));

  if (code) {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (!error) {
      try {
        await provisionParticipantManagedPartyForUser(supabase);
      } catch (e) {
        console.error("[auth/callback] provision failed:", e);
      }

      return NextResponse.redirect(new URL(next, origin));
    }
  }

  return NextResponse.redirect(new URL("/login?error=auth_failed", origin));
}
