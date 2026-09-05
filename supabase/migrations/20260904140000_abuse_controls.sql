-- Abuse controls on unauthenticated routes (Task 5).
--
-- A DB-backed rate limiter (no Redis): one row per bucket key, a fixed window that
-- resets when it expires. `consume_rate_limit` does the whole thing in ONE atomic
-- upsert so concurrent requests can't race the counter. Service-role only (RLS on,
-- no policies) — only the rate-limit service (admin client) ever touches it.
--
-- Additive: new table + function. Nothing existing is modified.

create table public.rate_limit_buckets (
  bucket_key text primary key,
  window_started_at timestamptz not null default timezone('utc', now()),
  hits integer not null default 0
);

-- Atomically record one hit against a bucket and report whether it is still under the
-- limit. The window resets (hits -> 1, window_started_at -> now) the first time a hit
-- lands after the previous window elapsed; otherwise hits increments in place. Returns
-- true when the (post-increment) hit count is within p_limit, false when it exceeds it.
create or replace function public.consume_rate_limit(
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
  v_hits integer;
  v_expired_before timestamptz := timezone('utc', now()) - make_interval(secs => greatest(p_window_seconds, 1));
begin
  insert into public.rate_limit_buckets as bucket (bucket_key, window_started_at, hits)
  values (p_key, timezone('utc', now()), 1)
  on conflict (bucket_key) do update
    set
      -- Both CASEs read the OLD window_started_at (evaluated against the pre-update row),
      -- so the reset decision is consistent across the two assignments.
      hits = case when bucket.window_started_at <= v_expired_before then 1 else bucket.hits + 1 end,
      window_started_at = case when bucket.window_started_at <= v_expired_before then timezone('utc', now()) else bucket.window_started_at end
  returning bucket.hits into v_hits;

  return v_hits <= greatest(p_limit, 1);
end;
$$;

grant execute on function public.consume_rate_limit(text, integer, integer) to service_role;

-- RLS: service-role only (no member policies). The rate-limit service uses the admin
-- client, which bypasses RLS; anon/tenant clients can neither read nor write.
alter table public.rate_limit_buckets enable row level security;

-- Sweep stale buckets cheaply (a cron/manual DELETE can use this).
create index if not exists rate_limit_buckets_window_idx
  on public.rate_limit_buckets (window_started_at);
