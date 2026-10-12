-- Phase 4 AI staff: Compliance (docs/ai-staff.md → "Compliance"): insurance, WSIB, licences, subs.
--
-- 1. subcontractors: the subs a business hires (name, business name, trade, cell, email).
-- 2. compliance_documents: one row per certificate / policy / licence on file, for the company,
--    a crew member (profile_id) or a sub (subcontractor_id). Status pending (we asked the owner
--    whose it is) → current / expiring / expired, or replaced (a newer one of the same kind and
--    holder came in; replaced_by points at it). reminded_30_at / reminded_7_at / reminded_0_at are
--    the expiry-chase claims (one owner text per document per stage).
-- 3. compliance_upload_requests: a sub's upload link (/compliance/upload/:token), made when the
--    owner says Y to a request_sub_docs approval. 14 days, then dead.
-- 4. compliance_shares: a customer's / GC's link to ONE file (share_compliance_doc approval),
--    served through our own redirect route so it can be revoked and every open is audited.
-- 5. compliance_events: that audit trail (opens, revokes, sub uploads). Service role only.
-- 6. A private storage bucket `compliance-docs`. No storage policies: only the server reads or
--    writes it, through signed URLs.
--
-- Additive and re-runnable. Nothing here is client-writable; documents and subs are readable by
-- the org's owners/admins (names, cells, policy numbers); links and the audit trail carry tokens
-- and visitor details, so no client can read them at all.
-- Rollback: supabase/rollback/20261013120000_staff_compliance.down.sql

-- ── Subcontractors ───────────────────────────────────────────────────────────────────
create table if not exists public.subcontractors (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null,
  name text,
  business_name text,
  trade text,
  phone_e164 text check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  email text check (email is null or position('@' in email) > 1),
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint subcontractors_named check (coalesce(nullif(btrim(name), ''), nullif(btrim(business_name), '')) is not null),
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade
);
create index if not exists subcontractors_company_idx on public.subcontractors (organization_id, company_id, active);

-- ── Documents ────────────────────────────────────────────────────────────────────────
create table if not exists public.compliance_documents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null,
  kind text not null default 'other' check (kind in (
    'liability_insurance', 'wsib_clearance', 'wsib_account', 'vehicle_insurance', 'trade_licence',
    'business_licence', 'certification', 'bond', 'other'
  )),
  -- What it is in plain words when the kind is broad ("Working at Heights", "309A electrician").
  title text,
  -- Null while we wait for the owner to say whose it is (status 'pending').
  holder_type text check (holder_type in ('company', 'crew', 'subcontractor')),
  profile_id uuid references public.profiles(id) on delete set null,
  subcontractor_id uuid references public.subcontractors(id) on delete set null,
  holder_name text,
  issuer text,
  number text,
  issued_on date,
  expires_on date,
  file_path text,
  file_content_type text,
  notes text,
  uploaded_via text not null check (uploaded_via in ('sms', 'settings', 'sub_link')),
  uploaded_by text,
  status text not null default 'current' check (status in ('pending', 'current', 'expiring', 'expired', 'replaced')),
  replaced_by uuid references public.compliance_documents(id) on delete set null,
  -- Idempotency for intake ('sms:<owner_command_log id>', 'upload:<path>').
  source_key text,
  upload_request_id uuid,
  -- The AI reader's answer as read (kind, issuer, number, holder, dates), for the record.
  ai_read jsonb,
  intake_reply text,
  reminded_30_at timestamptz,
  reminded_7_at timestamptz,
  reminded_0_at timestamptz,
  -- A sub's upload: when the owner was told ("Mike's Electric sent a new WSIB clearance…").
  owner_notified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade
);
-- Whose it is: nobody yet only while we ask the owner (pending); a company document points at no
-- person; a crew document never at a sub; a sub's never at a profile. (Re-created on re-run.)
alter table public.compliance_documents drop constraint if exists compliance_documents_holder;
alter table public.compliance_documents add constraint compliance_documents_holder check (
  case
    when holder_type is null then status = 'pending'
    when holder_type = 'company' then profile_id is null and subcontractor_id is null
    when holder_type = 'crew' then subcontractor_id is null
    else profile_id is null
  end
);
create unique index if not exists compliance_documents_source_idx on public.compliance_documents (company_id, source_key) where source_key is not null;
create index if not exists compliance_documents_company_idx on public.compliance_documents (organization_id, company_id, status, kind);
create index if not exists compliance_documents_expiry_idx on public.compliance_documents (expires_on) where status in ('current', 'expiring', 'expired');
create index if not exists compliance_documents_sub_idx on public.compliance_documents (subcontractor_id) where subcontractor_id is not null;

