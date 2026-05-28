-- Mint processor hardening: state machine + concurrency control.
--
-- Motivation (incident 2026-05-27): re-running the processor created
-- DUPLICATE TransferOffers for the same mint, because:
--   1. Two triggers (frontend poll + cron) could run concurrently with no lock.
--   2. On retry, the processor re-ran Phase 1 (offer creation) instead of
--      recognizing an offer already existed, so it created another.
--
-- This migration adds:
--   * offer_contract_id / offer_update_id columns to persist the created
--     offer BEFORE accepting it, so retries accept the existing offer
--     instead of creating a new one.
--   * 'processing' and 'offer_created' states to the status machine.
--   * RPC helpers for a global advisory lock and an atomic row claim.

-- ---------------------------------------------------------------------------
-- 1. New columns + extended status enum
-- ---------------------------------------------------------------------------

alter table public.mint_transfers
  add column if not exists offer_contract_id text,
  add column if not exists offer_update_id text;

-- Replace the status CHECK constraint to allow the new intermediate states.
-- States: pending → processing → offer_created → transferred
--         (any → failed on error)
alter table public.mint_transfers
  drop constraint if exists mint_transfers_status_check;

alter table public.mint_transfers
  add constraint mint_transfers_status_check
  check (status in ('pending', 'processing', 'offer_created', 'transferred', 'failed'));

-- ---------------------------------------------------------------------------
-- 2. Lease-based global lock (serialize the whole processor per network)
-- ---------------------------------------------------------------------------
--
-- NOTE: We deliberately do NOT use pg_advisory_lock here. Advisory locks are
-- session-scoped, and Supabase PostgREST runs every RPC on a separate pooled
-- connection — so a lock taken in one RPC call is released the instant that
-- call's connection returns to the pool, and the unlock RPC runs on a
-- different session entirely. Session advisory locks are therefore useless
-- across separate PostgREST requests.
--
-- Instead we use a LEASE: a single atomic UPDATE that grabs the lock only if
-- it's free or the previous lease has expired. One statement = one request =
-- atomic. The lease auto-expires so a crashed run can't deadlock the system.

alter table public.mint_processor_state
  add column if not exists locked_until timestamptz;

-- Try to acquire the processor lease for p_lease_seconds. Returns true if
-- acquired (lock was free or expired), false if another run holds a live lease.
create or replace function public.try_lock_mint_processor(
  p_network text,
  p_lease_seconds int default 120
)
returns boolean
language plpgsql
as $$
declare
  rows_updated int;
begin
  -- Ensure a state row exists so the UPDATE has something to target.
  insert into public.mint_processor_state (network, last_processed_offset)
  values (p_network, 0)
  on conflict (network) do nothing;

  update public.mint_processor_state
     set locked_until = now() + make_interval(secs => p_lease_seconds),
         updated_at = now()
   where network = p_network
     and (locked_until is null or locked_until < now());

  get diagnostics rows_updated = row_count;
  return rows_updated = 1;
end;
$$;

-- Release the lease (best-effort; the lease also auto-expires).
create or replace function public.unlock_mint_processor(p_network text)
returns boolean
language plpgsql
as $$
begin
  update public.mint_processor_state
     set locked_until = null, updated_at = now()
   where network = p_network;
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Atomic per-holding row claim
-- ---------------------------------------------------------------------------

-- Atomically transition a mint_transfers row to 'processing' so a single
-- worker owns it. Returns the claimed row's id, or NULL if the row is already
-- 'transferred', or actively 'processing' by a recent worker.
--
-- This is the PRIMARY duplicate guard: even if two workers run concurrently
-- (the lease lock is best-effort), this single atomic UPDATE means only one
-- can claim a given holding.
--
-- A row stuck in 'processing' is reclaimable after p_stale_seconds, so a
-- crashed run (e.g. died after claim but before completing) self-heals on the
-- next pass instead of being stranded forever.
-- p_stale_seconds defaults to 900 (15 min) — deliberately LONGER than the
-- processor lease (300s). This way, even if two processor runs briefly overlap
-- (a run exceeding its lease while another acquires it), an actively-processing
-- row is NOT reclaimed out from under the still-running worker; only a genuinely
-- crashed/abandoned row (idle > 15 min) is reclaimed.
create or replace function public.claim_mint_transfer(
  p_holding_contract_id text,
  p_stale_seconds int default 900
)
returns uuid
language plpgsql
as $$
declare
  claimed_id uuid;
begin
  update public.mint_transfers
     set status = 'processing',
         updated_at = now()
   where holding_contract_id = p_holding_contract_id
     and (
       status in ('pending', 'failed', 'offer_created')
       or (status = 'processing' and updated_at < now() - make_interval(secs => p_stale_seconds))
     )
  returning id into claimed_id;

  return claimed_id;
end;
$$;

-- Expose RPCs to the service role only (these are called server-side with the
-- service key). PostgREST exposes any function in the public schema; RLS does
-- not apply to functions, so access is gated by the service-role key.
grant execute on function public.try_lock_mint_processor(text, int) to service_role;
grant execute on function public.unlock_mint_processor(text) to service_role;
grant execute on function public.claim_mint_transfer(text, int) to service_role;
