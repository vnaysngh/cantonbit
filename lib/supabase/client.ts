/**
 * Supabase browser client.
 * Used ONLY for auth operations (login, logout, session) — never for DB writes.
 * DB writes (party_mappings) go through the server route using the service role key.
 */

import { createBrowserClient } from "@supabase/ssr";

export function createSupabaseBrowserClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  // Guard so a MISSING env doesn't crash the production build's prerender of any
  // page that imports this. At build time (Railway) the vars may be absent; the
  // real client is only ever used in the BROWSER, where NEXT_PUBLIC_* is baked in.
  // A clear runtime error is far better than a cryptic build failure.
  if (!url || !anonKey) {
    throw new Error(
      "Supabase is not configured: set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.",
    );
  }
  return createBrowserClient(url, anonKey);
}
