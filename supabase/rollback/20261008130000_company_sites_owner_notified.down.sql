drop index if exists public.company_sites_status_idx;
alter table public.company_sites drop column if exists owner_notified_at;
