-- When counter offer leaves user ACS but Accept is not yet visible, defer reissue.
alter table canton_swap_orders
  add column if not exists counter_pending_cleared_at timestamptz;
