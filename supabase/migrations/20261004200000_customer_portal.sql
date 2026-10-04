-- Customer portal: one private link per customer (contact) per brand, showing their
-- upcoming visits, quotes, invoices and receipts, with "pay" and "request work".
-- The token in the link is the credential (like /q/ and /i/ links); staff can reset it.
-- Rollback: supabase/rollback/20261004200000_customer_portal.down.sql

create table if not exists public.customer_portal_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  token text not null unique check (token ~ '^[a-f0-9]{40}$'),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  last_viewed_at timestamptz,
  view_count integer not null default 0
);

-- One live link per customer per brand (resetting revokes the old one first).
create unique index if not exists customer_portal_links_one_live
  on public.customer_portal_links (company_id, contact_id) where revoked_at is null;
create index if not exists customer_portal_links_contact_idx on public.customer_portal_links (organization_id, contact_id);

alter table public.customer_portal_links enable row level security;

drop policy if exists "customer_portal_links_members_select" on public.customer_portal_links;
drop policy if exists "customer_portal_links_members_insert" on public.customer_portal_links;
drop policy if exists "customer_portal_links_members_update" on public.customer_portal_links;
create policy "customer_portal_links_members_select"
  on public.customer_portal_links for select
  using (public.is_organization_member(organization_id));
create policy "customer_portal_links_members_insert"
  on public.customer_portal_links for insert
  with check (
    public.is_organization_member(organization_id)
    and exists (select 1 from public.companies c where c.id = company_id and c.organization_id = customer_portal_links.organization_id)
    and exists (select 1 from public.contacts ct where ct.id = contact_id and ct.organization_id = customer_portal_links.organization_id)
  );
create policy "customer_portal_links_members_update"
  on public.customer_portal_links for update
  using (public.is_organization_member(organization_id))
  with check (public.is_organization_member(organization_id));

grant select, insert, update on public.customer_portal_links to authenticated, service_role;
