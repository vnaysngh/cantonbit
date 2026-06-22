-- Serialize reverse HTLC WBTC exposure across daemon instances.

alter table public.htlc_orders
  add column if not exists evm_float_reserved boolean not null default false;

create index if not exists htlc_orders_evm_float_reserved_idx
  on public.htlc_orders (solver_evm_address)
  where evm_float_reserved = true;

create or replace function public.reserve_reverse_htlc_evm_float(
  p_order_id text,
  p_float_units numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_direction text;
  v_solver_evm text;
  v_need numeric;
  v_reserved numeric;
  v_already_reserved boolean;
begin
  select status, direction, lower(solver_evm_address), wbtc_amount::numeric,
         evm_float_reserved
  into v_status, v_direction, v_solver_evm, v_need, v_already_reserved
  from public.htlc_orders
  where id = p_order_id;

  if not found then
    return jsonb_build_object('reserved', false, 'reason', 'not_found');
  end if;
  if v_direction <> 'canton-to-evm' then
    return jsonb_build_object('reserved', false, 'reason', 'wrong_direction');
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('htlc-evm-float:' || v_solver_evm, 0)
  );

  select status, lower(solver_evm_address), wbtc_amount::numeric,
         evm_float_reserved
  into v_status, v_solver_evm, v_need, v_already_reserved
  from public.htlc_orders
  where id = p_order_id
  for update;

  if v_status = 'counter_locking' and v_already_reserved then
    return jsonb_build_object(
      'reserved', true,
      'status', v_status,
      'reservedUnits', '0',
      'needUnits', v_need::text
    );
  end if;
  if v_status <> 'main_locked' then
    return jsonb_build_object(
      'reserved', false,
      'reason', 'status',
      'status', v_status
    );
  end if;

  select coalesce(sum(wbtc_amount::numeric), 0)
  into v_reserved
  from public.htlc_orders
  where lower(solver_evm_address) = v_solver_evm
    and id <> p_order_id
    and evm_float_reserved = true
    and status = 'counter_locking';

  if p_float_units - v_reserved < v_need then
    return jsonb_build_object(
      'reserved', false,
      'reason', 'insufficient_float',
      'status', v_status,
      'reservedUnits', v_reserved::text,
      'needUnits', v_need::text
    );
  end if;

  update public.htlc_orders
  set status = 'counter_locking',
      evm_float_reserved = true,
      updated_at = now()
  where id = p_order_id
    and status = 'main_locked';

  return jsonb_build_object(
    'reserved', true,
    'status', 'counter_locking',
    'reservedUnits', v_reserved::text,
    'needUnits', v_need::text
  );
end;
$$;

revoke all on function public.reserve_reverse_htlc_evm_float(
  text,
  numeric
) from public, anon, authenticated;

grant execute on function public.reserve_reverse_htlc_evm_float(
  text,
  numeric
) to service_role;
