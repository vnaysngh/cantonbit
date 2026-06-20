-- H-01: a settlement_update_id proves ONE on-ledger fee payment. Without a unique
-- constraint, one valid high-value fee update could be replayed across multiple
-- orders (each order row only constrained by (order_id, order_kind)). Bind each
-- settlement update to at most one ledger row. Partial index so NULL (not-yet-
-- recorded / absorbed) rows are unconstrained.

-- Pre-clean for DBs with pre-fix data (the bare ADD INDEX fails on dupes):
-- 1) Empty-string ids were never real update ids → normalize to NULL (the partial
--    index ignores NULL, which is the intent). "" would otherwise self-collide.
update network_fee_ledger
set settlement_update_id = null
where settlement_update_id = '';

-- 2) Genuine duplicate real ids: keep the earliest row per id, NULL the rest so the
--    audit row survives but the unique index can build. No-op on a clean DB.
update network_fee_ledger n
set settlement_update_id = null
where settlement_update_id is not null
  and ctid <> (
    select min(ctid)
    from network_fee_ledger n2
    where n2.settlement_update_id = n.settlement_update_id
  );

create unique index if not exists network_fee_ledger_settlement_update_uidx
  on network_fee_ledger (settlement_update_id)
  where settlement_update_id is not null;
