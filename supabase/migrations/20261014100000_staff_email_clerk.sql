-- Phase 5 — Email inbox (docs/ai-staff.md → "Email inbox"): the business inbox, without reading
-- Gmail through its API. The owner's mailbox auto-forwards to a private address; Resend Inbound
-- receives it and calls our signed webhook.
--
-- 1. email_inboxes        one per company: `<slug>-<8 random>@<INBOUND_EMAIL_DOMAIN>`, when
--                         forwarding was asked for / first worked, the last email. Owners/admins
--                         read (anyone who knows the address can drop mail into the inbox).
-- 2. inbound_emails       every email received: unique Message-ID per inbox and unique provider id
--                         (a webhook retry is a no-op), sender, recipients, subject, text (capped),
--                         a sanitized HTML excerpt, the In-Reply-To / References chain + thread key,
--                         what it is (category), the links it got (contact, booking, supplier, PO,
--                         message_log, task), the drafted reply and its approval, the owner-alert
--                         and digest state, and the processing claim (status, attempts, lease).
--                         Owners/admins read.
-- 3. email_attachments    the files kept from an email (allowlisted types, ≤ 10 MB), stored in the
--                         private `email-attachments` bucket at a server-built path. Owners/admins read.
-- 4. email_clerk_digests  the daily digest claim: one row per company per local day. Service role only.
-- 5. A private storage bucket `email-attachments` (10 MB, allowlisted types), no storage policies:
--    only the server reads or writes it, through signed URLs.
--
-- Settings live in companies.ai_settings.email_clerk (no column needed). Every write goes through the
-- server (service role); nothing here is client-writable (see 20261006170000). Additive and
-- re-runnable.
-- Rollback: supabase/rollback/20261014100000_staff_email_clerk.down.sql

-- ── 1. email_inboxes ─────────────────────────────────────────────────────────────────
create table if not exists public.email_inboxes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null unique,
  address text not null unique check (address = lower(address) and address ~ '^[a-z0-9][a-z0-9-]{0,40}@[a-z0-9.-]+\.[a-z]{2,}$'),
  forwarded_from text check (forwarded_from is null or length(forwarded_from) <= 254),
  forwarding_requested_at timestamptz,
  forwarding_confirmed_at timestamptz,
  last_received_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade
);

-- ── 2. inbound_emails ────────────────────────────────────────────────────────────────
create table if not exists public.inbound_emails (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null,
  inbox_id uuid not null references public.email_inboxes(id) on delete cascade,
  provider text not null default 'resend',
  provider_email_id text not null check (length(provider_email_id) between 1 and 200),
  message_id text not null check (length(message_id) between 3 and 300),
  from_address text,
  from_name text,
  to_addresses text[] not null default '{}',
  cc_addresses text[] not null default '{}',
  reply_to text,
  subject text,
  text_body text check (text_body is null or length(text_body) <= 20000),
  html_excerpt text check (html_excerpt is null or length(html_excerpt) <= 20000),
  in_reply_to text,
  reference_ids text[] not null default '{}',
  thread_key text,
  headers jsonb,
  auth jsonb,
  attachments_meta jsonb not null default '[]'::jsonb,
  received_at timestamptz not null default now(),
  -- new → received → processing → done | failed (retried after 10 min) | dead (3 tries used) | ignored
  status text not null default 'new',
  attempts integer not null default 0,
  locked_until timestamptz,
  last_error text,
  category text check (category is null or category in (
    'forwarding_confirmation', 'auto_reply', 'bounce', 'newsletter', 'no_reply', 'spam',
    'customer', 'supplier', 'bid_invite', 'bill', 'other'
  )),
  classified_by text check (classified_by is null or classified_by in ('rules', 'model', 'fallback')),
  -- vendor / GC name, amount, due date, project, PO number, forwarding provider (never the code).
  detail jsonb,
  ai_summary text,
  contact_id uuid references public.contacts(id) on delete set null,
  booking_id uuid references public.bookings(id) on delete set null,
  supplier_id uuid,
  purchase_order_id uuid,
  message_log_id uuid,
  task_id uuid,
  draft_subject text,
  draft_reply text check (draft_reply is null or length(draft_reply) <= 4000),
  approval_id uuid,
  reply_status text not null default 'none' check (reply_status in (
    'none', 'no_draft', 'awaiting_owner', 'sending', 'sent', 'skipped', 'expired', 'superseded', 'blocked', 'failed'
  )),
  replied_at timestamptz,
  owner_alert_status text not null default 'none',
  owner_alerted_at timestamptz,
  digest_date date,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade
);
-- The checks are (re)created by name, so a re-run picks up new values.
alter table public.inbound_emails drop constraint if exists inbound_emails_status_check;
alter table public.inbound_emails add constraint inbound_emails_status_check
  check (status in ('new', 'received', 'processing', 'done', 'failed', 'ignored', 'dead'));
