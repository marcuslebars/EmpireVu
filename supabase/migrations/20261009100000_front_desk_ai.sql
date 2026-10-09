-- Phase 1: the AI front desk (docs/front-desk-ai.md).
--
-- 1. An AI that carries text conversations with a business's customers (sms_conversations).
-- 2. The owner runs the business by text: approval requests + commands (owner_approvals,
--    owner_command_log).
-- 3. AI phone answering on every plan (settings in companies.ai_settings).
-- 4. A weekly "what your front desk did" report (weekly_report_sends).
-- Also: picture messages (MMS) are kept on message_log.media.
--
-- Additive only. All writes go through the server (service role); members may READ their own
-- rows. Nothing here is client-writable (see 20261006170000_lock_privileged_columns).
-- Rollback: supabase/rollback/20261009100000_front_desk_ai.down.sql

alter table public.companies
  add column if not exists ai_settings jsonb not null default '{}'::jsonb;
comment on column public.companies.ai_settings is
  'AI front desk settings: { sms_agent: {enabled, autonomy}, call_answering: {mode, ...}, weekly_report: {enabled, channels} }. Missing keys = defaults in code.';

alter table public.message_log
  add column if not exists media jsonb;
comment on column public.message_log.media is
  'Picture/MMS attachments on an inbound text: [{ url, contentType, storagePath? }].';

-- ── Text conversations the AI is carrying, one per customer per company ─────────────
create table if not exists public.sms_conversations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  state text not null default 'ai' check (state in ('ai', 'owner', 'paused', 'closed')),
  ai_turns integer not null default 0,
  last_inbound_at timestamptz,
  last_ai_reply_at timestamptz,
  owner_takeover_at timestamptz,
  collected jsonb not null default '{}'::jsonb,
  summary text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, contact_id),
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade
);
create index if not exists sms_conversations_org_idx on public.sms_conversations (organization_id, updated_at desc);

-- ── Things the AI wants the owner to OK ("Reply Y to send") ───────────────────────
create table if not exists public.owner_approvals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null,
  contact_id uuid references public.contacts(id) on delete set null,
  conversation_id uuid references public.sms_conversations(id) on delete set null,
  kind text not null,
  summary text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'expired', 'superseded', 'executed', 'failed')),
  short_code integer,
  requested_by text not null default 'sms_agent',
  notified_at timestamptz,
  decided_at timestamptz,
  decided_via text check (decided_via is null or decided_via in ('sms', 'app', 'auto', 'expiry')),
  decided_by text,
  result jsonb,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade
);
create index if not exists owner_approvals_pending_idx on public.owner_approvals (company_id, status, created_at);
create unique index if not exists owner_approvals_short_code_open_idx
  on public.owner_approvals (company_id, short_code) where status = 'pending';

-- ── Every text the owner sent us and what we did with it (service role only) ──────
create table if not exists public.owner_command_log (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,
  company_id uuid references public.companies(id) on delete set null,
  from_phone text not null,
  to_phone text,
  provider_ref text,
  body text,
  intent text,
  result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create unique index if not exists owner_command_log_ref_idx on public.owner_command_log (provider_ref) where provider_ref is not null;
create index if not exists owner_command_log_org_idx on public.owner_command_log (organization_id, created_at desc);

-- ── Weekly report sends (one per company per week) ────────────────────────────────
create table if not exists public.weekly_report_sends (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null,
  week_start date not null,
  status text not null default 'claimed' check (status in ('claimed', 'sent', 'skipped', 'failed')),
  channels text[] not null default '{}',
  metrics jsonb not null default '{}'::jsonb,
  sent_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, week_start),
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade
);

-- ── RLS: members read their own; nobody writes from the browser ───────────────────
alter table public.sms_conversations enable row level security;
alter table public.owner_approvals enable row level security;
alter table public.owner_command_log enable row level security;
alter table public.weekly_report_sends enable row level security;

drop policy if exists "sms_conversations_select" on public.sms_conversations;
create policy "sms_conversations_select" on public.sms_conversations
  for select using (public.is_organization_member(organization_id));
drop policy if exists "owner_approvals_select" on public.owner_approvals;
create policy "owner_approvals_select" on public.owner_approvals
  for select using (public.is_organization_member(organization_id));
drop policy if exists "weekly_report_sends_select" on public.weekly_report_sends;
create policy "weekly_report_sends_select" on public.weekly_report_sends
  for select using (public.is_organization_member(organization_id));

revoke insert, update, delete on public.sms_conversations from anon, authenticated;
revoke insert, update, delete on public.owner_approvals from anon, authenticated;
revoke insert, update, delete on public.weekly_report_sends from anon, authenticated;
revoke all on public.owner_command_log from anon, authenticated;
revoke select on public.sms_conversations, public.owner_approvals, public.weekly_report_sends from anon;

drop trigger if exists sms_conversations_set_updated_at on public.sms_conversations;
create trigger sms_conversations_set_updated_at before update on public.sms_conversations
  for each row execute procedure public.touch_updated_at();
drop trigger if exists owner_approvals_set_updated_at on public.owner_approvals;
create trigger owner_approvals_set_updated_at before update on public.owner_approvals
  for each row execute procedure public.touch_updated_at();
drop trigger if exists weekly_report_sends_set_updated_at on public.weekly_report_sends;
create trigger weekly_report_sends_set_updated_at before update on public.weekly_report_sends
  for each row execute procedure public.touch_updated_at();
