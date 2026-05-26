/**
 * Supabase browser client.
 * Used ONLY for auth operations (login, logout, session) — never for DB writes.
 * DB writes (party_mappings) go through the server route using the service role key.
 */

import { createBrowserClient } from "@supabase/ssr";

export function createSupabaseBrowserClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
