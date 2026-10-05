-- Review requests: after a job is done (or its invoice is paid) the brand's customer gets a
-- text or email asking for a review, through a tracked short link (/r/{token}) that
-- forwards to the brand's review page (companies.brand_review_url). One row per ask.
-- Settings per brand live in companies.review_settings (jsonb, defaulted in code).
-- Rollback: supabase/rollback/20261005120000_review_requests.down.sql

alter table public.companies add column if not exists review_settings jsonb not null default '{}'::jsonb;

create table if not exists public.review_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  booking_id uuid references public.bookings (id) on delete set null,
  invoice_id uuid references public.invoices (id) on delete set null,
  source text not null check (source in ('job_done', 'invoice_paid', 'manual')),
  status text not null default 'scheduled'
    check (status in ('scheduled', 'sending', 'sent', 'skipped', 'failed', 'cancelled')),
  -- When it should go out (already moved into the brand's sending hours).
  scheduled_for timestamptz not null,
  channel text check (channel is null or channel in ('sms', 'email')),
  sent_to text,
  token text not null unique check (token ~ '^[a-f0-9]{32}$'),
  sent_at timestamptz,
  clicked_at timestamptz,
  last_clicked_at timestamptz,
  click_count integer not null default 0,
  -- Why it was skipped / failed / cancelled, in words the owner can read.
  reason text,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One automatic ask per job and per invoice (manual asks carry neither).
create unique index if not exists review_requests_one_per_booking
  on public.review_requests (booking_id) where booking_id is not null and source = 'job_done';
create unique index if not exists review_requests_one_per_invoice
  on public.review_requests (invoice_id) where invoice_id is not null and source = 'invoice_paid';
create index if not exists review_requests_due_idx on public.review_requests (status, scheduled_for);
create index if not exists review_requests_contact_idx on public.review_requests (organization_id, contact_id, created_at desc);
create index if not exists review_requests_company_idx on public.review_requests (organization_id, company_id, created_at desc);

alter table public.review_requests enable row level security;

drop policy if exists "review_requests_members_select" on public.review_requests;
drop policy if exists "review_requests_members_insert" on public.review_requests;
drop policy if exists "review_requests_members_update" on public.review_requests;
create policy "review_requests_members_select"
  on public.review_requests for select
  using (public.is_organization_member(organization_id));
create policy "review_requests_members_insert"
  on public.review_requests for insert
  with check (
    public.is_organization_member(organization_id)
    and exists (select 1 from public.companies c where c.id = company_id and c.organization_id = review_requests.organization_id)
    and exists (select 1 from public.contacts ct where ct.id = contact_id and ct.organization_id = review_requests.organization_id)
  );
create policy "review_requests_members_update"
  on public.review_requests for update
  using (public.is_organization_member(organization_id))
  with check (public.is_organization_member(organization_id));

grant select, insert, update on public.review_requests to authenticated, service_role;

-- Click tracking from the public /r/{token} link (no session): bump the counters on the
-- one row with this token and hand back where to send the visitor. Security definer so
-- the anonymous redirect never needs table access; it can only touch the row whose
-- unguessable token it was given, and only those three columns.
create or replace function public.record_review_click(p_token text)
returns table (review_url text, fallback_url text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company uuid;
begin
  if p_token is null or p_token !~ '^[a-f0-9]{32}$' then
    return;
  end if;
  update public.review_requests
     set click_count = click_count + 1,
         clicked_at = coalesce(clicked_at, now()),
         last_clicked_at = now(),
         updated_at = now()
   where token = p_token and status = 'sent'
   returning company_id into v_company;
  if v_company is null then
    -- Not sent (or unknown): still forward to the brand's page if we know the brand.
    select company_id into v_company from public.review_requests where token = p_token;
    if v_company is null then
      return;
    end if;
  end if;
  return query
    select nullif(btrim(c.brand_review_url), ''), nullif(btrim(c.quote_public_base_url), '')
      from public.companies c where c.id = v_company;
end;
$$;

revoke all on function public.record_review_click(text) from public;
grant execute on function public.record_review_click(text) to service_role;