-- ── Sub upload links ─────────────────────────────────────────────────────────────────
create table if not exists public.compliance_upload_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null,
  subcontractor_id uuid not null references public.subcontractors(id) on delete cascade,
  -- The document that ran out (or is running out), when the chase asked.
  document_id uuid references public.compliance_documents(id) on delete set null,
  approval_id uuid unique,
  token text not null unique check (token ~ '^[A-Za-z0-9_-]{32,64}$'),
  kinds text[] not null default '{}',
  channel text not null default 'sms' check (channel in ('sms', 'email')),
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed', 'blocked', 'cancelled')),
  body text,
  send_after timestamptz,
  sent_at timestamptz,
  expires_at timestamptz not null,
  uploads integer not null default 0,
  last_upload_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade
);
create index if not exists compliance_upload_requests_queue_idx on public.compliance_upload_requests (status, send_after) where status = 'queued';
create index if not exists compliance_upload_requests_sub_idx on public.compliance_upload_requests (company_id, subcontractor_id, created_at desc);

-- ── Shared links (customer / GC) ─────────────────────────────────────────────────────
create table if not exists public.compliance_shares (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null,
  document_id uuid not null references public.compliance_documents(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  approval_id uuid unique,
  token text not null unique check (token ~ '^[A-Za-z0-9_-]{32,64}$'),
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed', 'blocked', 'revoked')),
  body text,
  send_after timestamptz,
  sent_at timestamptz,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_by text,
  open_count integer not null default 0,
  last_opened_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade
);
create index if not exists compliance_shares_queue_idx on public.compliance_shares (status, send_after) where status = 'queued';
create index if not exists compliance_shares_company_idx on public.compliance_shares (organization_id, company_id, created_at desc);

-- ── Audit trail ──────────────────────────────────────────────────────────────────────
create table if not exists public.compliance_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null,
  document_id uuid,
  share_id uuid,
  request_id uuid,
  event text not null,
  actor text,
  ip text,
  user_agent text,
  detail jsonb,
  created_at timestamptz not null default now(),
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade
);
create index if not exists compliance_events_company_idx on public.compliance_events (organization_id, company_id, created_at desc);
create index if not exists compliance_events_share_idx on public.compliance_events (share_id) where share_id is not null;

-- ── RLS + grants ─────────────────────────────────────────────────────────────────────
alter table public.subcontractors enable row level security;
alter table public.compliance_documents enable row level security;
alter table public.compliance_upload_requests enable row level security;
alter table public.compliance_shares enable row level security;
alter table public.compliance_events enable row level security;

-- Names, cells, policy numbers: owners/admins read; every write goes through the server.
drop policy if exists "subcontractors_select" on public.subcontractors;
create policy "subcontractors_select" on public.subcontractors
  for select using (public.is_organization_admin(organization_id));
drop policy if exists "compliance_documents_select" on public.compliance_documents;
create policy "compliance_documents_select" on public.compliance_documents
  for select using (public.is_organization_admin(organization_id));

revoke insert, update, delete on public.subcontractors, public.compliance_documents from anon, authenticated;
revoke select on public.subcontractors, public.compliance_documents from anon;
grant select on public.subcontractors, public.compliance_documents to authenticated;
-- Tokens and visitor details: no client access at all.
revoke all on public.compliance_upload_requests, public.compliance_shares, public.compliance_events from anon, authenticated;
grant all on public.subcontractors, public.compliance_documents, public.compliance_upload_requests, public.compliance_shares, public.compliance_events to service_role;

drop trigger if exists subcontractors_set_updated_at on public.subcontractors;
create trigger subcontractors_set_updated_at before update on public.subcontractors
  for each row execute procedure public.touch_updated_at();
drop trigger if exists compliance_documents_set_updated_at on public.compliance_documents;
create trigger compliance_documents_set_updated_at before update on public.compliance_documents
  for each row execute procedure public.touch_updated_at();
drop trigger if exists compliance_upload_requests_set_updated_at on public.compliance_upload_requests;
create trigger compliance_upload_requests_set_updated_at before update on public.compliance_upload_requests
  for each row execute procedure public.touch_updated_at();
drop trigger if exists compliance_shares_set_updated_at on public.compliance_shares;
create trigger compliance_shares_set_updated_at before update on public.compliance_shares
  for each row execute procedure public.touch_updated_at();

-- ── Files (private, service role only) ───────────────────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'compliance-docs', 'compliance-docs', false, 10485760,
  array['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif']
)
on conflict (id) do nothing;
