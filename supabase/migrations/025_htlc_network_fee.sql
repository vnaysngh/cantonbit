-- HTLC order network fee bounds (managed lock/claim paths).
alter table public.htlc_orders
  add column if not exists network_fee_cc text,
  add column if not exists network_fee_expires_at timestamptz;
