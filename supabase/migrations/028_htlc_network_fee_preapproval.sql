-- Bind a prepared Loop HTLC fee to the exact CC TransferPreapproval contract
-- disclosed by the registry choice context. Verification must not consult the
-- receiver's current preapproval because that contract can be renewed/recreated
-- after payment but before the update is recorded.
alter table public.htlc_orders
  add column if not exists network_fee_preapproval_cid text;
