-- AI staff: the ESTIMATOR (docs/ai-staff.md "## Estimator").
--
-- 1. estimate_requests: a customer wants a price the price list can't give (photos + a
--    description). The AI drafts an estimate, the owner OKs it by text (owner_approvals kind
--    'ai_estimate'), and it becomes a quote.
-- 2. quote_follow_ups: one row per front-desk quote the estimator nudges by text (+2d / +5d /
--    +10d) until it's booked. The row is the claim: nudges_sent only moves forward with a
--    conditional update, so overlapping workers never double-text.
-- 3. A private storage bucket `quote-photos` for the customer's MMS photos (Twilio's media URLs
--    expire). Path: {organization_id}/{company_id}/{estimate_request_id}/{n}.{ext}.
--
-- Additive and re-runnable. All writes go through the server (service role); members may READ
-- their own org's rows and photos. Nothing here is client-writable (20261006170000).
-- Rollback: supabase/rollback/20261011100000_staff_estimator.down.sql

-- ── Estimate requests ─────────────────────────────────────────────────────────────
create table if not exists public.estimate_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  conversation_id uuid references public.sms_conversations(id) on delete set null,
  description text not null,
  photos jsonb not null default '[]'::jsonb,
  status text not null default 'collecting'
    check (status in ('collecting', 'estimating', 'awaiting_owner', 'sent', 'declined', 'failed')),
  estimate jsonb,
  quote_id uuid references public.quotes(id) on delete set null,
  approval_id uuid references public.owner_approvals(id) on delete set null,
  -- The executor's claim (idempotent Y/N/expiry) and the line it reported to the owner.
  decision_claimed_at timestamptz,
  owner_result text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade
);
comment on table public.estimate_requests is
  'AI estimates for work the price list does not cover. estimate = {title, lines:[{label, amountCents, serviceKey?, custom}], subtotalCents, taxCents, totalCents, confidence, assumptions, questions}.';

-- One open estimate per customer per company (a second request while one waits is refused).
create unique index if not exists estimate_requests_open_idx
  on public.estimate_requests (company_id, contact_id)
  where status in ('estimating', 'awaiting_owner');
create index if not exists estimate_requests_company_idx
  on public.estimate_requests (company_id, status, created_at desc);
create index if not exists estimate_requests_approval_idx
  on public.estimate_requests (approval_id) where approval_id is not null;

-- ── Quote follow-ups (one row per followed quote) ─────────────────────────────────
create table if not exists public.quote_follow_ups (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null,
  contact_id uuid references public.contacts(id) on delete cascade,
  quote_id uuid not null references public.quotes(id) on delete cascade,
  nudges_sent integer not null default 0 check (nudges_sent >= 0),
  last_nudge_at timestamptz,
  stopped_at timestamptz,
  stop_reason text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (quote_id),
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade
);
create index if not exists quote_follow_ups_open_idx
  on public.quote_follow_ups (company_id, created_at) where stopped_at is null;

-- The sweep's scan: recent front-desk quotes still waiting on the customer.
create index if not exists quotes_front_desk_follow_up_idx
  on public.quotes (sent_at)
  where source in ('estimator', 'sms_agent') and status in ('sent', 'viewed');

-- ── RLS: members read their own; nobody writes from the browser ───────────────────
alter table public.estimate_requests enable row level security;
alter table public.quote_follow_ups enable row level security;

drop policy if exists "estimate_requests_select" on public.estimate_requests;
create policy "estimate_requests_select" on public.estimate_requests
  for select using (public.is_organization_member(organization_id));
drop policy if exists "quote_follow_ups_select" on public.quote_follow_ups;
create policy "quote_follow_ups_select" on public.quote_follow_ups
  for select using (public.is_organization_member(organization_id));

revoke insert, update, delete on public.estimate_requests from anon, authenticated;
revoke insert, update, delete on public.quote_follow_ups from anon, authenticated;
revoke select on public.estimate_requests, public.quote_follow_ups from anon;

drop trigger if exists estimate_requests_set_updated_at on public.estimate_requests;
create trigger estimate_requests_set_updated_at before update on public.estimate_requests
  for each row execute procedure public.touch_updated_at();
drop trigger if exists quote_follow_ups_set_updated_at on public.quote_follow_ups;
create trigger quote_follow_ups_set_updated_at before update on public.quote_follow_ups
  for each row execute procedure public.touch_updated_at();

-- ── Storage: private `quote-photos` bucket ────────────────────────────────────────
-- The org id leads the path, so member reads are a prefix check against the caller's
-- memberships (same as job-photos). Only the server (service role) writes; reads use
-- short-lived signed URLs. Never public.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('quote-photos', 'quote-photos', false, 10485760, array['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
on conflict (id) do nothing;

drop policy if exists "quote_photos_members_read" on storage.objects;
create policy "quote_photos_members_read"
  on storage.objects for select
  using (
    bucket_id = 'quote-photos'
    and exists (
      select 1 from public.organization_memberships membership
      where membership.profile_id = auth.uid()
        and membership.organization_id::text = (storage.foldername(name))[1]
    )
  );
