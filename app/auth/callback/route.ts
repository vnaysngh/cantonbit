/**
 * GET /auth/callback
 *
 * Supabase OAuth / magic-link redirect target. Exchanges the one-time code for a
 * session cookie, provisions a participant-managed Canton party when needed, then
 * sends the user into the app.
 */
import { NextRequest, NextResponse } from "next/server";

import { provisionParticipantManagedPartyForUser } from "@/lib/provision-participant-party";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  let next = searchParams.get("next") ?? "/swap";
  if (!next.startsWith("/")) next = "/swap";

  if (code) {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (!error) {
      try {
        await provisionParticipantManagedPartyForUser(supabase);
      } catch (e) {
        console.error("[auth/callback] provision failed:", e);
      }

      const forwardedHost = request.headers.get("x-forwarded-host");
      const isLocalEnv = process.env.NODE_ENV === "development";
      if (isLocalEnv) {
        return NextResponse.redirect(new URL(next, origin));
      }
      if (forwardedHost) {
        return NextResponse.redirect(`https://${forwardedHost}${next}`);
      }
      return NextResponse.redirect(new URL(next, origin));
    }
  }

  return NextResponse.redirect(new URL("/login?error=auth_failed", origin));
}
