-- Phase 2 AI staff: the MARKETER (docs/ai-staff.md → "Marketer").
--
-- 1. Win-back campaigns to past customers: marketing_campaigns + one row per recipient
--    (marketing_campaign_recipients, unique per campaign + contact — the per-recipient send
--    claim). The owner OKs each campaign by text (owner_approvals kind 'marketing_campaign').
-- 2. Google reviews fetched daily from the Places API (New) with an AI reply draft the owner
--    OKs (kind 'review_reply'); the approved reply is texted to the owner to paste.
-- 3. Weekly Google Business Profile post drafts (kind 'google_post'), one per company per week.
-- 4. marketing_sweep_claims: once-per-period claims for the marketer's sweeps (e.g. the daily
--    review fetch), so several workers never repeat a paid API call.
--
-- Settings live in companies.ai_settings.marketing (read in code, defaults there).
-- Additive and re-runnable. Members READ their own rows; every write goes through the server
-- (service role) — nothing here is client-writable (see 20261006170000 / 20261009100000).
-- Rollback: supabase/rollback/20261011130000_staff_marketer.down.sql

-- ── Campaigns ───────────────────────────────────────────────────────────────────────
create table if not exists public.marketing_campaigns (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null,
  kind text not null default 'win_back' check (kind in ('win_back', 'seasonal', 'custom')),
  status text not null default 'draft'
    check (status in ('draft', 'awaiting_owner', 'approved', 'sending', 'done', 'cancelled')),
  -- What the audience was built from: { monthsMin, monthsMax, excluded: { reason: count } }.
  audience_filter jsonb not null default '{}'::jsonb,
  message text,
  audience_count integer not null default 0,
  sent_count integer not null default 0,
  skipped_count integer not null default 0,
  failed_count integer not null default 0,
  approval_id uuid references public.owner_approvals(id) on delete set null,
  -- Send throttle captured when drafted: { perHour, startHour, endHour, days, weeklyCap }.
  send_window jsonb not null default '{}'::jsonb,
  scheduled_for timestamptz,
  -- The automatic monthly draft's period ('2026-10'); null for owner-started campaigns.
  period_key text,
  created_by text not null default 'marketer',
  cancel_reason text,
  -- Sending on hold (owner paused texts, company paused, win-back off, no company number).
  -- Held longer than 3 days → cancelled and the owner told.
  held_since timestamptz,
  hold_reason text,
  hold_notified_at timestamptz,
  approved_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade
);
create unique index if not exists marketing_campaigns_period_idx
  on public.marketing_campaigns (company_id, kind, period_key) where period_key is not null;
-- One active campaign per company (two drafts can't race).
create unique index if not exists marketing_campaigns_one_active_idx
  on public.marketing_campaigns (company_id) where status in ('draft', 'awaiting_owner', 'approved', 'sending');
create index if not exists marketing_campaigns_company_idx on public.marketing_campaigns (company_id, created_at desc);
create index if not exists marketing_campaigns_sending_idx on public.marketing_campaigns (status) where status = 'sending';

create table if not exists public.marketing_campaign_recipients (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null,
  campaign_id uuid not null references public.marketing_campaigns(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'skipped', 'failed')),
  reason text,
  last_purchase_at timestamptz,
  message_log_id uuid references public.message_log(id) on delete set null,
  provider_ref text,
  claimed_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (campaign_id, contact_id),
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade
);
create index if not exists marketing_recipients_queue_idx on public.marketing_campaign_recipients (campaign_id, status);
create index if not exists marketing_recipients_contact_idx on public.marketing_campaign_recipients (company_id, contact_id, created_at desc);
create index if not exists marketing_recipients_claimed_idx
  on public.marketing_campaign_recipients (claimed_at) where status = 'sending';
create index if not exists marketing_recipients_sent_idx on public.marketing_campaign_recipients (company_id, sent_at) where status = 'sent';

