-- Telnyx Voice AI receptionist integration.
--
-- Telnyx calls EmpireVu at four points in a call: customer lookup at call start,
-- a mid-call pricing tool, end-of-call lead creation, and post-call insights.
-- Those routes are public (Telnyx has no user session) and authenticate with a
-- shared secret header, so — exactly like the lead-intake route — they write via
-- the service role and org members get read-only visibility here.

-- ─────────────────────────────────────────────────────────────────────────────
-- Fast normalized-phone lookup.
--
-- Customer matching has always compared "last 10 digits" in application code
-- (see lead-intake/matching.ts), which needs a bounded table scan. The call-start
-- lookup has a ~1s budget, so it needs a real index. This generated column
-- mirrors normalizePhoneLast10() exactly, INCLUDING returning NULL when there
-- are fewer than 10 digits (too weak to match on).
-- Additive only: no existing dedup code changes.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.contacts
  add column if not exists phone_last10 text
  generated always as (
    case
      when length(regexp_replace(coalesce(phone, ''), '\D', '', 'g')) >= 10
        then right(regexp_replace(coalesce(phone, ''), '\D', '', 'g'), 10)
      else null
    end
  ) stored;

create index if not exists contacts_org_phone_last10_idx
  on public.contacts (organization_id, phone_last10);

-- ─────────────────────────────────────────────────────────────────────────────
-- Which brand was dialled.
--
-- The called number is the ONLY thing that decides the tenant — nothing in the
-- request payload can select an org or company. `source_site` is the same brand
-- key the existing lead-intake routing consumes (a1marinecare | a1marinestorage
-- | a1coatings), so a Telnyx lead routes through the identical path as a form.
-- Rows are seeded by an admin; there is no member write policy.
-- ─────────────────────────────────────────────────────────────────────────────
create table public.telnyx_numbers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  company_id uuid not null,
  phone_e164 text not null unique,
  source_site text not null,
  brand_label text,
  active boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  foreign key (company_id, organization_id)
    references public.companies (id, organization_id) on delete cascade
);

create index telnyx_numbers_org_idx on public.telnyx_numbers (organization_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Every quote the assistant asked for, including the ones we couldn't price.
-- Sales intelligence: what callers ask for, and where the assistant ran out of
-- information mid-call.
-- ─────────────────────────────────────────────────────────────────────────────
create table public.telnyx_quotes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  company_id uuid,
  telnyx_conversation_id text,
  caller_phone_last10 text,

  -- Inputs as the assistant supplied them.
  service_type text,
  boat_length_ft numeric,
  boat_type text,
  engine_type text,
  request_payload jsonb not null,

  -- Outcome: 'quoted' | 'missing_info' | 'error'.
  status text not null check (status in ('quoted', 'missing_info', 'error')),
  missing_fields text[] not null default '{}',

  -- Money is stored in cents (the pricing engine's storage API unit).
  quote_total_cents integer,
  deposit_cents integer,
  currency text not null default 'CAD',
  line_items jsonb not null default '[]'::jsonb,
  spoken_summary text,
  error_message text,

  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  foreign key (company_id, organization_id)
    references public.companies (id, organization_id) on delete set null
);

create index telnyx_quotes_conversation_idx on public.telnyx_quotes (telnyx_conversation_id);
create index telnyx_quotes_org_created_idx on public.telnyx_quotes (organization_id, created_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- One row per conversation.
--
-- Doubles as the idempotency anchor for BOTH retryable endpoints: the
-- end-of-call lead adapter stamps lead_id/contact_id here (so a Telnyx retry
-- attaches instead of creating a second lead), and the post-call Insights
-- receiver upserts the analysis onto the same row. `telnyx_conversation_id` is
-- unique, which is what makes both upserts safe.
-- ─────────────────────────────────────────────────────────────────────────────
create table public.telnyx_call_insights (
  id uuid primary key default gen_random_uuid(),
  telnyx_conversation_id text not null unique,
  organization_id uuid references public.organizations (id) on delete cascade,
  company_id uuid,
  caller_phone_last10 text,

  -- Filled by the lead adapter (endpoint 3).
  lead_id text,
  contact_id uuid,

  -- Filled by the Insights receiver (endpoint 4). Schema is unconfirmed upstream,
  -- so the raw payload is kept verbatim and the columns are best-effort reads.
  call_outcome text,
  lead_quality text,
  requested_service text,
  booked boolean,
  raw_payload jsonb,

  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  foreign key (company_id, organization_id)
    references public.companies (id, organization_id) on delete set null,
  foreign key (contact_id, organization_id)
    references public.contacts (id, organization_id) on delete set null
);

create index telnyx_call_insights_org_created_idx
  on public.telnyx_call_insights (organization_id, created_at desc);
create index telnyx_call_insights_caller_idx
  on public.telnyx_call_insights (caller_phone_last10);

-- ─────────────────────────────────────────────────────────────────────────────
-- updated_at triggers
-- ─────────────────────────────────────────────────────────────────────────────
create trigger telnyx_numbers_set_updated_at
before update on public.telnyx_numbers
for each row execute procedure public.touch_updated_at();

create trigger telnyx_quotes_set_updated_at
before update on public.telnyx_quotes
for each row execute procedure public.touch_updated_at();

create trigger telnyx_call_insights_set_updated_at
before update on public.telnyx_call_insights
for each row execute procedure public.touch_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS: read for org members, writes only via the service role (the Telnyx
-- routes), mirroring raw_leads.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.telnyx_numbers enable row level security;
alter table public.telnyx_quotes enable row level security;
alter table public.telnyx_call_insights enable row level security;

create policy "telnyx_numbers_org_members_select"
  on public.telnyx_numbers for select
  using (public.is_organization_member(organization_id));

create policy "telnyx_quotes_org_members_select"
  on public.telnyx_quotes for select
  using (public.is_organization_member(organization_id));

create policy "telnyx_call_insights_org_members_select"
  on public.telnyx_call_insights for select
  using (public.is_organization_member(organization_id));
