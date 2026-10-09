-- Rollback of 20261009160000_front_desk_hardening.sql.
drop index if exists public.owner_approvals_code_recent_idx;
drop index if exists public.owner_approvals_notified_idx;
alter table public.owner_approvals drop column if exists notified_to;
drop table if exists public.owner_phone_verifications;
drop trigger if exists companies_owner_phone_unverify on public.companies;
drop function if exists public.companies_owner_phone_unverify();
grant update (owner_phone_e164) on public.companies to authenticated;
alter table public.companies drop column if exists owner_phone_verified_at;
