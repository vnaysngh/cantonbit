-- 011 — Same-Canton HTLC swaps (canton-to-canton direction).
-- Extends htlc_orders for dual on-ledger legs; EVM fields become optional.

alter table public.htlc_orders
  drop constraint if exists htlc_orders_direction_check;

alter table public.htlc_orders
  add constraint htlc_orders_direction_check
    check (direction in ('evm-to-canton','canton-to-evm','canton-to-canton'));

-- Legacy EVM columns: nullable for canton-to-canton rows.
alter table public.htlc_orders
  alter column user_evm_address drop not null,
  alter column solver_evm_address drop not null,
  alter column wbtc_amount drop not null,
  alter column cbtc_amount drop not null;

-- Dual on-ledger lock (counter leg — solver locks, user receives).
alter table public.htlc_orders
  add column if not exists counter_allocation_cid text,
  add column if not exists counter_htlc_cid text,
  add column if not exists counter_htlc_blob text,
  add column if not exists main_leg jsonb,
  add column if not exists counter_leg jsonb;