-- ── Google reviews ──────────────────────────────────────────────────────────────────
create table if not exists public.google_reviews (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null,
  -- Places API (New) review resource name: places/{placeId}/reviews/{reviewId}.
  review_name text not null,
  rating integer check (rating is null or (rating between 1 and 5)),
  -- Google content (text, author, rating, link) is kept at most 30 days, then nulled; only
  -- the review's resource name and our reply/status are kept long-term.
  text text,
  author_name text,
  published_at timestamptz,
  google_maps_uri text,
  reply_draft text,
  reply_status text not null default 'new'
    check (reply_status in ('new', 'awaiting_owner', 'approved', 'posted', 'rejected', 'expired', 'skipped', 'failed')),
  approval_id uuid references public.owner_approvals(id) on delete set null,
  owner_alerted_at timestamptz,
  owner_texted_at timestamptz,
  text_pruned_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, review_name),
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade
);
create index if not exists google_reviews_company_idx on public.google_reviews (company_id, published_at desc);

-- ── Weekly Google post drafts ───────────────────────────────────────────────────────
create table if not exists public.google_post_drafts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null,
  week_start date not null,
  topic text not null check (topic in ('offer', 'seasonal_tip', 'job_highlight')),
  body text,
  status text not null default 'draft'
    check (status in ('draft', 'awaiting_owner', 'approved', 'rejected', 'expired', 'failed')),
  approval_id uuid references public.owner_approvals(id) on delete set null,
  owner_texted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, week_start),
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade
);

-- ── Once-per-period sweep claims (service role only) ────────────────────────────────
create table if not exists public.marketing_sweep_claims (
  company_id uuid not null references public.companies(id) on delete cascade,
  task text not null,
  period_key text not null,
  created_at timestamptz not null default now(),
  primary key (company_id, task, period_key)
);

-- ── RLS: members read their own; nobody writes from the browser ─────────────────────
alter table public.marketing_campaigns enable row level security;
alter table public.marketing_campaign_recipients enable row level security;
alter table public.google_reviews enable row level security;
alter table public.google_post_drafts enable row level security;
alter table public.marketing_sweep_claims enable row level security;

drop policy if exists "marketing_campaigns_select" on public.marketing_campaigns;
create policy "marketing_campaigns_select" on public.marketing_campaigns
  for select using (public.is_organization_member(organization_id));
drop policy if exists "marketing_campaign_recipients_select" on public.marketing_campaign_recipients;
create policy "marketing_campaign_recipients_select" on public.marketing_campaign_recipients
  for select using (public.is_organization_member(organization_id));
drop policy if exists "google_reviews_select" on public.google_reviews;
create policy "google_reviews_select" on public.google_reviews
  for select using (public.is_organization_member(organization_id));
drop policy if exists "google_post_drafts_select" on public.google_post_drafts;
create policy "google_post_drafts_select" on public.google_post_drafts
  for select using (public.is_organization_member(organization_id));

revoke insert, update, delete on public.marketing_campaigns from anon, authenticated;
revoke insert, update, delete on public.marketing_campaign_recipients from anon, authenticated;
revoke insert, update, delete on public.google_reviews from anon, authenticated;
revoke insert, update, delete on public.google_post_drafts from anon, authenticated;
revoke select on public.marketing_campaigns, public.marketing_campaign_recipients, public.google_reviews, public.google_post_drafts from anon;
revoke all on public.marketing_sweep_claims from anon, authenticated;

drop trigger if exists marketing_campaigns_set_updated_at on public.marketing_campaigns;
create trigger marketing_campaigns_set_updated_at before update on public.marketing_campaigns
  for each row execute procedure public.touch_updated_at();
drop trigger if exists marketing_campaign_recipients_set_updated_at on public.marketing_campaign_recipients;
create trigger marketing_campaign_recipients_set_updated_at before update on public.marketing_campaign_recipients
  for each row execute procedure public.touch_updated_at();
drop trigger if exists google_reviews_set_updated_at on public.google_reviews;
create trigger google_reviews_set_updated_at before update on public.google_reviews
  for each row execute procedure public.touch_updated_at();
drop trigger if exists google_post_drafts_set_updated_at on public.google_post_drafts;
create trigger google_post_drafts_set_updated_at before update on public.google_post_drafts
  for each row execute procedure public.touch_updated_at();

comment on table public.marketing_campaigns is 'AI Marketer win-back campaigns (docs/ai-staff.md). Owner OKs each by text; sent throttled by the scheduler.';
comment on table public.google_reviews is 'Recent Google reviews (Places API New) with AI reply drafts. Text, author, rating and link are nulled after 30 days.';
