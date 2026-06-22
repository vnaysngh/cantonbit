-- C2C vault-float reservations must be acquired in the same database
-- transaction as the lifecycle transition that commits a swap to settlement.
-- Open quotes do not reserve inventory.

alter table public.canton_swap_orders
  add column if not exists float_reserved boolean not null default false;

create index if not exists canton_swap_orders_float_reservation_idx
  on public.canton_swap_orders (solver_party, to_asset)
  where float_reserved = true;

create or replace function public.reserve_canton_swap_float(
  p_order_id text,
  p_expected_status text,
  p_next_status text,
  p_float_units numeric,
  p_user_leg_offer_cid text default null,
  p_user_leg_submit_update_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_solver_party text;
  v_to_asset text;
  v_need_units numeric;
  v_reserved_units numeric;
  v_scale numeric;
begin
  select status, solver_party, to_asset
  into v_status, v_solver_party, v_to_asset
  from public.canton_swap_orders
  where id = p_order_id;

  if not found then
    return jsonb_build_object('reserved', false, 'reason', 'not_found');
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('c2c-float:' || v_solver_party || ':' || v_to_asset, 0)
  );

  select status, solver_party, to_asset,
    trunc(
      out_amount::numeric *
      case when to_asset = 'CC' then 10000000000::numeric else 100000000::numeric end
    )
  into v_status, v_solver_party, v_to_asset, v_need_units
  from public.canton_swap_orders
  where id = p_order_id
  for update;

  if v_status <> p_expected_status then
    return jsonb_build_object(
      'reserved', false,
      'reason', 'status',
      'status', v_status
    );
  end if;

  v_scale := case
    when v_to_asset = 'CC' then 10000000000::numeric
    else 100000000::numeric
  end;

  select coalesce(sum(trunc(out_amount::numeric * v_scale)), 0)
  into v_reserved_units
  from public.canton_swap_orders
  where solver_party = v_solver_party
    and to_asset = v_to_asset
    and id <> p_order_id
    and float_reserved = true
    and status in ('settling', 'filling', 'user_locked');

  if p_float_units - v_reserved_units < v_need_units then
    return jsonb_build_object(
      'reserved', false,
      'reason', 'insufficient_float',
      'status', v_status,
      'reservedUnits', v_reserved_units::text,
      'availableUnits', greatest(p_float_units - v_reserved_units, 0)::text,
      'needUnits', v_need_units::text
    );
  end if;

  update public.canton_swap_orders
  set status = p_next_status,
      float_reserved = true,
      user_leg_offer_cid = coalesce(
        p_user_leg_offer_cid,
        user_leg_offer_cid
      ),
      user_leg_submit_update_id = coalesce(
        p_user_leg_submit_update_id,
        user_leg_submit_update_id
      ),
      failure_reason = null,
      updated_at = now()
  where id = p_order_id
    and status = p_expected_status;

  return jsonb_build_object(
    'reserved', true,
    'status', p_next_status,
    'reservedUnits', v_reserved_units::text,
    'needUnits', v_need_units::text
  );
end;
$$;

revoke all on function public.reserve_canton_swap_float(
  text,
  text,
  text,
  numeric,
  text,
  text
) from public, anon, authenticated;

grant execute on function public.reserve_canton_swap_float(
  text,
  text,
  text,
  numeric,
  text,
  text
) to service_role;
