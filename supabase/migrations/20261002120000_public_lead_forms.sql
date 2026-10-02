-- Public lead forms: publishable, company-scoped form keys for the hosted lead page
-- (/f/:formKey) and the embed script (/embed/v1.js). See docs/website-forms.md.
--
-- Why a NEW table instead of a `kind` column on intake_keys:
--   * intake keys are SECRETS — only their sha256 is stored and the full value is shown
--     once, because the key is the HMAC secret for /api/intake. A publishable form key is
--     the opposite: it sits in a customer's website HTML and must be re-displayable in
--     Settings forever (the owner copies the snippet again next month). Storing it next to
--     hashed secrets would blur which column means what and invite a "show the key" bug
--     that leaks a real intake secret.
--   * a form key is ALWAYS company-scoped (the hosted page shows one company's name/logo),
--     carries allowed_origins + a form type, and is resolved by a different, public,
--     unsigned endpoint. A separate table keeps /api/intake's lookup untouched (A1 path).
--
-- Additive only: one new table, RLS on in this migration, nothing existing changes.

create table public.public_form_keys (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  company_id uuid not null,
  -- The publishable key itself (`evpk_<48 hex>`). Safe to expose in HTML: it can only
  -- submit a lead into its own company, behind rate limits + bot checks.
  public_key text not null unique,
  label text,
  -- Which lead envelope formType submissions are recorded as.
  form_type text not null default 'quote',
  active boolean not null default true,
  -- Websites allowed to embed / post this form (normalized `https://host[:port]`).
  -- Empty = any site. The hosted page on the app origin is always allowed.
  allowed_origins text[] not null default '{}',
  last_used_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default timezone('utc', now()),
  constraint public_form_keys_key_format check (public_key ~ '^evpk_[0-9a-f]{24,64}$'),
  constraint public_form_keys_form_type_check check (form_type in ('quote', 'contact')),
  constraint public_form_keys_label_length check (label is null or char_length(label) <= 120),
  constraint public_form_keys_origins_count check (cardinality(allowed_origins) <= 50),
  -- Composite FK: the company must belong to the key's org.
  foreign key (company_id, organization_id)
    references public.companies (id, organization_id) on delete cascade
);

create index public_form_keys_org_idx on public.public_form_keys (organization_id);
create index public_form_keys_company_idx on public.public_form_keys (organization_id, company_id);

-- RLS: admins manage, members read. The public endpoint resolves a key through the
-- service-role client (lead-intake/public-forms.ts, a sanctioned exception), so these
-- policies only gate the Settings / onboarding UI.
alter table public.public_form_keys enable row level security;

create policy "public_form_keys_members_select"
  on public.public_form_keys for select
  using (public.is_organization_member(organization_id));

create policy "public_form_keys_admins_manage"
  on public.public_form_keys for all
  using (public.is_organization_admin(organization_id))
  with check (public.is_organization_admin(organization_id));
