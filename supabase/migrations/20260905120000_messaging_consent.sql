-- Workflow messaging actions + CASL consent (Task 8).
--
-- Workflows can text/email customers and alert the owner. Consent is tracked per contact
-- (CASL/CRTC), and every outbound message is logged. See docs/messaging-compliance.md.
--
-- Additive: new nullable columns + a new table. Nothing is dropped.

-- 1) Consent state on contacts.
alter table public.contacts add column if not exists sms_consent_at timestamptz;
alter table public.contacts add column if not exists sms_opt_out_at timestamptz;
alter table public.contacts add column if not exists email_opt_out_at timestamptz;
alter table public.contacts add column if not exists consent_source text;

-- Backfill IMPLIED consent for inquiry-sourced contacts: they initiated contact, which is
-- implied consent under CASL (expires 6 months after the inquiry — enforced at send time,
-- see docs/messaging-compliance.md). Intake/Retell-created contacts carry a `source` tag in
-- metadata; manually-added contacts do not and are left with no consent (send is refused
-- until they opt in). Public-booking contacts get consent stamped going forward on create.
update public.contacts
set sms_consent_at = created_at,
    consent_source = 'implied_inquiry'
where sms_consent_at is null
  and (metadata ->> 'source') is not null;

-- 2) Owner contact points for notify_owner (fall back to OWNER_EMAIL / the org owner).
alter table public.companies add column if not exists owner_email text;
alter table public.companies add column if not exists owner_phone_e164 text;

-- 3) Message log — every outbound message (and, in Task 11, inbound) lands here.
create table public.message_log (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  company_id uuid,
  contact_id uuid,
  channel text not null,       -- 'sms' | 'email'
  direction text not null,     -- 'outbound' | 'inbound'
  provider text,
  provider_ref text,
  to_addr text,
  from_addr text,
  subject text,
  body text,
  status text not null,        -- 'sent' | 'failed' | 'blocked'
  error text,
  workflow_run_id uuid,
  created_at timestamptz not null default timezone('utc', now())
);

create index message_log_org_contact_created_idx
  on public.message_log (organization_id, contact_id, created_at desc);

-- RLS: org members read their own message history; writes are service-role only (the
-- worker runs the messaging actions on the admin client), mirroring usage_events.
alter table public.message_log enable row level security;

create policy "message_log_org_members_select"
  on public.message_log for select
  using (public.is_organization_member(organization_id));
