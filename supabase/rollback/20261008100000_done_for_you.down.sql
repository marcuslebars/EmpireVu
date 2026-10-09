drop table if exists public.operator_actions;
drop table if exists public.company_sites;
drop table if exists public.setup_intakes;
alter table public.companies drop constraint if exists companies_business_phone_kind_check;
alter table public.companies
  drop column if exists profile,
  drop column if exists business_phone_carrier,
  drop column if exists business_phone_kind,
  drop column if exists google_review_count,
  drop column if exists google_rating,
  drop column if exists google_place_id;
