-- Security audit 2026-06: mint_transfers, mint_processor_state, and solver_state
-- were server-intent-only but lacked RLS/revoke (unlike htlc_orders in 010).

revoke all on table public.mint_transfers from anon, authenticated;
alter table public.mint_transfers enable row level security;

revoke all on table public.mint_processor_state from anon, authenticated;
alter table public.mint_processor_state enable row level security;

revoke all on table public.solver_state from anon, authenticated;
alter table public.solver_state enable row level security;
