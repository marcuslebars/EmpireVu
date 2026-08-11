-- Retell AI voice receptionist — inbound phone leads.
--
-- Retell answers the call, then POSTs a signed `call_analyzed` webhook when its
-- post-call analysis is ready. The receiver writes the raw call here FIRST (this
-- table is BOTH the durable landing zone and the transcript store), then maps the
-- analysis onto the canonical lead envelope and pushes it through the SAME
-- lead-intake path as a web form — identical dedup, brand routing, activity and
-- notification.
--
-- `call_id` is unique: it is the idempotency anchor, so a Retell retry attaches to
-- the existing row instead of creating a second lead.
--
-- The webhook route is public (Retell has no user session). It authenticates with
-- Retell's HMAC signature and writes via the service role; org members get
-- read-only visibility — exactly like raw_leads and the telnyx_* tables.

create table public.retell_calls (
  id uuid primary key default gen_random_uuid(),
  -- Nullable: an unmapped source still lands durably here (flagged, service-role
  -- only) rather than being dropped. For A1 Marine Storage (tenant zero) it always
  -- resolves.
  organization_id uuid references public.organizations (id) on delete cascade,
  company_id uuid,

  -- Retell's stable call id — the idempotency anchor.
  call_id text not null unique,
  agent_id text,
  direction text,
  from_number text,
  to_number text,
  caller_phone_last10 text,

  -- Transcript store.
  transcript text,
  transcript_object jsonb,

  -- Post-call analysis (call.call_analysis), kept verbatim, plus the dashboard-defined
  -- extraction map (call_analysis.custom_analysis_data) and the derived urgency flag.
  call_summary text,
  user_sentiment text,
  call_successful boolean,
  in_voicemail boolean,
  call_analysis jsonb,
  custom_analysis_data jsonb,
  is_urgent boolean not null default false,

  -- The full webhook payload, verbatim — the durable raw record.
  event text,
  raw_payload jsonb not null,

  -- Stamped once intake runs (links the call to its lead + contact).
  lead_id text,
  contact_id uuid,

  received_at timestamptz,
  processed_at timestamptz,

  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  foreign key (company_id, organization_id)
    references public.companies (id, organization_id) on delete set null,
  foreign key (contact_id, organization_id)
    references public.contacts (id, organization_id) on delete set null
);

create index retell_calls_org_created_idx on public.retell_calls (organization_id, created_at desc);
create index retell_calls_caller_idx on public.retell_calls (caller_phone_last10);
create index retell_calls_lead_idx on public.retell_calls (lead_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- updated_at trigger
-- ─────────────────────────────────────────────────────────────────────────────
create trigger retell_calls_set_updated_at
before update on public.retell_calls
for each row execute procedure public.touch_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS: read for org members, writes only via the service role (the Retell
-- webhook), mirroring raw_leads and telnyx_call_insights.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.retell_calls enable row level security;

create policy "retell_calls_org_members_select"
  on public.retell_calls for select
  using (public.is_organization_member(organization_id));
