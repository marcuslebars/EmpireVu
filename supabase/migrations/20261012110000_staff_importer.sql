-- Phase 3 — Customer import (docs/ai-staff.md → "Customer import").
--
-- 1. import_links      one no-login upload link per company (/import/:token). Service role only.
-- 2. import_batches    one uploaded file: status, columns, preview, counts, undo progress.
-- 3. import_rows       the file's rows (one per distinct row: unique row hash per batch) and what
--                      each one created. Service role only (raw customer data).
-- 4. invoices.imported_at / import_batch_id / import_hold / import_key
--                      an imported open balance; import_hold keeps every reminder off it until the
--                      owner OKs chase_imported_balances; import_key makes a re-upload a no-op.
--    bookings          a unique key per company for imported past jobs (source_call_id 'import:…').
-- 5. storage bucket `customer-imports` (private, 10 MB, CSV / XLSX). No storage policies: only
--    the server (service role) signs uploads and reads files.
-- 6. accounting sync: imported balances (and payments on them) are NOT pushed to QuickBooks /
--    Xero — they came from the owner's books in the first place.
--
-- Settings live in companies.ai_settings.import (no column needed).
-- Additive, re-runnable. Owners/admins may READ their company's batches; nothing here is
-- client-writable (see 20261006170000 — the new invoice columns get no client grants).
-- Rollback: supabase/rollback/20261012110000_staff_importer.down.sql

-- ── 1. Upload links ────────────────────────────────────────────────────────────────
create table if not exists public.import_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null,
  token text not null unique,
  expires_at timestamptz not null,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id),
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade
);

-- ── 2. Batches ─────────────────────────────────────────────────────────────────────
create table if not exists public.import_batches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null,
  created_by uuid references public.profiles(id) on delete set null,
  source text not null default 'app' check (source in ('app', 'link')),
  file_name text not null,
  -- {organization_id}/{batch id}.csv|xlsx in the customer-imports bucket
  file_path text not null,
  file_size integer,
  file_kind text not null check (file_kind in ('csv', 'xlsx')),
  file_sha256 text,
  sheet_name text,
  status text not null default 'uploading'
    check (status in ('uploading', 'uploaded', 'mapped', 'previewed', 'importing', 'done', 'failed', 'undoing', 'undone', 'cancelled')),
  headers jsonb not null default '[]'::jsonb,
  samples jsonb not null default '[]'::jsonb,
  -- one field per column, in column order
  mapping jsonb not null default '[]'::jsonb,
  mapping_source text check (mapping_source is null or mapping_source in ('heuristic', 'ai', 'owner')),
  unsure_columns jsonb not null default '[]'::jsonb,
  date_orders jsonb,
  total_rows integer not null default 0,
  duplicate_rows integer not null default 0,
  preview jsonb,
  counts jsonb,
  -- the last row_index imported (−1 = none yet)
  cursor integer not null default -1,
  lease_id text,
  leased_until timestamptz,
  failures integer not null default 0,
  error text,
  owner_notified_at timestamptz,
  chase_approval_id uuid references public.owner_approvals(id) on delete set null,
  chase_status text check (chase_status is null or chase_status in ('pending', 'approved', 'declined')),
  undo_phase text check (undo_phase is null or undo_phase in ('invoices', 'bookings', 'contacts', 'accounts')),
  undo_cursor text,
  undo_report jsonb,
  import_started_at timestamptz,
  import_finished_at timestamptz,
  undone_at timestamptz,
  purged_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade
);
create index if not exists import_batches_company_idx on public.import_batches (company_id, created_at desc);
create index if not exists import_batches_work_idx on public.import_batches (updated_at)
  where status in ('uploaded', 'mapped', 'importing', 'undoing');
create index if not exists import_batches_notify_idx on public.import_batches (updated_at)
  where status = 'done' and owner_notified_at is null;
create index if not exists import_batches_sha_idx on public.import_batches (company_id, file_sha256) where file_sha256 is not null;

-- ── 3. Rows ────────────────────────────────────────────────────────────────────────
create table if not exists public.import_rows (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null,
  batch_id uuid not null references public.import_batches(id) on delete cascade,
  -- the data row's position in the file (spreadsheet row = row_index + 2)
  row_index integer not null,
  row_hash text not null,
  cells jsonb not null default '[]'::jsonb,
  outcome text check (outcome is null or outcome in ('created', 'matched', 'repeat', 'invalid', 'duplicate')),
  reason text,
  contact_id uuid,
  contact_created boolean not null default false,
  filled jsonb,
  jobs_created integer not null default 0,
  jobs_skipped integer not null default 0,
  invoice_id uuid,
  balance_cents integer not null default 0,
  balances_skipped integer not null default 0,
  account_id uuid,
  account_created boolean not null default false,
  applied_at timestamptz,
  created_at timestamptz not null default now(),
  unique (batch_id, row_hash),
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade
);
create index if not exists import_rows_batch_idx on public.import_rows (batch_id, row_index);

