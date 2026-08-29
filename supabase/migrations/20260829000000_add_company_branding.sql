-- Per-company branding for CUSTOMER-FACING surfaces.
--
-- EmpireVu is the backend. A customer approving a quote or reading a deposit
-- receipt should see the BRAND they hired — A1 Marine Storage — and never the
-- platform that happens to run it. Nothing in the hosted quote page or the quote
-- emails may carry EmpireVu or Tilotto branding.
--
-- Branding therefore lives on the COMPANY, alongside the Stripe credentials and
-- the voice profiles: a brand is a company in this schema (`a1-group` is the
-- organization; A1 Marine Storage is a company inside it). Two brands under one
-- org must be able to look completely different to their respective customers.
--
-- All columns nullable. A brand with nothing set renders a neutral, unbranded
-- page — plain text on a default palette — rather than falling back to anything
-- platform-shaped.

alter table public.companies add column if not exists brand_logo_url text;
alter table public.companies add column if not exists brand_primary_color text;
alter table public.companies add column if not exists brand_accent_color text;

-- Email identity. brand_from_name is the display name on outbound quote mail;
-- the sending address itself stays a verified Resend domain (set in env), since
-- an arbitrary per-company From address would fail SPF/DKIM.
alter table public.companies add column if not exists brand_from_name text;
alter table public.companies add column if not exists brand_reply_email text;
-- Shown on the expired-quote page ("text or call us and we'll refresh it").
alter table public.companies add column if not exists brand_reply_phone text;
alter table public.companies add column if not exists brand_website_url text;

-- Customer-facing legal/policy copy, rendered on the quote page above the
-- approve button. Text, not code — the cancellation terms change by season and
-- must never require a deploy.
alter table public.companies add column if not exists quote_terms_text text;
alter table public.companies add column if not exists cancellation_policy_text text;

-- Colors are interpolated into the page's inline styles, so constrain them to a
-- hex literal. This is an injection guard, not cosmetics: company settings are
-- admin-editable and this value lands inside a style attribute.
alter table public.companies drop constraint if exists companies_brand_primary_color_check;
alter table public.companies add constraint companies_brand_primary_color_check
  check (brand_primary_color is null or brand_primary_color ~ '^#[0-9A-Fa-f]{6}$');

alter table public.companies drop constraint if exists companies_brand_accent_color_check;
alter table public.companies add constraint companies_brand_accent_color_check
  check (brand_accent_color is null or brand_accent_color ~ '^#[0-9A-Fa-f]{6}$');

-- Logo and website are rendered as a src/href, so require an absolute https URL.
-- Blocks javascript: and data: URIs from reaching the page.
alter table public.companies drop constraint if exists companies_brand_logo_url_check;
alter table public.companies add constraint companies_brand_logo_url_check
  check (brand_logo_url is null or brand_logo_url ~ '^https://');

alter table public.companies drop constraint if exists companies_brand_website_url_check;
alter table public.companies add constraint companies_brand_website_url_check
  check (brand_website_url is null or brand_website_url ~ '^https://');
