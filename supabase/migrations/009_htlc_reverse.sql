-- 009 — Canton→EVM (reverse direction) support.
-- counter_lock_tx: the SOLVER's EVM WBTC lock tx (the counter leg in reverse swaps).
alter table public.htlc_orders
  add column if not exists counter_lock_tx text;
