-- Dead column — user leg is offer-only; never persisted.
alter table canton_swap_orders
  drop column if exists user_leg_inbound_holding_cid;
