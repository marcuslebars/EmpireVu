-- Per-company origin for customer-facing quote links (/q/{token}) and the Stripe
-- return URLs. NULL = the platform default (QUOTE_PUBLIC_BASE_URL). Several brands
-- share one deployment, so each needs links on its own domain, e.g.
-- https://quotes.a1marinecare.ca for A1 Marine Care.
alter table public.companies
  add column if not exists quote_public_base_url text
    check (quote_public_base_url is null or quote_public_base_url ~ '^https://[a-z0-9.-]+$');

comment on column public.companies.quote_public_base_url is
  'Origin for this company''s customer quote links and Stripe return URLs (https://host, no path). NULL = platform QUOTE_PUBLIC_BASE_URL.';
