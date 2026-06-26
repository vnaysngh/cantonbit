-- H-1: HTLC forward and C2C CBTC payouts share one settlement vault; reservation
-- RPCs must see the same in-flight CBTC under one advisory lock.

create or replace function public.sum_vault_cbtc_reserved_sats(
  p_vault_party text,
  p_exclude_htlc_id text default null,
  p_exclude_c2c_id text default null
)
returns numeric
language sql
stable
as $$
  select
    coalesce((
      select sum(trunc(cbtc_amount::numeric * 100000000))
      from public.htlc_orders
      where solver_canton_party = p_vault_party
        and direction = 'evm-to-canton'
        and (p_exclude_htlc_id is null or id <> p_exclude_htlc_id)
        and status in (
          'accepted',
          'main_locking',
          'main_locked',
          'counter_locking',
          'counter_locked',
          'counter_claimed'
        )
    ), 0)
    +
    -- Reverse Loop HTLC custody is a CBTC liability, not free vault float.
    -- In canton-to-evm Loop swaps the user transfers CBTC into the vault before
    -- the solver locks WBTC. Those holdings are visible in the vault ACS, but
    -- until the user claims WBTC (or we refund CBTC) they cannot be reused for
    -- forward/C2C payouts.
    coalesce((
      select sum(trunc(cbtc_amount::numeric * 100000000))
      from public.htlc_orders
      where solver_canton_party = p_vault_party
        and direction = 'canton-to-evm'
        and counter_mode = 'loop'
        and counter_transfer_update_id is not null
        and (p_exclude_htlc_id is null or id <> p_exclude_htlc_id)
        and status in (
          'main_locked',
          'counter_locking',
          'counter_locked',
          'counter_claimed',
          'refunding'
        )
    ), 0)
    +
    coalesce((
      select sum(trunc(out_amount::numeric * 100000000))
      from public.canton_swap_orders
      where solver_party = p_vault_party
        and to_asset = 'CBTC'
        and (p_exclude_c2c_id is null or id <> p_exclude_c2c_id)
        and float_reserved = true
        and status in ('settling', 'filling', 'user_locked')
    ), 0);
$$;

create or replace function public.accept_htlc_order_with_float_reservation(
  p_order_id text,
  p_solver_canton_party text,
  p_float_sats numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_direction text;
  v_solver_canton_party text;
  v_need_sats numeric;
  v_reserved_sats numeric;
begin
  perform pg_advisory_xact_lock(
    hashtextextended('vault-cbtc-float:' || p_solver_canton_party, 0)
  );

  select
    status,
    direction,
    solver_canton_party,
    trunc(cbtc_amount::numeric * 100000000)
  into
    v_status,
    v_direction,
    v_solver_canton_party,
    v_need_sats
  from public.htlc_orders
  where id = p_order_id
  for update;

  if not found then
    return jsonb_build_object('accepted', false, 'reason', 'not_found');
  end if;
  if v_solver_canton_party <> p_solver_canton_party then
    return jsonb_build_object(
      'accepted', false,
      'reason', 'solver_mismatch',
      'status', v_status
    );
  end if;
  if v_direction <> 'evm-to-canton' then
    return jsonb_build_object(
      'accepted', false,
      'reason', 'wrong_direction',
      'status', v_status
    );
  end if;
  if v_status <> 'open' then
    return jsonb_build_object(
      'accepted', false,
      'reason', 'status',
      'status', v_status
    );
  end if;

  v_reserved_sats := public.sum_vault_cbtc_reserved_sats(
    p_solver_canton_party,
    p_order_id,
    null
  );

  if p_float_sats - v_reserved_sats < v_need_sats then
    update public.htlc_orders
    set status = 'failed',
        updated_at = now()
    where id = p_order_id
      and status = 'open';

    return jsonb_build_object(
      'accepted', false,
      'reason', 'insufficient_float',
      'status', 'failed',
      'reservedSats', v_reserved_sats::text,
      'needSats', v_need_sats::text
    );
  end if;

  update public.htlc_orders
  set status = 'accepted',
      updated_at = now()
  where id = p_order_id
    and status = 'open';

  return jsonb_build_object(
    'accepted', true,
    'status', 'accepted',
    'reservedSats', v_reserved_sats::text,
    'needSats', v_need_sats::text
  );
end;
$$;

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
  v_lock_key text;
begin
  select status, solver_party, to_asset
  into v_status, v_solver_party, v_to_asset
  from public.canton_swap_orders
  where id = p_order_id;

  if not found then
    return jsonb_build_object('reserved', false, 'reason', 'not_found');
  end if;

  v_lock_key := case
    when v_to_asset = 'CBTC' then 'vault-cbtc-float:' || v_solver_party
    else 'c2c-float:' || v_solver_party || ':' || v_to_asset
  end;

  perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));

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

  if v_to_asset = 'CBTC' then
    v_reserved_units := public.sum_vault_cbtc_reserved_sats(
      v_solver_party,
      null,
      p_order_id
    );
  else
    v_scale := 10000000000::numeric;
    select coalesce(sum(trunc(out_amount::numeric * v_scale)), 0)
    into v_reserved_units
    from public.canton_swap_orders
    where solver_party = v_solver_party
      and to_asset = v_to_asset
      and id <> p_order_id
      and float_reserved = true
      and status in ('settling', 'filling', 'user_locked');
  end if;

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

create or replace function public.vault_cbtc_reservation_schema_version()
returns integer
language sql
stable
as $$
  select 2;
$$;

revoke all on function public.sum_vault_cbtc_reserved_sats(text, text, text)
  from public, anon, authenticated;
grant execute on function public.sum_vault_cbtc_reserved_sats(text, text, text)
  to service_role;

revoke all on function public.accept_htlc_order_with_float_reservation(
  text,
  text,
  numeric
) from public, anon, authenticated;

grant execute on function public.accept_htlc_order_with_float_reservation(
  text,
  text,
  numeric
) to service_role;

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

revoke all on function public.vault_cbtc_reservation_schema_version()
  from public, anon, authenticated;

grant execute on function public.vault_cbtc_reservation_schema_version()
  to service_role;
