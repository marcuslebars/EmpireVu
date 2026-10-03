-- In-app Help assistant + "Contact support" escalation. See docs/help-assistant.md.
--
-- Additive only: two new org-scoped tables, RLS on, member policies built on
-- public.is_organization_member(). Both are written by the authenticated help routes on
-- the caller's own RLS client (no service role): a member may insert rows for an org they
-- belong to, as themselves, and read their org's rows. There are no update/delete policies —
-- the operator closes requests from the SQL editor / dashboard.

-- One row per "Contact support" click: the question, the last few chat turns, and the
-- light, non-sensitive account context the operator email carried (plan, tier, setup).
create table if not exists public.support_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  profile_id uuid references public.profiles (id) on delete set null,
  requester_email text,
  question text not null check (char_length(question) between 1 and 4000),
  -- [{ "role": "user" | "assistant", "text": "..." }, ...] — last turns only (capped in code).
  transcript jsonb not null default '[]'::jsonb,
  -- { plan, subscriptionStatus, crankleadsTier, setup: { done: [...], remaining: [...] }, ... }
  context jsonb not null default '{}'::jsonb,
  reason text not null default 'user_requested'
    check (reason in ('not_sure', 'user_requested', 'other')),
  -- Client-generated id of the Help chat session this came from (ties to help_chat_events).
  session_id uuid,
  status text not null default 'open' check (status in ('open', 'closed')),
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists support_requests_org_created_idx
  on public.support_requests (organization_id, created_at desc);

alter table public.support_requests enable row level security;

create policy "support_requests_members_select"
  on public.support_requests for select
  using (public.is_organization_member(organization_id));

create policy "support_requests_members_insert"
  on public.support_requests for insert
  with check (public.is_organization_member(organization_id) and profile_id = auth.uid());

-- Deflection tracking: one row per assistant outcome (answered / not_sure / the user asked
-- for a human / escalated / error). "Deflected" = a session with answers and no 'escalated'.
create table if not exists public.help_chat_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  profile_id uuid references public.profiles (id) on delete set null,
  session_id uuid,
  event_type text not null
    check (event_type in ('answered', 'not_sure', 'handoff_requested', 'escalated', 'error')),
  support_request_id uuid references public.support_requests (id) on delete set null,
  -- { articles: [ids], email: 'sent'|'failed'|'not_configured', model, ... } — never secrets.
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists help_chat_events_org_created_idx
  on public.help_chat_events (organization_id, created_at desc);
create index if not exists help_chat_events_session_idx
  on public.help_chat_events (session_id);

alter table public.help_chat_events enable row level security;

create policy "help_chat_events_members_select"
  on public.help_chat_events for select
  using (public.is_organization_member(organization_id));

create policy "help_chat_events_members_insert"
  on public.help_chat_events for insert
  with check (public.is_organization_member(organization_id) and profile_id = auth.uid());
