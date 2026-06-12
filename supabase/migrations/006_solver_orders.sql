-- Solver order-state store (replaces the swap-solver's local JSON file).
--
-- WHY: the solver runs as separate `api` + `watch` processes (separate Railway
-- containers = separate filesystems). A local JSON file can't be shared between
-- them — the api would record an order + cantonParty that the watch loop can't
-- see, so swaps got stuck at `seen`. Moving order state into Postgres makes both
-- processes stateless: they read/write one shared table. This mirrors how CoW
-- Protocol stores orders (Postgres, not a file) and how the rest of this app
-- already uses Supabase (mint_transfers, redeems, …).
--
-- Mirrors the old StoreFile shape: solver_orders ≈ OrderRecord map,
-- solver_state ≈ cursorBlock. The recovery map (partyByOrderId) collapses into
-- solver_orders.canton_party.

-- One row per swap order. Columns map 1:1 to the solver's OrderRecord.
create table if not exists public.solver_orders (
  -- The on-chain orderId (keccak) — primary key, first-write-wins idempotency.
  order_id text primary key,

  -- Status machine: seen → delivering → delivered → attested → finalised
  --                                              ↘ refunded / failed
  status text not null default 'seen'
    check (status in ('seen','delivering','delivered','attested','finalised','refunded','failed')),

  -- Block the Open event was observed at (audit/debug).
  open_block bigint not null default 0,

  -- The decoded StandardOrder (SerializedOrder; bigints as strings) as JSON.
  order_json jsonb not null,

  -- Full Canton destination party (preimage of output.recipient = keccak(party)).
  -- NOT on-chain; supplied off-chain and verified against the committed hash
  -- before delivery. This IS the recovery map — durable before openFor.
  canton_party text,

  -- Canton ledger record-time of the CBTC delivery (unix seconds), once known.
  fill_timestamp bigint,
  -- Canton delivery reference (e.g. update id), once known.
  canton_delivery_ref text,
  -- Allocation contract id (USE_ALLOCATION mode), if used.
  allocation_cid text,
  -- True once the user ACCEPTED the CBTC on Canton (HIGH-1: blocks refund).
  cbtc_accepted boolean not null default false,
  -- Solver-float holding cids spent on the delivery offer (accept-watch tracking).
  input_holding_cids jsonb,
  -- Origin-chain tx hashes for the attest + finalise legs, once sent.
  attest_tx_hash text,
  finalise_tx_hash text,
  -- Free-form note for failures / manual recovery.
  note text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- byStatus() iterates orders in a given status (e.g. all 'seen' to deliver).
create index if not exists solver_orders_status_idx on public.solver_orders (status);
-- byUser() sums a user's in-flight CBTC (per-user overdraft cap). The user is in
-- the order JSON; index its lowercased value for the case-insensitive lookup.
create index if not exists solver_orders_user_idx
  on public.solver_orders ((lower(order_json->>'user')));

-- Singleton: the watcher's resume cursor (last block fully processed).
create table if not exists public.solver_state (
  id int primary key default 1 check (id = 1),
  cursor_block bigint not null default 0,
  updated_at timestamptz not null default now()
);
-- Seed the single state row.
insert into public.solver_state (id, cursor_block) values (1, 0)
  on conflict (id) do nothing;

-- Atomic compare-and-set claim — the double-delivery guard. Modeled on
-- claim_mint_transfer (004_mint_processor_hardening.sql). The single conditional
-- UPDATE is genuinely atomic: two concurrent callers can't both see `expected`
-- and both win, so only one process ever transitions seen→delivering for a given
-- order. Returns the order_id if THIS caller claimed it, NULL otherwise.
create or replace function public.claim_solver_order(
  p_order_id text,
  p_expected text,
  p_next text,
  p_note text default null
)
returns text
language plpgsql
as $$
declare
  claimed text;
begin
  update public.solver_orders
     set status = p_next,
         note = coalesce(p_note, note),
         updated_at = now()
   where order_id = p_order_id
     and status = p_expected
  returning order_id into claimed;

  return claimed;
end;
$$;

-- No RLS: like mint_transfers, this table is touched ONLY server-side with the
-- service-role key (which bypasses RLS). The solver api + watch authenticate with
-- SUPABASE_SERVICE_ROLE_KEY. Functions aren't governed by RLS; gate via grant.
grant execute on function public.claim_solver_order(text, text, text, text) to service_role;
