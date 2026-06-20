-- Harden network_fee_ledger: service-only REST + one row per order.
revoke all on table public.network_fee_ledger from anon, authenticated;
alter table public.network_fee_ledger enable row level security;

-- One audit row per (order_id, order_kind). Idempotent re-run safe; this repeats
-- 023's constraint for DBs created before 023 was hardened. No-op if 023 ran.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'network_fee_ledger_order_kind_key'
      and conrelid = 'public.network_fee_ledger'::regclass
  ) then
    alter table public.network_fee_ledger
      add constraint network_fee_ledger_order_kind_key
      unique (order_id, order_kind);
  end if;
end $$;
