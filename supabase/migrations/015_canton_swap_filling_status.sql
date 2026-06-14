-- Loop atomic fill in-flight guard (CAS transition open/user_locked → filling).
alter table canton_swap_orders
  drop constraint if exists canton_swap_orders_status_check;

alter table canton_swap_orders
  add constraint canton_swap_orders_status_check
  check (
    status in (
      'open',
      'settling',
      'filling',
      'user_locked',
      'filled',
      'expired',
      'failed',
      'cancelled'
    )
  );
