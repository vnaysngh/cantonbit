/**
 * GET /auth/callback
 *
 * Supabase redirects here after OTP verification.
 * Exchanges the one-time code for a session cookie, then redirects to the app.
 * Also triggers Canton party allocation for first-time users.
 */

import { NextRequest, NextResponse } from "next/server";

import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/";

  if (code) {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (!error) {
      // Allocate Canton party for this user if they don't have one yet.
      // Fire-and-forget — party allocation happens in the background.
      // The app will retry on first load if this fails.
      try {
        const allocateUrl = new URL("/api/parties/allocate", origin);
        await fetch(allocateUrl.toString(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // Pass cookies so the server route can read the session
          credentials: "include",
        });
      } catch {
        // Non-fatal — useWallet will trigger allocation on first load
        console.warn("[auth/callback] party allocation failed — will retry on load");
      }

      const redirectUrl = new URL(next, origin);
      return NextResponse.redirect(redirectUrl);
    }
  }

  // Auth failed — redirect to login with error
  const loginUrl = new URL("/login?error=auth_failed", origin);
  return NextResponse.redirect(loginUrl);
}