-- ── 4. Imported balances and past jobs ─────────────────────────────────────────────
alter table public.invoices add column if not exists imported_at timestamptz;
alter table public.invoices add column if not exists import_batch_id uuid;
alter table public.invoices add column if not exists import_hold boolean not null default false;
alter table public.invoices add column if not exists import_key text;
create unique index if not exists invoices_import_key_uniq on public.invoices (company_id, import_key) where import_key is not null;
create index if not exists invoices_import_batch_idx on public.invoices (import_batch_id) where import_batch_id is not null;
create index if not exists invoices_import_hold_idx on public.invoices (company_id) where import_hold;

create unique index if not exists bookings_import_key_uniq on public.bookings (company_id, source_call_id)
  where source_call_id like 'import:%';
create index if not exists bookings_import_source_idx on public.bookings (source) where source like 'import:%';
create index if not exists contacts_import_batch_idx on public.contacts ((metadata -> 'import' ->> 'batchId'));

-- ── RLS: owners/admins read their batches (samples hold raw customer rows — same as the API);
--    links and rows are server-only ──────────────────────────────────────────────────
alter table public.import_links enable row level security;
alter table public.import_batches enable row level security;
alter table public.import_rows enable row level security;

drop policy if exists "import_batches_select" on public.import_batches;
create policy "import_batches_select" on public.import_batches
  for select using (public.is_organization_admin(organization_id));

revoke all on public.import_links from anon, authenticated;
revoke all on public.import_rows from anon, authenticated;
revoke insert, update, delete on public.import_batches from anon, authenticated;
revoke select on public.import_batches from anon;
grant select on public.import_batches to authenticated;
grant all on public.import_links, public.import_batches, public.import_rows to service_role;

drop trigger if exists import_links_set_updated_at on public.import_links;
create trigger import_links_set_updated_at before update on public.import_links
  for each row execute procedure public.touch_updated_at();
drop trigger if exists import_batches_set_updated_at on public.import_batches;
create trigger import_batches_set_updated_at before update on public.import_batches
  for each row execute procedure public.touch_updated_at();

-- ── 5. The bucket (private; server-signed URLs only) ───────────────────────────────
-- Path: {organization_id}/{batch id}.csv|xlsx
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'customer-imports', 'customer-imports', false, 10485760,
  array['text/csv', 'text/plain', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']
)
on conflict (id) do nothing;

-- ── 6. Accounting sync leaves imported balances alone ──────────────────────────────
-- Same as 20261005200000_accounting_sync.sql, plus the imported_at guard.
create or replace function public.accounting_enqueue_invoice()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'draft' then
    return new;
  end if;
  -- An imported balance is already in the owner's books (it came from there).
  if new.imported_at is not null then
    return new;
  end if;
  if tg_op = 'INSERT'
     or new.status is distinct from old.status and (new.status = 'void' or old.status = 'draft')
     or new.total_cents is distinct from old.total_cents
     or new.line_items is distinct from old.line_items
     or new.invoice_number is distinct from old.invoice_number
     or new.issue_date is distinct from old.issue_date
     or new.due_date is distinct from old.due_date
     or new.contact_id is distinct from old.contact_id
     or new.customer_account_id is distinct from old.customer_account_id
     or new.credit_cents is distinct from old.credit_cents
     or new.bill_to is distinct from old.bill_to then
    perform public.enqueue_accounting_sync(new.company_id, 'invoice', new.id);
  end if;
  return new;
end;
$$;

create or replace function public.accounting_enqueue_payment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' and new.status <> 'succeeded' then
    return new;
  end if;
  -- A payment on an imported balance: the invoice isn't in the sync, so neither is this.
  if exists (select 1 from public.invoices i where i.id = new.invoice_id and i.imported_at is not null) then
    return new;
  end if;
  if tg_op = 'INSERT'
     or new.status is distinct from old.status
     or new.amount_cents is distinct from old.amount_cents
     or new.received_at is distinct from old.received_at
     or new.method is distinct from old.method then
    perform public.enqueue_accounting_sync(new.company_id, 'payment', new.id);
  end if;
  return new;
end;
$$;

comment on table public.import_links is 'Customer import: the no-login /import/:token upload link, one per company (docs/ai-staff.md).';
comment on table public.import_batches is 'Customer import: one uploaded customer list — mapping, preview, counts, undo (docs/ai-staff.md).';
comment on table public.import_rows is 'Customer import: the rows of a batch (unique row hash) and what each created.';
comment on column public.invoices.import_hold is 'Imported balance: no reminders (email, text, overdue automations) until the owner OKs chase_imported_balances.';
comment on column public.invoices.import_key is 'Imported balance idempotency key (unique per company): a re-upload of the same file creates nothing.';
