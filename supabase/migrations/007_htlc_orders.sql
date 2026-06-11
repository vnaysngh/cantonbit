-- HTLC swap order store (R5) — persists the trustless EVM↔Canton HTLC swaps that
-- previously lived in an in-memory Map (lost on restart). Mirrors solver_orders'
-- style: server-side only, service-role key, no RLS.
--
-- One row per swap. Columns map 1:1 to the SwapOrder shape in the service.

create table if not exists public.htlc_orders (
  -- swapId == the hashLock (keccak). Primary key, first-write-wins idempotency.
  id text primary key,

  direction text not null
    check (direction in ('evm-to-canton','canton-to-evm')),

  -- Cancore-parity lifecycle:
  --   open → accepted → main_locked → counter_locked → counter_claimed
  --        → main_claimed (completed) | refunded | cancelled | failed
  status text not null default 'open'
    check (status in ('open','accepted','main_locked','counter_locked',
                      'counter_claimed','main_claimed','refunded','cancelled','failed')),

  hash_lock text not null,            -- H = keccak256(secret), 0x-hex
  user_evm_address text not null,
  solver_evm_address text not null,
  wbtc_amount text not null,          -- base units (string for bigint safety)
  user_timelock bigint not null,      -- EVM (longer)
  user_canton_party text not null,
  solver_canton_party text not null,
  cbtc_amount text not null,          -- BTC decimal string
  solver_timelock bigint not null,    -- Canton (shorter)

  -- lifecycle data
  main_lock_tx text,                  -- EVM lock tx (step 3)
  counter_claim_update_id text,       -- Canton claim update id (step 6)
  revealed_preimage text,             -- captured at claim (0x-hex), for the EVM claim
  main_claim_tx text,                 -- EVM claim / retake tx (step 7 / refund)
  -- on-ledger HTLC (the DAR path)
  allocation_cid text,
  htlc_cid text,
  htlc_blob text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- byStatus() / active-order scans (the daemon polls these).
create index if not exists htlc_orders_status_idx on public.htlc_orders (status);

-- No RLS: touched ONLY server-side with the service-role key (bypasses RLS),
-- like solver_orders / mint_transfers.
