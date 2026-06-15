-- Prevent two active Loop orders from binding the same user-leg ledger evidence (N2).
create unique index if not exists canton_swap_orders_user_leg_offer_cid_active_uq
  on canton_swap_orders (user_leg_offer_cid)
  where user_leg_offer_cid is not null
    and status in ('open', 'user_locked', 'filling');

create unique index if not exists canton_swap_orders_user_leg_submit_update_id_active_uq
  on canton_swap_orders (user_leg_submit_update_id)
  where user_leg_submit_update_id is not null
    and status in ('open', 'user_locked', 'filling');
