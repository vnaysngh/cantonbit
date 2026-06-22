-- Keep forward CBTC inventory reserved while either irreversible lock submit is
-- in progress. Migration 029 predated the durable locking states, so recreate the
-- RPC with the expanded in-flight status set for databases that already applied it.

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
    hashtextextended('htlc-cbtc-float:' || p_solver_canton_party, 0)
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

  select coalesce(sum(trunc(cbtc_amount::numeric * 100000000)), 0)
  into v_reserved_sats
  from public.htlc_orders
  where solver_canton_party = p_solver_canton_party
    and direction = 'evm-to-canton'
    and id <> p_order_id
    and status in (
      'accepted',
      'main_locking',
      'main_locked',
      'counter_locking',
      'counter_locked',
      'counter_claimed'
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
