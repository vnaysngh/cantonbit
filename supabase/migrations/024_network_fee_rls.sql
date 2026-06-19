-- Harden network_fee_ledger: service-only REST + one row per order.
revoke all on table public.network_fee_ledger from anon, authenticated;
alter table public.network_fee_ledger enable row level security;

create unique index if not exists network_fee_ledger_order_kind_uidx
  on network_fee_ledger (order_id, order_kind);

alter table public.network_fee_ledger
  add constraint network_fee_ledger_order_kind_key
  unique using index network_fee_ledger_order_kind_uidx;
