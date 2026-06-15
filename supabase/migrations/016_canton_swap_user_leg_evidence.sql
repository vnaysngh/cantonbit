-- User-leg ledger evidence for Loop C2C swaps (preapproval-safe confirm).
alter table canton_swap_orders
  add column if not exists user_leg_submit_update_id text;

alter table canton_swap_orders
  add column if not exists user_leg_inbound_holding_cid text;
