-- Network fee fields on C2C swap orders + audit ledger.
alter table canton_swap_orders
  add column if not exists network_fee_cc text,
  add column if not exists network_fee_expires_at timestamptz;

create table if not exists network_fee_ledger (
  id bigserial primary key,
  order_id text not null,
  order_kind text not null check (order_kind in ('c2c', 'htlc')),
  user_party text not null,
  fee_cc text not null,
  fee_usd numeric,
  traffic_bytes bigint,
  network_fee_source text not null,
  receiver_party text not null,
  settlement_update_id text,
  created_at timestamptz not null default now()
);

create index if not exists network_fee_ledger_order_id_idx
  on network_fee_ledger (order_id);

create index if not exists network_fee_ledger_user_party_idx
  on network_fee_ledger (user_party, created_at desc);

-- Service-only REST + one audit row per order (024 repeats idempotently for existing DBs).
revoke all on table public.network_fee_ledger from anon, authenticated;
alter table public.network_fee_ledger enable row level security;

-- One audit row per (order_id, order_kind). Add the unique constraint only if
-- absent (bare ADD CONSTRAINT has no IF NOT EXISTS; building it directly as a
-- constraint avoids the index-rename foot-gun where a leftover _uidx lingers).
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'network_fee_ledger_order_kind_key'
      and conrelid = 'public.network_fee_ledger'::regclass
  ) then
    alter table public.network_fee_ledger
      add constraint network_fee_ledger_order_kind_key
      unique (order_id, order_kind);
  end if;
end $$;
