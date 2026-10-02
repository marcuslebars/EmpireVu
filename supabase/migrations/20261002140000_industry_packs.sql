-- Industry starter packs (CrankLeads install-in-30-minutes).
--
-- A pack is versioned DATA in code (src/server/services/packs/*): a price-less service
-- list, trade-specific recipe messages, receptionist notes and booking defaults. Applying
-- one to a company creates catalog items, installs/tailors recipes, and records WHICH pack
-- and version the company was given here, so:
--   * the Phone step can append the pack's receptionist notes to the AI prompt, and
--   * Settings can show "pack v1 applied — v2 available, re-apply".
--
-- companies.industry_pack (jsonb, nullable):
--   { "id": "property-maintenance-snow", "version": 1,
--     "appliedAt": "2026-10-02T14:00:00.000Z", "recipes": ["missed-call-text-back", ...] }
--
-- Additive only. Covered by the existing companies RLS policies (org members read/update
-- their org's companies); the apply route itself is admin-only. No new table or policy.

alter table public.companies add column if not exists industry_pack jsonb;

comment on column public.companies.industry_pack is
  'Industry starter pack applied to this company: {id, version, appliedAt, recipes[]}. NULL = none. See src/server/services/packs.';
