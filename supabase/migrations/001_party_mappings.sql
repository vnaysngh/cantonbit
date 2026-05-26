-- Canton party mappings
-- Maps each Supabase auth user to their allocated Canton party.
-- Write-once: once a party is stored, it is never updated.
-- RLS: users can only read their own row. All writes go through the service role (server only).

create table if not exists public.party_mappings (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null unique references auth.users(id) on delete cascade,
  canton_party_id  text not null unique,
  party_hint       text not null,
  created_at       timestamptz not null default now()
);

-- Index for fast lookup by user_id (already unique so index is implicit, but be explicit)
create index if not exists party_mappings_user_id_idx on public.party_mappings(user_id);

-- Enable Row Level Security
alter table public.party_mappings enable row level security;

-- Users can only SELECT their own row — no INSERT/UPDATE/DELETE from the browser ever.
-- All writes use the service role key (server-side only).
create policy "Users can read own party mapping"
  on public.party_mappings
  for select
  using (auth.uid() = user_id);

-- Prevent any browser-side writes — service role bypasses RLS automatically.
-- No INSERT/UPDATE/DELETE policies means the browser can never write.

comment on table public.party_mappings is
  'Maps each authenticated user to their Canton Network party ID. Write-once via server service role.';

comment on column public.party_mappings.canton_party_id is
  'Full Canton party ID e.g. cbtc-user-abc::1220517bfd... Unique per user, never updated.';

comment on column public.party_mappings.party_hint is
  'The partyIdHint used when allocating the party e.g. cbtc-user-<uuid>. For debugging only.';
