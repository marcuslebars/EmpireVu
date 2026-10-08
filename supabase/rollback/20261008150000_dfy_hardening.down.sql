-- Rollback for 20261008150000_dfy_hardening.sql
drop trigger if exists company_sites_set_updated_at on public.company_sites;
drop trigger if exists setup_intakes_set_updated_at on public.setup_intakes;
alter table public.company_sites drop constraint if exists company_sites_company_org_fkey;
alter table public.setup_intakes drop constraint if exists setup_intakes_company_org_fkey;
grant select on public.company_sites to anon;
grant select on public.dfy_progress to authenticated;
grant select on public.setup_intakes to authenticated;
alter table public.dfy_progress drop column if exists switch_on_attempts;
