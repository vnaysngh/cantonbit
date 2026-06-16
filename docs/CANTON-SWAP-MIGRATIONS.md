# Apply C2C Supabase migrations (018–021)

Run against the Supabase project wired in `.env.mainnet` / `.env.devnet` (`NEXT_PUBLIC_SUPABASE_URL`).

The app fails at `POST /api/canton/swap` with `Could not find the 'counter_pending_cleared_at' column` when **021** is missing.

## Option A — Supabase CLI

```bash
supabase db push
```

(from repo root, linked to your project)

## Option B — SQL editor

Run each file in order in the Supabase dashboard SQL editor:

1. `supabase/migrations/018_canton_swap_user_leg_unique.sql`
2. `supabase/migrations/019_canton_swap_counter_reissue_attempt.sql`
3. `supabase/migrations/020_canton_swap_drop_inbound_holding_cid.sql`
4. `supabase/migrations/021_canton_swap_counter_pending_cleared.sql`

## Minimum fix (if only 021 is missing)

```sql
alter table canton_swap_orders
  add column if not exists counter_pending_cleared_at timestamptz;
```

Also ensure 019 is applied:

```sql
alter table canton_swap_orders
  add column if not exists counter_reissue_attempt int not null default 0;
```

After applying, retry the swap — no app restart required (PostgREST schema cache refreshes within ~1 min, or reload schema in dashboard).
