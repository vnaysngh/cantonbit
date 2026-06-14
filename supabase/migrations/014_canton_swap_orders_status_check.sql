-- Enforce valid lifecycle states at the DB layer.
alter table canton_swap_orders
  drop constraint if exists canton_swap_orders_status_check;

alter table canton_swap_orders
  add constraint canton_swap_orders_status_check
  check (
    status in (
      'open',
      'settling',
      'user_locked',
      'filled',
      'expired',
      'failed',
      'cancelled'
    )
  );
