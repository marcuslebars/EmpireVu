-- Phase 1 hardening (docs/front-desk-ai.md, "Hardening"). Additive; rollback in
-- supabase/rollback/20261009160000_front_desk_hardening.down.sql.

-- ── 1. Approvals are decided by text only from the phone that was asked ───────────
-- notified_to = the owner phone the approval text went to. An SMS "Y" only counts for rows
-- notified to that phone (quiet-hours rows that were never sent can't be approved blind).
alter table public.owner_approvals add column if not exists notified_to text;
create index if not exists owner_approvals_notified_idx
  on public.owner_approvals (company_id, created_at desc) where notified_at is not null;
-- Short codes come from one per-company sequence that doesn't reuse a code for 7 days
-- (front-desk/approvals.ts); this index serves that lookup.
create index if not exists owner_approvals_code_recent_idx
  on public.owner_approvals (company_id, created_at desc, short_code);

-- ── 2. The owner's cell is an identity: not member-writable, and verified ─────────
-- A text from companies.owner_phone_e164 can approve AI actions and run commands, so:
--  • members can no longer write it through the column grant (20261006170000 allowed any
--    member); owners/admins change it through a server route that texts a 6-digit code;
--  • owner_phone_verified_at: the owner channel only acts for a verified number. Provisioning
--    (checkout, the buyer's intake form, an operator) sets it verified; any other change to the
--    number clears it (trigger below) until the texted code is entered.
alter table public.companies add column if not exists owner_phone_verified_at timestamptz;
comment on column public.companies.owner_phone_verified_at is
  'When owner_phone_e164 was verified (provisioning, or the code texted to it). Null = the owner channel ignores texts from it.';

-- Numbers already on file came from provisioning / operators before this check existed.
update public.companies
   set owner_phone_verified_at = coalesce(updated_at, now())
 where owner_phone_e164 is not null and owner_phone_verified_at is null;

revoke update (owner_phone_e164) on public.companies from authenticated;
revoke update (owner_phone_e164) on public.companies from anon;

create or replace function public.companies_owner_phone_unverify()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- A changed number is unverified unless the same update verifies it.
  if new.owner_phone_e164 is distinct from old.owner_phone_e164
     and new.owner_phone_verified_at is not distinct from old.owner_phone_verified_at then
    new.owner_phone_verified_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists companies_owner_phone_unverify on public.companies;
create trigger companies_owner_phone_unverify
  before update of owner_phone_e164 on public.companies
  for each row execute procedure public.companies_owner_phone_unverify();

create table if not exists public.owner_phone_verifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null,
  phone_e164 text not null,
  code_hash text not null,
  attempts integer not null default 0,
  expires_at timestamptz not null,
  verified_at timestamptz,
  requested_by uuid,
  created_at timestamptz not null default now(),
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade
);
create index if not exists owner_phone_verifications_company_idx
  on public.owner_phone_verifications (company_id, created_at desc);
alter table public.owner_phone_verifications enable row level security;
revoke all on public.owner_phone_verifications from anon, authenticated;
