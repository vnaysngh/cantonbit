-- Loop swap user-leg receiver (no TransferPreapproval — forces offer path).
alter table canton_swap_orders
  add column if not exists settlement_party text;
