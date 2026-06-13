-- HARDENING (security review 2026-06-13): htlc_orders and solver_orders were
-- created "server-side only, service-role key, no RLS". That intent is enforced
-- ONLY by Postgres GRANTs — and Supabase/PostgREST exposes tables to the `anon`
-- and `authenticated` roles by default. Without RLS, the public REST API (anon
-- key, which IS shipped to the browser) could read these rows: hashLocks, party
-- IDs, EVM addresses, amounts, lifecycle state, and post-reveal preimages — the
-- highest-sensitivity data in the app.
--
-- Make the "server-only" intent ENFORCED, not conventional:
--   1. Revoke all anon/authenticated grants (belt).
--   2. Enable RLS with NO policies = deny-all to every role except service_role,
--      which bypasses RLS entirely (suspenders). The server uses the service-role
--      key, so app behavior is unchanged.

-- htlc_orders
revoke all on table public.htlc_orders from anon, authenticated;
alter table public.htlc_orders enable row level security;
-- No policies created => no anon/authenticated row is ever visible. service_role
-- bypasses RLS, so the server keeps full access.

-- solver_orders
revoke all on table public.solver_orders from anon, authenticated;
alter table public.solver_orders enable row level security;
