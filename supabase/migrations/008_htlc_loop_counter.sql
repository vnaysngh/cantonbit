-- 008 — Loop-wallet counter-leg support (R1, Loop's Option 1).
--
-- Loop users' parties live on Loop's node where our cbtc-htlc DAR cannot run, so the
-- CBTC counter-leg is settled via a STANDARD transfer that auto-accepts in the user's
-- wallet (not the on-ledger HtlcLock). These columns record that path. Participant-
-- managed (email) orders leave them null and keep using allocation_cid/htlc_cid.

alter table public.htlc_orders
  add column if not exists counter_mode text
    check (counter_mode in ('managed','loop')),          -- null = managed (legacy default)
  add column if not exists counter_transfer_offer_cid text,  -- the TransferInstruction offer cid
  add column if not exists counter_transfer_update_id text;  -- the transfer submit update id
