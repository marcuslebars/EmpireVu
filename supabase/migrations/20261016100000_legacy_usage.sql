-- Everdoer rebrand, PR 1 (compatibility layer): count every use of an old (EmpireVu / CrankLeads)
-- name that the shims still accept, so we can prove "zero old traffic for 30 days" before each shim
-- is removed (REBRAND_PLAN.md §8, decision D6).
--
-- 1. legacy_usage   one row per (UTC day, kind, key): how many times it was used that day, first
--                   and last time seen, and one short sample (route path / host — never a secret,
--                   header value or body). Service role only.
-- 2. note_legacy_usage(kind, key, sample, n)   atomic upsert-and-add-n (the app batches counts in
--                   memory and flushes every ~15 s), service role only.
--
-- kind is one of: header | host | env | route | stripe_metadata | twilio_tag | twilio_signature |
-- payload_key | product_value | inbound_email_domain. key is the old name that was used
-- (e.g. 'x-empirevu-key', 'app.empirevu.com', 'CRANKLEADS_APP_BASE_URL').
--
-- Additive only and re-runnable. The app tolerates this migration not being applied yet (it logs
-- to the console and carries on).
-- Rollback: supabase/rollback/20261016100000_legacy_usage.down.sql

create table if not exists public.legacy_usage (
  day date not null default (now() at time zone 'utc')::date,
  kind text not null check (kind in (
    'header', 'host', 'env', 'route', 'stripe_metadata', 'twilio_tag', 'twilio_signature',
    'payload_key', 'product_value', 'inbound_email_domain'
  )),
  key text not null check (length(key) between 1 and 120),
  count bigint not null default 0 check (count >= 0),
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  sample text check (sample is null or length(sample) <= 200),
  primary key (day, kind, key)
);

create index if not exists legacy_usage_kind_key_idx on public.legacy_usage (kind, key, day desc);

alter table public.legacy_usage enable row level security;
revoke all on public.legacy_usage from anon, authenticated;
grant all on public.legacy_usage to service_role;

create or replace function public.note_legacy_usage(p_kind text, p_key text, p_sample text default null, p_count integer default 1)
returns void
language sql
security invoker
set search_path = public
as $$
  insert into public.legacy_usage as u (day, kind, key, count, first_seen, last_seen, sample)
  values ((now() at time zone 'utc')::date, p_kind, left(p_key, 120), greatest(1, least(coalesce(p_count, 1), 1000000)), now(), now(), left(p_sample, 200))
  on conflict (day, kind, key) do update
    set count = u.count + excluded.count,
        last_seen = now(),
        sample = coalesce(excluded.sample, u.sample);
$$;

revoke all on function public.note_legacy_usage(text, text, text, integer) from public, anon, authenticated;
grant execute on function public.note_legacy_usage(text, text, text, integer) to service_role;

comment on table public.legacy_usage is 'Everdoer rebrand: daily counts of old-name use (headers, hosts, env vars, routes, tags) accepted by the compatibility shims. Evidence for removing each shim. Service role only.';
comment on function public.note_legacy_usage(text, text, text, integer) is 'Everdoer rebrand: count n uses of an old name today (kind, key, short non-secret sample, n). Service role only.';
