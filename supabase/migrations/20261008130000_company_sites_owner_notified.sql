-- Generated sites (docs/done-for-you.md → "Generated sites").
--
-- When the sweep auto-publishes a buyer's page we text the owner once ("Your new page is
-- live"). The claim has to be atomic so two workers can't both send it:
--   update company_sites set owner_notified_at = now() where id = $1 and owner_notified_at is null
-- An owner who publishes from Settings is looking at it, so that path stamps it too.
-- Additive; server-only (service role) like the rest of company_sites.
-- Rollback: supabase/rollback/20261008130000_company_sites_owner_notified.down.sql

alter table public.company_sites
  add column if not exists owner_notified_at timestamptz;

comment on column public.company_sites.owner_notified_at is
  'When the owner was told the page is live (claimed before sending; null = not yet).';

create index if not exists company_sites_status_idx on public.company_sites (status);
