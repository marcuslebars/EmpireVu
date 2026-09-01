-- quotes.source_lead_id must be TEXT, not uuid.
--
-- Lead ids are not uuids and never have been: genLeadId() returns
-- `lead_${randomBytes(8).toString("hex")}` — e.g. lead_6bb7f1190a2f219b. Every
-- other table that references a lead already stores it as text:
--
--   raw_leads.lead_id            text not null unique
--   telnyx_calls.lead_id         text
--   jobber_sync_jobs.lead_id     text not null
--   retell_calls.lead_id         text
--
-- This column was the only one declared uuid, so the auto-quote insert failed on
-- every single lead:
--
--   22P02  invalid input syntax for type uuid: "lead_6bb7f1190a2f219b"
--
-- It never surfaced in tests because maybeAutoQuoteLead cannot throw by design —
-- a lead that fails to auto-quote is still a captured lead — so the only trace
-- was one error line in the service log.
--
-- The cast is safe: no auto-quote has ever succeeded, so every existing value is
-- null. The partial unique index is dropped and recreated because a type change
-- invalidates it.

drop index if exists public.quotes_auto_generated_lead_uniq;

alter table public.quotes
  alter column source_lead_id type text using source_lead_id::text;

-- Recreated exactly as before: one auto-quote per lead, scoped to the org, and
-- historical rows (source_lead_id null) do not collide.
create unique index if not exists quotes_auto_generated_lead_uniq
  on public.quotes (organization_id, source_lead_id)
  where auto_generated and source_lead_id is not null;

comment on column public.quotes.source_lead_id is
  'raw_leads.lead_id (text, e.g. lead_6bb7f119…) — NOT a uuid.';
