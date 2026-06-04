/**
 * Next.js middleware — runs on every request before the page renders.
 *
 * The app NO LONGER gates on a Supabase login. Identity comes from connecting
 * the Loop wallet (client-side). This middleware only refreshes the Supabase
 * session cookie when one happens to exist (so any legacy session stays valid),
 * and never redirects to /login. The gating ("connect your Loop wallet to use
 * the app") is handled in the UI.
 */

import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";

export async function proxy(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  // Refresh the Supabase session cookie if present (no redirect either way).
  // Wrapped defensively: a missing/invalid session must never block a request.
  try {
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return request.cookies.getAll();
          },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value }) =>
              request.cookies.set(name, value),
            );
            supabaseResponse = NextResponse.next({ request });
            cookiesToSet.forEach(({ name, value, options }) =>
              supabaseResponse.cookies.set(name, value, options),
            );
          },
        },
      },
    );
    await supabase.auth.getUser();
  } catch {
    // No/invalid session — fine; the app is open and gates on Loop connect.
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
