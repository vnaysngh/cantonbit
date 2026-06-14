-- HARDENING: canton_swap_orders was created server-side only but had no RLS.
-- Mirror 010_htlc_orders_rls_lockdown — deny anon/authenticated REST access;
-- service_role (server) bypasses RLS unchanged.

revoke all on table public.canton_swap_orders from anon, authenticated;
alter table public.canton_swap_orders enable row level security;
