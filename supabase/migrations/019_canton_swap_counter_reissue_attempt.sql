-- Deterministic counter reissue command ids (idempotent re-deliver).
alter table canton_swap_orders
  add column if not exists counter_reissue_attempt int not null default 0;
