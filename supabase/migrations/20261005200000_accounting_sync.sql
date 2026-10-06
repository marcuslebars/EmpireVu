-- QuickBooks Online / Xero sync (one way: EmpireVu → the accounting file).
--   * accounting_connections — one per company (brand): which provider + file, its
--     account mapping and sync start date. Owners/admins can read it; only the server
--     writes it. No secrets here.
--   * accounting_tokens — the OAuth tokens, encrypted by the app (AES-256-GCM). RLS on
--     with NO policies: service role only.
--   * accounting_links — EmpireVu record ↔ remote record (customer, vendor, invoice,
--     payment, expense, deposit) per accounting file, so every push is an update, never
--     a duplicate.
--   * accounting_sync_jobs — the outbox. Database triggers on invoices, invoice payments
--     and expenses enqueue a job (coalesced per record) whenever the company has an
--     active connection; the worker claims and pushes them.
-- Rollback: supabase/rollback/20261005200000_accounting_sync.down.sql

-- ── Connections ───────────────────────────────────────────────────────────────
create table if not exists public.accounting_connections (
  company_id uuid primary key references public.companies (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  provider text not null check (provider in ('quickbooks', 'xero')),
  status text not null default 'active' check (status in ('active', 'needs_reauth')),
  -- QuickBooks realmId / Xero tenantId, and the file's name as the provider reports it.
  remote_tenant_id text not null,
  remote_name text,
  environment text not null default 'production' check (environment in ('sandbox', 'production')),
  -- Account mapping + toggles (see docs/accounting-sync.md); validated by the app.
  settings jsonb not null default '{}'::jsonb,
  -- Nothing dated before this is synced, so books already entered by hand aren't duplicated.
  sync_start_date date not null default (timezone('utc', now()))::date,
  connected_by uuid references public.profiles (id) on delete set null,
  connected_at timestamptz not null default timezone('utc', now()),
  last_sync_at timestamptz,
  last_error text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists accounting_connections_org_idx on public.accounting_connections (organization_id);

drop trigger if exists accounting_connections_set_updated_at on public.accounting_connections;
create trigger accounting_connections_set_updated_at
before update on public.accounting_connections
for each row execute procedure public.touch_updated_at();

alter table public.accounting_connections enable row level security;
drop policy if exists "accounting_connections_admin_select" on public.accounting_connections;
create policy "accounting_connections_admin_select"
  on public.accounting_connections for select
  using (public.is_organization_admin(organization_id));

-- ── Tokens (service role only) ────────────────────────────────────────────────
create table if not exists public.accounting_tokens (
  company_id uuid primary key references public.accounting_connections (company_id) on delete cascade,
  access_token_enc text not null,
  refresh_token_enc text not null,
  access_expires_at timestamptz not null,
  refresh_expires_at timestamptz,
  -- Short-lived mutex so rotating refreshes serialize across workers / requests.
  refresh_lock_at timestamptz,
  updated_at timestamptz not null default timezone('utc', now())
);

drop trigger if exists accounting_tokens_set_updated_at on public.accounting_tokens;
create trigger accounting_tokens_set_updated_at
before update on public.accounting_tokens
for each row execute procedure public.touch_updated_at();

alter table public.accounting_tokens enable row level security;
revoke all on public.accounting_tokens from anon, authenticated;

-- Take the refresh lock if it's free (or stale). A function, not a filtered PATCH: PostgREST
-- re-applies an `or` filter to the returned row, so the winner of a conditional update
-- would see no row and think it lost.
create or replace function public.claim_accounting_token_refresh(p_company_id uuid, p_stale_after_seconds integer default 30)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  update public.accounting_tokens
     set refresh_lock_at = timezone('utc', now())
   where company_id = p_company_id
     and (refresh_lock_at is null
          or refresh_lock_at < timezone('utc', now()) - make_interval(secs => greatest(p_stale_after_seconds, 1)));
  get diagnostics v_count = row_count;
  return v_count > 0;
end;
$$;

revoke all on function public.claim_accounting_token_refresh(uuid, integer) from public, anon, authenticated;
grant execute on function public.claim_accounting_token_refresh(uuid, integer) to service_role;

-- ── Links ─────────────────────────────────────────────────────────────────────
create table if not exists public.accounting_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  provider text not null check (provider in ('quickbooks', 'xero')),
  remote_tenant_id text not null,
  entity_type text not null check (entity_type in ('customer', 'vendor', 'invoice', 'payment', 'deposit', 'expense')),
  -- The EmpireVu id (or a composite key such as "contact:<uuid>" / a vendor name).
  local_key text not null,
  remote_id text not null,
  -- QuickBooks SyncToken (needed for updates); null for Xero.
  remote_version text,
  -- Hash of what was last sent, so an unchanged record is never pushed again.
  payload_hash text,
  -- The receipt file last attached (expenses), so it's attached once.
  attached_receipt_path text,
  -- Set when the provider's total differs from ours (e.g. its own tax rounding).
  note text,
  synced_at timestamptz not null default timezone('utc', now()),
  unique (company_id, provider, remote_tenant_id, entity_type, local_key)
);

create index if not exists accounting_links_local_idx on public.accounting_links (company_id, entity_type, local_key);

alter table public.accounting_links enable row level security;
drop policy if exists "accounting_links_admin_select" on public.accounting_links;
create policy "accounting_links_admin_select"
  on public.accounting_links for select
  using (public.is_organization_admin(organization_id));

-- ── Sync jobs (outbox) ────────────────────────────────────────────────────────
create table if not exists public.accounting_sync_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  entity_type text not null check (entity_type in ('invoice', 'payment', 'expense')),
  entity_id uuid not null,
  status text not null default 'pending' check (status in ('pending', 'running', 'done', 'skipped', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 6 check (max_attempts > 0),
  available_at timestamptz not null default timezone('utc', now()),
  locked_at timestamptz,
  last_error text,
  -- Why a job was skipped (before the start date, a draft, turned off…), for the status list.
  detail text,
  done_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

-- One pending job per record: further changes before it runs just bring it forward.
create unique index if not exists accounting_sync_jobs_pending_uniq
  on public.accounting_sync_jobs (company_id, entity_type, entity_id) where status = 'pending';
create index if not exists accounting_sync_jobs_due_idx
  on public.accounting_sync_jobs (available_at) where status = 'pending';
create index if not exists accounting_sync_jobs_company_idx
  on public.accounting_sync_jobs (company_id, created_at desc);

drop trigger if exists accounting_sync_jobs_set_updated_at on public.accounting_sync_jobs;
create trigger accounting_sync_jobs_set_updated_at
before update on public.accounting_sync_jobs
for each row execute procedure public.touch_updated_at();

alter table public.accounting_sync_jobs enable row level security;
drop policy if exists "accounting_sync_jobs_admin_select" on public.accounting_sync_jobs;
create policy "accounting_sync_jobs_admin_select"
  on public.accounting_sync_jobs for select
  using (public.is_organization_admin(organization_id));

grant select on public.accounting_connections, public.accounting_links, public.accounting_sync_jobs to authenticated;
grant all on public.accounting_connections, public.accounting_tokens, public.accounting_links, public.accounting_sync_jobs to service_role;

-- ── Enqueue (called by the triggers, and by the server for a backfill / retry) ─
create or replace function public.enqueue_accounting_sync(p_company_id uuid, p_entity_type text, p_entity_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
begin
  if p_company_id is null or p_entity_id is null then
    return;
  end if;
  select c.organization_id into v_org
    from public.accounting_connections c
   where c.company_id = p_company_id and c.status = 'active';
  if v_org is null then
    return; -- not connected: nothing to do (and no cost on every write)
  end if;
  insert into public.accounting_sync_jobs (organization_id, company_id, entity_type, entity_id)
  values (v_org, p_company_id, p_entity_type, p_entity_id)
  on conflict (company_id, entity_type, entity_id) where status = 'pending'
  do update set available_at = least(accounting_sync_jobs.available_at, timezone('utc', now()));
end;
$$;

revoke all on function public.enqueue_accounting_sync(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.enqueue_accounting_sync(uuid, text, uuid) to service_role;

-- Invoices: once issued, any change that matters to the books.
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

drop trigger if exists invoices_accounting_sync on public.invoices;
create trigger invoices_accounting_sync
after insert or update on public.invoices
for each row execute procedure public.accounting_enqueue_invoice();

-- Payments: recorded, removed (failed) or refunded.
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

drop trigger if exists invoice_payments_accounting_sync on public.invoice_payments;
create trigger invoice_payments_accounting_sync
after insert or update on public.invoice_payments
for each row execute procedure public.accounting_enqueue_payment();

-- Expenses: created, changed or deleted (a move between companies syncs both sides).
create or replace function public.accounting_enqueue_expense()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    perform public.enqueue_accounting_sync(old.company_id, 'expense', old.id);
    return old;
  end if;
  if tg_op = 'UPDATE' and old.company_id is distinct from new.company_id then
    perform public.enqueue_accounting_sync(old.company_id, 'expense', old.id);
  end if;
  if tg_op = 'INSERT'
     or new.spent_on is distinct from old.spent_on
     or new.vendor is distinct from old.vendor
     or new.description is distinct from old.description
     or new.category is distinct from old.category
     or new.amount_cents is distinct from old.amount_cents
     or new.tax_cents is distinct from old.tax_cents
     or new.paid_with is distinct from old.paid_with
     or new.receipt_path is distinct from old.receipt_path
     or new.company_id is distinct from old.company_id then
    perform public.enqueue_accounting_sync(new.company_id, 'expense', new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists expenses_accounting_sync on public.expenses;
create trigger expenses_accounting_sync
after insert or update or delete on public.expenses
for each row execute procedure public.accounting_enqueue_expense();

revoke all on function public.accounting_enqueue_invoice() from public, anon, authenticated;
revoke all on function public.accounting_enqueue_payment() from public, anon, authenticated;
revoke all on function public.accounting_enqueue_expense() from public, anon, authenticated;

-- ── Claim (worker) — stale-lock reclaim, exhausted retries → failed ───────────
create or replace function public.claim_accounting_sync_jobs(p_limit integer default 20, p_stale_after_seconds integer default 600)
returns setof public.accounting_sync_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.accounting_sync_jobs job
     set status = case when job.attempts >= job.max_attempts then 'failed' else 'pending' end,
         last_error = coalesce(job.last_error, 'The sync worker stopped mid-way; retrying.'),
         locked_at = null,
         available_at = timezone('utc', now())
   where job.status = 'running'
     and job.locked_at <= timezone('utc', now()) - make_interval(secs => greatest(p_stale_after_seconds, 1))
     -- a reclaimed job may collide with a newer pending one for the same record: let that one win
     and not exists (
       select 1 from public.accounting_sync_jobs p
        where p.status = 'pending' and p.company_id = job.company_id
          and p.entity_type = job.entity_type and p.entity_id = job.entity_id
     );
  update public.accounting_sync_jobs job
     set status = 'skipped', detail = 'Superseded by a newer change.', locked_at = null, done_at = timezone('utc', now())
   where job.status = 'running'
     and job.locked_at <= timezone('utc', now()) - make_interval(secs => greatest(p_stale_after_seconds, 1));

  return query
  with candidates as (
    select job.id
      from public.accounting_sync_jobs job
      join public.accounting_connections c on c.company_id = job.company_id and c.status = 'active'
     where job.status = 'pending'
       and job.available_at <= timezone('utc', now())
       -- never two jobs for the same record at once
       and not exists (
         select 1 from public.accounting_sync_jobs r
          where r.status = 'running' and r.company_id = job.company_id
            and r.entity_type = job.entity_type and r.entity_id = job.entity_id
       )
     order by
       -- invoices before their payments
       case job.entity_type when 'invoice' then 0 when 'expense' then 1 else 2 end,
       job.available_at
     for update of job skip locked
     limit greatest(p_limit, 1)
  )
  update public.accounting_sync_jobs job
     set status = 'running',
         attempts = job.attempts + 1,
         locked_at = timezone('utc', now())
    from candidates
   where job.id = candidates.id
  returning job.*;
end;
$$;

revoke all on function public.claim_accounting_sync_jobs(integer, integer) from public, anon, authenticated;
grant execute on function public.claim_accounting_sync_jobs(integer, integer) to service_role;
