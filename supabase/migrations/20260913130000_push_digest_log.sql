-- Daily digest push: one row per person, per organization, per local day. The unique key
-- is the claim — a worker inserts before sending, so a second worker (or a restart in the
-- same window) cannot send the same morning digest twice. Service role only.
create table if not exists public.push_digest_log (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  digest_date date not null,
  sent_at timestamptz not null default timezone('utc', now()),
  primary key (organization_id, user_id, digest_date)
);

alter table public.push_digest_log enable row level security;
-- No policies: only the service role (the worker) reads or writes this table.
