/**
 * Supabase server client.
 * Used in Server Components, API routes, and middleware.
 * Reads cookies to rehydrate the user session server-side.
 */

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export async function createSupabaseServerClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => {
              cookieStore.set(name, value, options);
            });
          } catch {
            // setAll called from a Server Component — safe to ignore.
          }
        },
      },
    },
  );
}

/**
 * Supabase service-role client.
 * Has full DB access — bypasses RLS.
 * ONLY used server-side for writing party_mappings.
 * NEVER import this in any client component or expose to the browser.
 */
export async function createSupabaseServiceClient() {
  // Service role doesn't need cookies — it authenticates via the secret key,
  // not via the user session. No cookie handling needed.
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      cookies: {
        getAll() { return []; },
        setAll() {},
      },
    },
  );
}
