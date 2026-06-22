-- One Canton transfer/holding can prove custody for only one HTLC order.

create unique index if not exists htlc_orders_counter_transfer_evidence_uidx
  on public.htlc_orders (counter_transfer_offer_cid)
  where counter_transfer_offer_cid is not null;
