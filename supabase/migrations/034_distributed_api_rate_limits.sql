-- Atomic rate limits shared by all web instances.

create table if not exists public.api_rate_limits (
  key text primary key,
  window_started_at timestamptz not null,
  request_count integer not null check (request_count >= 0),
  updated_at timestamptz not null default now()
);

revoke all on table public.api_rate_limits from public, anon, authenticated;
alter table public.api_rate_limits enable row level security;

create or replace function public.consume_api_rate_limit(
  p_key text,
  p_limit integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_started timestamptz;
  v_count integer;
begin
  if p_key is null or length(p_key) = 0 or
     p_limit <= 0 or p_window_seconds <= 0 then
    return false;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('rate:' || p_key, 0));

  select window_started_at, request_count
  into v_started, v_count
  from public.api_rate_limits
  where key = p_key
  for update;

  if not found then
    insert into public.api_rate_limits (
      key, window_started_at, request_count, updated_at
    ) values (p_key, v_now, 1, v_now);
    return true;
  end if;

  if v_started + make_interval(secs => p_window_seconds) <= v_now then
    update public.api_rate_limits
    set window_started_at = v_now,
        request_count = 1,
        updated_at = v_now
    where key = p_key;
    return true;
  end if;

  if v_count >= p_limit then
    return false;
  end if;

  update public.api_rate_limits
  set request_count = request_count + 1,
      updated_at = v_now
  where key = p_key;
  return true;
end;
$$;

revoke all on function public.consume_api_rate_limit(
  text,
  integer,
  integer
) from public, anon, authenticated;

grant execute on function public.consume_api_rate_limit(
  text,
  integer,
  integer
) to service_role;
