-- Persist post-commit fee accounting obligations on the order row so a database
-- outage after ledger settlement cannot permanently lose revenue records.

alter table public.canton_swap_orders
  add column if not exists network_fee_settlement_update_id text,
  add column if not exists network_fee_accounting_pending boolean not null default false;

alter table public.htlc_orders
  add column if not exists network_fee_settlement_update_id text,
  add column if not exists network_fee_accounting_pending boolean not null default false;

create index if not exists canton_swap_network_fee_outbox_idx
  on public.canton_swap_orders (updated_at)
  where network_fee_accounting_pending = true;

create index if not exists htlc_network_fee_outbox_idx
  on public.htlc_orders (updated_at)
  where network_fee_accounting_pending = true;
