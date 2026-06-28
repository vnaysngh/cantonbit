-- Order-bound EVM chain metadata for HTLC swaps.
--
-- Multi-chain HTLC support requires every order to bind the EVM chain, escrow,
-- and WBTC token used for its EVM leg. Existing rows remain nullable until a
-- deployment-specific backfill is run, but funds-moving reservation RPCs fail
-- closed for null chains so legacy rows cannot be mis-bucketed.
--
-- This migration also rewrites reverse WBTC float reservation to key reservations
-- per (solver_evm_address, evm_chain_slug). Without this, a solver hot key reused
-- on Base + Arbitrum can reserve against the wrong chain's WBTC balance.

alter table public.htlc_orders
  add column if not exists evm_chain_slug text,
  add column if not exists evm_chain_id bigint,
  add column if not exists evm_escrow_address text,
  add column if not exists evm_wbtc_address text;

alter table public.htlc_orders
  drop constraint if exists htlc_orders_evm_chain_slug_check;

alter table public.htlc_orders
  add constraint htlc_orders_evm_chain_slug_check
  check (
    evm_chain_slug is null or
    evm_chain_slug in (
      'base-sepolia',
      'arbitrum-sepolia',
      'arbitrum',
      'base'
    )
  );

create index if not exists htlc_orders_evm_chain_status_idx
  on public.htlc_orders (evm_chain_slug, status);

create index if not exists htlc_orders_party_evm_chain_created_idx
  on public.htlc_orders (user_canton_party, evm_chain_slug, created_at desc);

drop index if exists public.htlc_orders_reverse_evm_float_reserved_idx;
drop index if exists public.htlc_orders_evm_float_reserved_idx;

create index if not exists htlc_orders_reverse_evm_float_reserved_chain_idx
  on public.htlc_orders (solver_evm_address, evm_chain_slug)
  where evm_float_reserved = true;

create or replace function public.reserve_reverse_htlc_evm_float_before_main_lock(
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
  v_chain text;
  v_need numeric;
  v_reserved numeric;
  v_already_reserved boolean;
begin
  select status, direction, lower(solver_evm_address),
         evm_chain_slug, wbtc_amount::numeric,
         evm_float_reserved
  into v_status, v_direction, v_solver_evm, v_chain, v_need, v_already_reserved
  from public.htlc_orders
  where id = p_order_id;

  if not found then
    return jsonb_build_object('reserved', false, 'reason', 'not_found');
  end if;
  if v_direction <> 'canton-to-evm' then
    return jsonb_build_object('reserved', false, 'reason', 'wrong_direction');
  end if;
  if v_chain is null or v_chain = '' then
    return jsonb_build_object('reserved', false, 'reason', 'unbound_chain');
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('htlc-evm-float:' || v_solver_evm || ':' || v_chain, 0)
  );

  select status, lower(solver_evm_address), evm_chain_slug,
         wbtc_amount::numeric, evm_float_reserved
  into v_status, v_solver_evm, v_chain, v_need, v_already_reserved
  from public.htlc_orders
  where id = p_order_id
  for update;

  if v_chain is null or v_chain = '' then
    return jsonb_build_object('reserved', false, 'reason', 'unbound_chain');
  end if;

  if v_status = 'main_locking' and v_already_reserved then
    return jsonb_build_object(
      'reserved', true,
      'status', v_status,
      'reservedUnits', '0',
      'needUnits', v_need::text
    );
  end if;
  if v_status <> 'accepted' then
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
    and evm_chain_slug = v_chain
    and id <> p_order_id
    and evm_float_reserved = true
    and status in ('main_locking', 'main_locked', 'counter_locking');

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
  set status = 'main_locking',
      evm_float_reserved = true,
      updated_at = now()
  where id = p_order_id
    and status = 'accepted';

  return jsonb_build_object(
    'reserved', true,
    'status', 'main_locking',
    'reservedUnits', v_reserved::text,
    'needUnits', v_need::text
  );
end;
$$;

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
  v_chain text;
  v_need numeric;
  v_reserved numeric;
  v_already_reserved boolean;
begin
  select status, direction, lower(solver_evm_address),
         evm_chain_slug, wbtc_amount::numeric,
         evm_float_reserved
  into v_status, v_direction, v_solver_evm, v_chain, v_need, v_already_reserved
  from public.htlc_orders
  where id = p_order_id;

  if not found then
    return jsonb_build_object('reserved', false, 'reason', 'not_found');
  end if;
  if v_direction <> 'canton-to-evm' then
    return jsonb_build_object('reserved', false, 'reason', 'wrong_direction');
  end if;
  if v_chain is null or v_chain = '' then
    return jsonb_build_object('reserved', false, 'reason', 'unbound_chain');
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('htlc-evm-float:' || v_solver_evm || ':' || v_chain, 0)
  );

  select status, lower(solver_evm_address), evm_chain_slug,
         wbtc_amount::numeric, evm_float_reserved
  into v_status, v_solver_evm, v_chain, v_need, v_already_reserved
  from public.htlc_orders
  where id = p_order_id
  for update;

  if v_chain is null or v_chain = '' then
    return jsonb_build_object('reserved', false, 'reason', 'unbound_chain');
  end if;

  if v_status = 'counter_locking' and v_already_reserved then
    return jsonb_build_object(
      'reserved', true,
      'status', v_status,
      'reservedUnits', '0',
      'needUnits', v_need::text
    );
  end if;
  if v_status = 'main_locked' and v_already_reserved then
    update public.htlc_orders
    set status = 'counter_locking',
        updated_at = now()
    where id = p_order_id
      and status = 'main_locked'
      and evm_float_reserved = true;
    return jsonb_build_object(
      'reserved', true,
      'status', 'counter_locking',
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
    and evm_chain_slug = v_chain
    and id <> p_order_id
    and evm_float_reserved = true
    and status in ('main_locking', 'main_locked', 'counter_locking');

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

revoke all on function public.reserve_reverse_htlc_evm_float_before_main_lock(
  text,
  numeric
) from public, anon, authenticated;
grant execute on function public.reserve_reverse_htlc_evm_float_before_main_lock(
  text,
  numeric
) to service_role;

revoke all on function public.reserve_reverse_htlc_evm_float(
  text,
  numeric
) from public, anon, authenticated;
grant execute on function public.reserve_reverse_htlc_evm_float(
  text,
  numeric
) to service_role;
