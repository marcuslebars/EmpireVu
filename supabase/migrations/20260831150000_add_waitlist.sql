-- Public waitlist / early-access signups from the empirevu.com marketing site.
--
-- Platform-level data, NOT tenant-scoped: the only writer is the public
-- POST /api/waitlist route, which runs on the service-role admin client. RLS is
-- ENABLED with NO policies, so anon/tenant clients can neither read nor write —
-- signups stay private, and only the service role (which bypasses RLS) inserts.

create table if not exists public.waitlist (
  id uuid primary key default gen_random_uuid(),
  email citext not null,
  business text,
  source text not null default 'empirevu.com',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

-- One row per email (case-insensitive via citext) — a repeat signup is a no-op,
-- not a duplicate. The route upserts with ignoreDuplicates against this index.
create unique index if not exists waitlist_email_uniq on public.waitlist (email);

alter table public.waitlist enable row level security;

comment on table public.waitlist is
  'Early-access signups from the empirevu.com marketing site (service-role writes only).';
