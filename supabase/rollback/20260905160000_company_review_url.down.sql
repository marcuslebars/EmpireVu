-- Rollback for 20260905160000_company_review_url.sql
alter table public.companies drop column if exists brand_review_url;
