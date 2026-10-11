-- Phase 3 AI staff: Keep your number (docs/ai-staff.md → "Keep your number").
--
-- 1. number_port_requests: one row per port-in (the owner's business line moving to our Twilio
--    account). Status collecting → ready → submitted → foc_scheduled → completed, or rejected /
--    cancelled. The carrier account number and PIN are stored ONLY as AES-256-GCM ciphertext
--    (server key PORTING_ENCRYPTION_KEY, never in the database) and purged 14 days after the
--    port completes or is cancelled.
-- 2. business_line_calls: one row per call to a ported business line (rings the owner first),
--    so the "press 1 to take it" screen is recorded server-side.
-- 3. voice_numbers.mode gains 'business_line' (the ported main number: rings the owner's cell
--    first, then the existing missed-call / AI answering path).
-- 4. A private storage bucket `porting-docs` (phone bill + signed LOA). No storage policies:
--    only the server (service role) reads or writes it, through signed URLs.
--
-- Additive and re-runnable. NOTHING here is client-readable or client-writable: the port rows
-- carry the carrier account details (encrypted), the authorized name and the service address,
-- so every read goes through owner/admin or operator server routes.
-- Rollback: supabase/rollback/20261012120000_staff_porting.down.sql

-- ── voice_numbers.mode: the ported business line ────────────────────────────────────
alter table public.voice_numbers drop constraint if exists voice_numbers_mode_check;
alter table public.voice_numbers
  add constraint voice_numbers_mode_check check (mode in ('ai_receptionist', 'missed_call_catcher', 'sms_only', 'business_line'));

-- ── Port requests ───────────────────────────────────────────────────────────────────
create table if not exists public.number_port_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null,
  -- The /port/:token link (the token is the credential for the owner's form).
  token text not null unique check (token ~ '^[A-Za-z0-9_-]{32,64}$'),
  status text not null default 'collecting'
    check (status in ('collecting', 'ready', 'submitted', 'foc_scheduled', 'completed', 'rejected', 'cancelled')),
  numbers text[] not null default '{}',
  carrier text,
  business_name text,
  authorized_name text,
  service_address jsonb,
  -- Carrier account details: ciphertext only ("v1.<iv>.<tag>.<data>", AES-256-GCM, AAD = row id).
  account_number_enc text,
  account_number_last4 text,
  pin_enc text,
  -- stored: encrypted PIN on file; none: the owner says there's no PIN; call: we'll call for it.
  pin_status text not null default 'none' check (pin_status in ('none', 'stored', 'call')),
  secrets_purged_at timestamptz,
  bill_path text,
  bill_content_type text,
  bill_uploaded_at timestamptz,
  loa_path text,
  loa_sha256 text,
  loa_signed_at timestamptz,
  loa_signed_name text,
  loa_signed_ip text,
  loa_signed_user_agent text,
  twilio_port_request_id text,
  foc_date date,
  rejection_reason text,
  -- Numbers already attached to the company as business lines (completion sweep).
  attached_numbers text[] not null default '{}',
  created_via text not null default 'settings' check (created_via in ('settings', 'owner_text', 'operator')),
  -- Owner status texts: the status whose text is due, and the last one sent (idempotent).
  notify_status text,
  notified_status text,
  ready_at timestamptz,
  submitted_at timestamptz,
  foc_set_at timestamptz,
  completed_at timestamptz,
  rejected_at timestamptz,
  cancelled_at timestamptz,
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade
);
-- One open port per company (a rejected port is reopened by the owner, not replaced).
create unique index if not exists number_port_requests_open_idx
  on public.number_port_requests (company_id)
  where status in ('collecting', 'ready', 'submitted', 'foc_scheduled', 'rejected');
create index if not exists number_port_requests_status_idx on public.number_port_requests (status, updated_at);
create index if not exists number_port_requests_company_idx on public.number_port_requests (organization_id, company_id, created_at desc);

-- ── Calls to a ported business line (ring the owner first) ──────────────────────────
create table if not exists public.business_line_calls (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null,
  call_sid text not null unique,
  business_line text not null,
  rang text[] not null default '{}',
  screen boolean not null default true,
  accepted_at timestamptz,
  outcome text check (outcome in ('answered', 'missed')),
  created_at timestamptz not null default now(),
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade
);
create index if not exists business_line_calls_company_idx on public.business_line_calls (organization_id, company_id, created_at desc);

-- ── RLS: no client access at all (server routes only) ──────────────────────────────
alter table public.number_port_requests enable row level security;
alter table public.business_line_calls enable row level security;
revoke all on public.number_port_requests from anon, authenticated;
revoke all on public.business_line_calls from anon, authenticated;

drop trigger if exists number_port_requests_set_updated_at on public.number_port_requests;
create trigger number_port_requests_set_updated_at before update on public.number_port_requests
  for each row execute procedure public.touch_updated_at();

-- ── Bill + LOA files (private, service role only) ───────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'porting-docs', 'porting-docs', false, 10485760,
  array['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
)
on conflict (id) do nothing;
