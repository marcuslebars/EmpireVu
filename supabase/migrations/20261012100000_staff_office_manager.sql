-- Phase 3 — the AI Office manager (docs/ai-staff.md → "Office manager"): the owner's morning briefing.
--
-- 1. owner_briefings   one row per company per LOCAL date — the claim for that morning's text
--                      (inserted before anything is sent, so overlapping workers send one text;
--                      a failed send is released as 'failed' and re-claimed for a retry before 11:00).
--
-- Settings live in companies.ai_settings.office_manager (no column needed).
--
-- Additive only and re-runnable. All writes go through the server (service role); members may
-- READ their company's rows. Nothing here is client-writable (see 20261006170000).
-- Rollback: supabase/rollback/20261012100000_staff_office_manager.down.sql

create table if not exists public.owner_briefings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null,
  local_date date not null,
  status text not null default 'claimed' check (status in ('claimed', 'sent', 'failed', 'skipped')),
  attempts integer not null default 1 check (attempts >= 1),
  last_attempt_at timestamptz,
  body text,
  -- The email copy's outcome ('sent' | 'failed' | 'blocked' | 'no_email'); null = no copy asked for.
  email_status text,
  -- Bookkeeper money_alert_items keys this briefing carried (the 8am alert folded in).
  money_items jsonb not null default '[]'::jsonb,
  -- 'included' | 'none' (alert off) | 'failed' (couldn't read the items → the 8am alert goes alone).
  money_fold text check (money_fold in ('included', 'none', 'failed')),
  sent_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, local_date),
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade
);

-- Re-runnable on a database that has the first version of this table.
alter table public.owner_briefings add column if not exists money_fold text check (money_fold in ('included', 'none', 'failed'));

create index if not exists owner_briefings_org_company_date_idx on public.owner_briefings (organization_id, company_id, local_date desc);

-- ── RLS: members read their own; nobody writes from the browser ───────────────────
alter table public.owner_briefings enable row level security;

drop policy if exists "owner_briefings_select" on public.owner_briefings;
create policy "owner_briefings_select" on public.owner_briefings
  for select using (public.is_organization_member(organization_id));

revoke insert, update, delete on public.owner_briefings from anon, authenticated;
revoke select on public.owner_briefings from anon;
grant select on public.owner_briefings to authenticated;
grant all on public.owner_briefings to service_role;

drop trigger if exists owner_briefings_set_updated_at on public.owner_briefings;
create trigger owner_briefings_set_updated_at before update on public.owner_briefings
  for each row execute procedure public.touch_updated_at();

comment on table public.owner_briefings is 'AI Office manager: the owner''s morning briefing, one row per company per local date (the claim).';
