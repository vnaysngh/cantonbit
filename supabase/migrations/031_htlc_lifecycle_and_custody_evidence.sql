-- Durable lock claims close cancel/refund races around irreversible ledger writes.
-- Persist the Loop custody baseline so a restart cannot misclassify old vault float
-- as the user's newly deposited CBTC.

alter table public.htlc_orders
  add column if not exists solver_custody_baseline_cids text[];

alter table public.htlc_orders
  drop constraint if exists htlc_orders_status_check;

alter table public.htlc_orders
  add constraint htlc_orders_status_check
  check (
    status in (
      'open',
      'accepted',
      'main_locking',
      'main_locked',
      'counter_locking',
      'counter_locked',
      'counter_claimed',
      'main_claimed',
      'refunding',
      'refunded',
      'cancelled',
      'failed'
    )
  );

create unique index if not exists htlc_orders_loop_custody_evidence_active_uq
  on public.htlc_orders (counter_transfer_offer_cid)
  where counter_transfer_offer_cid is not null
    and direction = 'canton-to-evm'
    and counter_mode = 'loop'
    and status in (
      'main_locking',
      'main_locked',
      'counter_locking',
      'counter_locked',
      'counter_claimed'
    );
