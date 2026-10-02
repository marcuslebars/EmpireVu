-- Missed-call catcher (CrankLeads "Catch" plan): missed-call text-back WITHOUT the AI
-- receptionist. The business keeps its own number and sets carrier conditional call
-- forwarding (no answer / busy / unreachable) to a CrankLeads Twilio number. Every call
-- that reaches that number is, by definition, a call they missed. See
-- docs/missed-call-catcher.md.
--
-- Additive:
--   1) voice_numbers.provider now also allows 'twilio'. (The inbound-SMS handler has
--      always resolved tenants by provider='twilio', but the original check constraint
--      only allowed 'retell'/'telnyx', so such a row could never be inserted. Widening a
--      check constraint only admits rows that were previously rejected.)
--   2) voice_numbers.mode — what the number does when called. Existing rows are AI
--      receptionist numbers (Retell/Telnyx), hence the default.
--   (voice_numbers.phone_e164 is already globally UNIQUE from 20260904180000 — active or
--    not — so one number can never belong to two tenants at the DB level; no extra index.)
--   3) voice_numbers.provider_number_sid — the provider's id for the number (Twilio
--      IncomingPhoneNumber SID, PN…) so provisioning can re-configure it idempotently.
--   4) missed_calls — one row per caught call (keyed by Twilio CallSid), carrying the
--      contact/lead link, the text-back throttle decision and the voicemail. Written by
--      the inbound-webhook worker (service role); org members may read it.
--
-- The raw webhook itself is persisted durably in inbound_webhook_jobs by the route
-- BEFORE it answers Twilio (provider='twilio_voice' / 'twilio_voicemail').

-- 1) provider: + 'twilio'
alter table public.voice_numbers drop constraint if exists voice_numbers_provider_check;
alter table public.voice_numbers
  add constraint voice_numbers_provider_check check (provider in ('retell', 'telnyx', 'twilio'));

-- 2) mode
alter table public.voice_numbers add column if not exists mode text not null default 'ai_receptionist';
alter table public.voice_numbers drop constraint if exists voice_numbers_mode_check;
alter table public.voice_numbers
  add constraint voice_numbers_mode_check check (mode in ('ai_receptionist', 'missed_call_catcher', 'sms_only'));

-- 3) provider number id
alter table public.voice_numbers add column if not exists provider_number_sid text;

create index if not exists voice_numbers_company_mode_idx
  on public.voice_numbers (company_id, provider, mode) where active;

-- 4) missed_calls
create table if not exists public.missed_calls (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  company_id uuid not null,
  -- Twilio CallSid (CA…). Unique: one row — and one call.missed — per call.
  call_sid text not null unique,
  provider text not null default 'twilio',
  -- The original caller (Twilio `From`), the catcher number that was reached (`To`), and
  -- the business line that forwarded it when the carrier passes it (`ForwardedFrom`).
  from_number text,
  to_number text,
  forwarded_from text,
  caller_phone_last10 text,
  caller_name text,
  contact_id uuid,
  lead_id text,
  -- 'pending' → processed; 'emitted' (call.missed dispatched → text-back),
  -- 'suppressed' (same caller inside the throttle window), 'anonymous' (no caller id),
  -- 'no_tenant' is never stored (no org to attach it to — it stays in inbound_webhook_jobs).
  text_back_status text not null default 'pending'
    check (text_back_status in ('pending', 'emitted', 'suppressed', 'anonymous')),
  -- Voicemail (Twilio <Record>): recording + optional transcription.
  recording_sid text,
  recording_url text,
  recording_duration_seconds integer,
  voicemail_at timestamptz,
  transcription_sid text,
  transcription_status text,
  transcription_text text,
  owner_alerted_at timestamptz,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  foreign key (company_id, organization_id)
    references public.companies (id, organization_id) on delete cascade,
  -- Org-scoped contact link (contacts has unique (id, organization_id)). Deleting the
  -- contact nulls ONLY contact_id (column-list SET NULL, Postgres 15+) — organization_id
  -- is not null and must survive.
  foreign key (contact_id, organization_id)
    references public.contacts (id, organization_id) on delete set null (contact_id)
);

create index if not exists missed_calls_org_created_idx
  on public.missed_calls (organization_id, created_at desc);
create index if not exists missed_calls_company_caller_idx
  on public.missed_calls (company_id, caller_phone_last10, created_at desc);
create index if not exists missed_calls_contact_idx
  on public.missed_calls (contact_id);

drop trigger if exists missed_calls_set_updated_at on public.missed_calls;
create trigger missed_calls_set_updated_at
before update on public.missed_calls
for each row execute procedure public.touch_updated_at();

alter table public.missed_calls enable row level security;

-- Members read their org's missed calls (contact page Calls tab). Writes are service-role
-- only (the inbound-webhook worker) — there is deliberately no member insert/update policy.
drop policy if exists "missed_calls_members_select" on public.missed_calls;
create policy "missed_calls_members_select"
  on public.missed_calls for select
  using (public.is_organization_member(organization_id));
