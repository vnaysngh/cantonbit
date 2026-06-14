-- Same-Canton intent swaps (Option A — not HTLC).
create table if not exists canton_swap_orders (
  id text primary key,
  status text not null,
  from_asset text not null check (from_asset in ('CBTC', 'CC')),
  to_asset text not null check (to_asset in ('CBTC', 'CC')),
  in_amount text not null,
  out_amount text not null,
  min_out text not null,
  quote_expires_at timestamptz not null,
  user_party text not null,
  solver_party text not null,
  wallet_mode text not null check (wallet_mode in ('managed', 'loop')),
  user_leg_offer_cid text,
  counter_leg_offer_cid text,
  settlement_update_id text,
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (from_asset <> to_asset)
);

create index if not exists canton_swap_orders_user_party_idx
  on canton_swap_orders (user_party, created_at desc);

create index if not exists canton_swap_orders_status_idx
  on canton_swap_orders (status);
