-- Rollback for 20261002140000_industry_packs.sql
alter table public.companies drop column if exists industry_pack;
