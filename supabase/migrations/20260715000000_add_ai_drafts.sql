-- AI drafts: the durable record of a Claude lead analysis and the reply drafted from it.
--
-- Phase B/C kept the analysis only in memory (the contact AI tab held it in client
-- state; the ai_analyze workflow action flattened it into a task description string),
-- so there was nothing to attach a send button to. This table makes a draft a real
-- object: editable, reviewable, and sendable exactly once per channel.
--
-- Policy: draft-first. Nothing here is ever sent automatically — a row starts at
-- status 'draft' on both channels and only an explicit human action moves it to 'sent'.

create table public.ai_drafts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  company_id uuid not null,
  contact_id uuid not null,

  -- The full structured LeadAnalysis exactly as Claude returned it (audit trail:
  -- what the model actually said, before any human edits below).
  analysis jsonb not null,

  -- The editable reply. Seeded from analysis, then owned by the human reviewer.
  email_subject text,
  email_body text,
  sms_body text,

  -- AI-proposed booking slots: [{ startsAt, durationMinutes, reason }, ...].
  -- Proposals only — a booking exists only once a human confirms one (booking_id).
  proposed_slots jsonb not null default '[]'::jsonb,
  booking_id uuid,

  email_status text not null default 'draft' check (email_status in ('draft', 'sent', 'failed')),
  email_sent_at timestamptz,
  email_error text,

  sms_status text not null default 'draft' check (sms_status in ('draft', 'sent', 'failed')),
  sms_sent_at timestamptz,
  sms_error text,

  -- Null when the draft was created by the workflow worker rather than a person.
  created_by uuid references public.profiles (id) on delete set null,
  workflow_id uuid,

  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),

  -- Composite FKs keep company/contact/booking inside the same organization.
  foreign key (company_id, organization_id)
    references public.companies (id, organization_id) on delete cascade,
  foreign key (contact_id, organization_id)
    references public.contacts (id, organization_id) on delete cascade,
  foreign key (booking_id, organization_id)
    references public.bookings (id, organization_id) on delete set null,
  foreign key (workflow_id, organization_id)
    references public.workflows (id, organization_id) on delete set null
);

create index ai_drafts_contact_created_idx on public.ai_drafts (contact_id, created_at desc);
create index ai_drafts_org_created_idx on public.ai_drafts (organization_id, created_at desc);

create trigger ai_drafts_set_updated_at
before update on public.ai_drafts
for each row execute procedure public.touch_updated_at();

alter table public.ai_drafts enable row level security;

-- Org members read and write their own org's drafts. The workflow worker writes via
-- the service role (RLS-bypassing) like the rest of the engine; no delete policy —
-- drafts are the audit trail of what was sent to a customer.
create policy "ai_drafts_org_members_select"
on public.ai_drafts
for select
using (public.is_organization_member(organization_id));

create policy "ai_drafts_org_members_insert"
on public.ai_drafts
for insert
with check (public.is_organization_member(organization_id));

create policy "ai_drafts_org_members_update"
on public.ai_drafts
for update
using (public.is_organization_member(organization_id))
with check (public.is_organization_member(organization_id));
