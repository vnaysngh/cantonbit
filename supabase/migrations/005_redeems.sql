-- Migration 005: redeems table
--
-- Persistent record of every cBTC→BTC redemption (burn). The Canton ledger
-- alone can't drive the activity UI: the burn transaction doesn't carry the
-- amount in a readable form, and the payout status (broadcast / completed)
-- lives on attestor-side contracts our JWT can't fully observe over time.
--
-- So we store one row per burn at submit time and advance its status via the
-- on-demand /api/redeem/sync route (no background polling): the row moves
-- burned -> broadcasting -> sent, or is flagged stalled if the attestor
-- assigned a btcTxId but never broadcast it.
--
-- Per BitSafe's idempotency guidance, we persist the withdrawal request ID
-- (withdraw_request_cid) and use it for STATUS CHECKS only — never to
-- re-initiate a withdrawal.

create table if not exists public.redeems (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  canton_party_id text not null,
  destination_btc_address text not null,
  -- Decimal-string cBTC amount burned (e.g. "0.0000250000").
  amount text not null,

  -- The Canton updateId of the burn transaction (CBTCWithdrawAccount_Withdraw).
  -- Idempotency key: a given burn is recorded exactly once.
  burn_update_id text not null unique,

  -- The attestor-created CBTCWithdrawRequest contract ID — the "withdrawal
  -- request ID" BitSafe tells us to store and use for status checks. Null
  -- until the attestor picks up the burn.
  withdraw_request_cid text,

  -- The Bitcoin txid the attestor assigned. Null until the request exists.
  btc_tx_id text,

  -- Lifecycle:
  --   burned        cBTC destroyed; attestor hasn't created a request yet.
  --   broadcasting  request + btcTxId exist; waiting for the BTC to hit chain.
  --   sent          btcTxId confirmed/visible on the Bitcoin chain (terminal).
  --   stalled       btcTxId assigned but not on-chain past the threshold —
  --                 a bridge-side delay surfaced to the user (non-terminal;
  --                 can still advance to sent if the attestor rebroadcasts).
  status text not null default 'burned'
    check (status in ('burned', 'broadcasting', 'sent', 'stalled')),

  created_at timestamptz not null default now(),
  -- When the attestor's CBTCWithdrawRequest first appeared (status reached
  -- broadcasting). Used to compute the stall threshold.
  request_seen_at timestamptz,
  -- When the btcTxId was first observed on-chain (status reached sent).
  btc_confirmed_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists redeems_party_idx
  on public.redeems(canton_party_id);

create index if not exists redeems_party_status_idx
  on public.redeems(canton_party_id, status);

create index if not exists redeems_user_idx
  on public.redeems(user_id);

-- RLS: users read only their own redeems. All writes go through the service
-- role key (server-side only), which bypasses RLS.
alter table public.redeems enable row level security;

create policy "Users can read own redeems"
  on public.redeems
  for select
  using (auth.uid() = user_id);

-- Keep updated_at fresh on every write.
create or replace function public.set_redeems_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists redeems_set_updated_at on public.redeems;
create trigger redeems_set_updated_at
  before update on public.redeems
  for each row execute function public.set_redeems_updated_at();
