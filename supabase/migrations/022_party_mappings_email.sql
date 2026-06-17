-- Store the Supabase auth email on party_mappings for ops/support lookups.
-- Synced on provision, OAuth callback, and Loop registration when available.

alter table public.party_mappings
  add column if not exists email text;

create index if not exists party_mappings_email_idx
  on public.party_mappings (lower(email))
  where email is not null;

comment on column public.party_mappings.email is
  'Normalized auth email from Supabase (Google / email OTP). Null for Loop-only sessions without auth email.';

-- Backfill from auth.users for rows created before this column existed.
update public.party_mappings pm
set email = lower(trim(u.email))
from auth.users u
where pm.user_id = u.id
  and u.email is not null
  and trim(u.email) <> ''
  and pm.email is null;
