-- Migration 002: deposit_accounts table
-- Maps user_id → canton_party_id → deposit_account_contract_id → bitcoin_address
-- This allows list-deposit-accounts to return user-scoped results without
-- querying the Canton ledger, which returns ALL accounts across all users.

create table if not exists public.deposit_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  canton_party_id text not null,
  deposit_account_contract_id text not null unique,
  bitcoin_address text,
  created_at timestamptz not null default now()
);

create index if not exists deposit_accounts_user_id_idx
  on public.deposit_accounts(user_id);

create index if not exists deposit_accounts_contract_id_idx
  on public.deposit_accounts(deposit_account_contract_id);

-- Enable RLS — users can only read their own rows.
-- Writes go through the service role key (server-side only).
alter table public.deposit_accounts enable row level security;

create policy "Users can read own deposit accounts"
  on public.deposit_accounts
  for select
  using (auth.uid() = user_id);
