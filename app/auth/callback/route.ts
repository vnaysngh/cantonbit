/**
 * GET /auth/callback
 *
 * Supabase redirects here after OTP verification. Exchanges the one-time code
 * for a session cookie, then redirects to the app.
 *
 * The Canton party is NO LONGER allocated here — it comes from the user
 * connecting their Loop wallet (registered via /api/parties/register-loop on
 * connect). Login establishes the app session only.
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
      return NextResponse.redirect(new URL(next, origin));
    }
  }

  // Auth failed — redirect to login with error
  return NextResponse.redirect(new URL("/login?error=auth_failed", origin));
}
