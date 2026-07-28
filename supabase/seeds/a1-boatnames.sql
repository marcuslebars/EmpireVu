-- ============================================================================
-- Seed: boatnames.ca as company `a1-boatnames` under org `a1-group`.
--
-- Run this against the EmpireVu database BEFORE the boatnames forward gate is
-- flipped on. Until this row exists AND the sourceSite code map knows about
-- "boatnames" (see below), a boatnames lead resolves to no company and lands in
-- raw_leads instead of creating a contact.
--
-- Idempotent: safe to run repeatedly. Inserts nothing if the company already
-- exists, or if org `a1-group` is absent (the SELECT simply returns no rows).
--
-- ── TWO PARTS ARE REQUIRED; THIS FILE IS ONLY PART 2 ────────────────────────
--   1. CODE MAP (already changed in this same PR):
--        src/server/services/lead-intake/routing.ts
--        SOURCE_SITE_TO_COMPANY_SLUG["boatnames"] = "a1-boatnames"
--      The intake resolves sourceSite -> company slug through this map, NOT a DB
--      column. There is no `companies.source_site` column and no mapping table.
--   2. THIS SEED — the company row the resolved slug points at.
-- Seeding the row without the code map (or vice versa) still drops the lead.
--
-- Schema note (verified against this repo's migrations):
--   public.companies (id, organization_id, name, slug, stage, website, notes, …)
--   UNIQUE (organization_id, slug)   ← conflict target below
--   stage is enum public.company_stage ('prospect','active','paused','archived')
-- ============================================================================

insert into public.companies (organization_id, slug, name, stage, website, notes)
select
  o.id,
  'a1-boatnames',
  'boatnames.ca',
  'active',                       -- matches the other operating A1 brands
  'https://boatnames.ca',
  'boatnames.ca — custom boat name lettering (An A1 Company). Intake sourceSite: "boatnames".'
from public.organizations o
where o.slug = 'a1-group'
on conflict (organization_id, slug) do nothing;

-- Verify — should return exactly one row after running:
-- select c.slug, c.name, c.stage, o.slug as org
-- from public.companies c
-- join public.organizations o on o.id = c.organization_id
-- where c.slug = 'a1-boatnames';
