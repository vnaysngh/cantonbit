-- Counter reissue is permitted only after scanning the complete ledger range
-- beginning at the exact offer-creation offset. Persist any accept proof forever.

alter table public.canton_swap_orders
  add column if not exists counter_leg_created_offset bigint,
  add column if not exists counter_receipt_update_id text;

create unique index if not exists canton_swap_counter_receipt_update_uq
  on public.canton_swap_orders (counter_receipt_update_id)
  where counter_receipt_update_id is not null;