alter table public.inbound_emails drop constraint if exists inbound_emails_owner_alert_status_check;
alter table public.inbound_emails add constraint inbound_emails_owner_alert_status_check
  check (owner_alert_status in ('none', 'sending', 'held', 'sent', 'dropped', 'approval', 'digest'));

create unique index if not exists inbound_emails_message_idx on public.inbound_emails (inbox_id, message_id);
create unique index if not exists inbound_emails_provider_idx on public.inbound_emails (provider, provider_email_id);
create unique index if not exists inbound_emails_approval_idx on public.inbound_emails (approval_id) where approval_id is not null;
-- The sweep's queue: only rows that can still be claimed (dead / done / ignored never are).
drop index if exists public.inbound_emails_queue_idx;
create index if not exists inbound_emails_claim_idx on public.inbound_emails (status, created_at) where status in ('new', 'received', 'processing', 'failed');
create index if not exists inbound_emails_company_idx on public.inbound_emails (organization_id, company_id, received_at desc);
create index if not exists inbound_emails_held_idx on public.inbound_emails (company_id) where owner_alert_status = 'held';
create index if not exists inbound_emails_contact_idx on public.inbound_emails (contact_id) where contact_id is not null;
create index if not exists inbound_emails_thread_idx on public.inbound_emails (inbox_id, thread_key);

-- ── 3. email_attachments ─────────────────────────────────────────────────────────────
create table if not exists public.email_attachments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null,
  inbound_email_id uuid not null references public.inbound_emails(id) on delete cascade,
  provider_attachment_id text not null,
  filename text check (filename is null or length(filename) <= 200),
  content_type text,
  size_bytes bigint check (size_bytes is null or size_bytes >= 0),
  storage_path text unique,
  status text not null check (status in ('stored', 'skipped_type', 'skipped_size', 'failed')),
  created_at timestamptz not null default now(),
  constraint email_attachments_stored_has_path check (status <> 'stored' or storage_path is not null),
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade
);
create unique index if not exists email_attachments_once_idx on public.email_attachments (inbound_email_id, provider_attachment_id);
create index if not exists email_attachments_company_idx on public.email_attachments (organization_id, company_id);

-- ── 4. email_clerk_digests ───────────────────────────────────────────────────────────
create table if not exists public.email_clerk_digests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null,
  local_date date not null,
  status text not null default 'claimed' check (status in ('claimed', 'sent', 'failed', 'skipped')),
  attempts integer not null default 1,
  body text,
  email_ids uuid[] not null default '{}',
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, local_date),
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade
);

-- ── RLS + grants ─────────────────────────────────────────────────────────────────────
alter table public.email_inboxes enable row level security;
alter table public.inbound_emails enable row level security;
alter table public.email_attachments enable row level security;
alter table public.email_clerk_digests enable row level security;

-- The address and customers' mail: owners/admins read; every write goes through the server.
drop policy if exists "email_inboxes_select" on public.email_inboxes;
create policy "email_inboxes_select" on public.email_inboxes
  for select using (public.is_organization_admin(organization_id));
drop policy if exists "inbound_emails_select" on public.inbound_emails;
create policy "inbound_emails_select" on public.inbound_emails
  for select using (public.is_organization_admin(organization_id));
drop policy if exists "email_attachments_select" on public.email_attachments;
create policy "email_attachments_select" on public.email_attachments
  for select using (public.is_organization_admin(organization_id));

revoke insert, update, delete on public.email_inboxes, public.inbound_emails, public.email_attachments from anon, authenticated;
revoke select on public.email_inboxes, public.inbound_emails, public.email_attachments from anon;
grant select on public.email_inboxes, public.inbound_emails, public.email_attachments to authenticated;
-- The digest claim: no client access at all.
revoke all on public.email_clerk_digests from anon, authenticated;
grant all on public.email_inboxes, public.inbound_emails, public.email_attachments, public.email_clerk_digests to service_role;

drop trigger if exists email_inboxes_set_updated_at on public.email_inboxes;
create trigger email_inboxes_set_updated_at before update on public.email_inboxes
  for each row execute procedure public.touch_updated_at();
drop trigger if exists inbound_emails_set_updated_at on public.inbound_emails;
create trigger inbound_emails_set_updated_at before update on public.inbound_emails
  for each row execute procedure public.touch_updated_at();
drop trigger if exists email_clerk_digests_set_updated_at on public.email_clerk_digests;
create trigger email_clerk_digests_set_updated_at before update on public.email_clerk_digests
  for each row execute procedure public.touch_updated_at();

-- ── 5. Files (private, service role only) ────────────────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'email-attachments', 'email-attachments', false, 10485760,
  array[
    'application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif',
    'text/plain', 'text/csv', 'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ]
)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
