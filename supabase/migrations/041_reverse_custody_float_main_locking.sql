-- Extend unified CBTC float reservation: reverse-Loop custody in main_locking
-- (offer bound, accept may have happened but counter_transfer_update_id not yet persisted).
--
-- IMPORTANT: keep the (text, text, text) signature from migration 040 so create or
-- replace updates the body the wrapper RPCs already call — not a separate uuid overload.

drop function if exists public.sum_vault_cbtc_reserved_sats(text, text, uuid);

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
      select sum(trunc(cbtc_amount::numeric * 100000000))
      from public.htlc_orders
      where solver_canton_party = p_vault_party
        and direction = 'canton-to-evm'
        and counter_mode = 'loop'
        and counter_transfer_offer_cid is not null
        and counter_transfer_update_id is null
        and (p_exclude_htlc_id is null or id <> p_exclude_htlc_id)
        and status = 'main_locking'
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

create or replace function public.vault_cbtc_reservation_schema_version()
returns integer
language sql
stable
as $$
  select 3;
$$;

revoke all on function public.sum_vault_cbtc_reserved_sats(text, text, text)
  from public, anon, authenticated;
grant execute on function public.sum_vault_cbtc_reserved_sats(text, text, text)
  to service_role;

revoke all on function public.vault_cbtc_reservation_schema_version()
  from public, anon, authenticated;
grant execute on function public.vault_cbtc_reservation_schema_version()
  to service_role;
