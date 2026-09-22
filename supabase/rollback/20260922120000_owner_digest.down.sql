-- Rollback for 20260922120000_owner_digest.sql
drop policy if exists "owner_digest_sends_members_insert" on public.owner_digest_sends;
drop policy if exists "owner_digest_sends_members_select" on public.owner_digest_sends;
drop index if exists public.owner_digest_sends_org_company_date_idx;
drop table if exists public.owner_digest_sends;
alter table public.companies drop column if exists digest;
