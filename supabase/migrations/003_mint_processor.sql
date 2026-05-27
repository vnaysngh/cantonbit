-- Tracks the last ledger offset processed by the mint processor.
-- One row per network (devnet / mainnet).
create table if not exists public.mint_processor_state (
  network text primary key,
  last_processed_offset bigint not null default 0,
  updated_at timestamptz not null default now()
);

-- Tracks every mint transfer attempt.
-- One row per holding contract (unique — prevents double processing).
create table if not exists public.mint_transfers (
  id uuid primary key default gen_random_uuid(),
  network text not null,

  -- Ledger offset where this mint transaction occurred
  ledger_offset bigint not null,

  -- The Holding contract created on warpx-mainnet-1
  holding_contract_id text not null unique,

  -- The DepositAccount contract that was archived (from ArchivedEvent)
  deposit_account_contract_id text not null,

  -- Bitcoin address resolved from coordinator (fallback lookup key)
  bitcoin_address text,

  -- User resolved from Supabase deposit_accounts
  user_id uuid references auth.users(id) on delete set null,
  canton_party_id text,

  -- Amount minted in cBTC (string to preserve decimal precision)
  amount text not null,

  -- Processing status
  status text not null default 'pending' check (status in ('pending', 'transferred', 'failed')),
  error text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists mint_transfers_status_idx on public.mint_transfers(status);
create index if not exists mint_transfers_network_idx on public.mint_transfers(network);
create index if not exists mint_transfers_deposit_account_idx on public.mint_transfers(deposit_account_contract_id);
