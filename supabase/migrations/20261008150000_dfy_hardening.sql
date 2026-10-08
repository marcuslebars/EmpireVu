-- Done-for-you hardening (docs/done-for-you.md).
--
-- 1. Switch-on retries: a failed switch-on no longer sticks. The orchestrator clears
--    dfy_progress.switched_on_at after a failure and retries up to a bounded number of
--    attempts (switch_on_attempts); the concierge "Run switch-on now" always re-runs it.
-- 2. Token secrecy: setup_intakes.token (/setup/:token) and dfy_progress.forward_token
--    (/forward/:token) are no-login credentials. Org members could read them through
--    PostgREST (RLS lets members select their org's rows). Column grants make both columns
--    unreadable to every client role; owners/admins get the links from the server
--    (GET /api/organizations/:org/setup-progress, which hands them out to owners/admins only).
-- 3. Integrity like dfy_progress: (company_id, organization_id) must be a real company of
--    that organization on setup_intakes and company_sites, and updated_at is maintained by the
--    standard touch_updated_at() trigger.
--
-- Additive / idempotent. Writes stay service-role only (20261006170000_lock_privileged_columns).
-- Rollback: supabase/rollback/20261008150000_dfy_hardening.down.sql
-- Verify:   scripts/sql-tests/run.sh (done_for_you.test.sql)

-- ── 1. Switch-on attempts ─────────────────────────────────────────────────────
alter table public.dfy_progress
  add column if not exists switch_on_attempts integer not null default 0;

comment on column public.dfy_progress.switch_on_attempts is
  'Switch-on runs started. A failed run clears switched_on_at so the sweep retries (bounded); the operator can always force one.';

-- ── 2. Token columns: not readable by any client role ─────────────────────────
-- Column privileges: take away the table-level SELECT and grant back every column except the
-- token. RLS still decides which rows a member sees.
revoke select on public.setup_intakes from anon, authenticated;
grant select (
  id, organization_id, company_id, status, answers, enrichment,
  sent_at, opened_at, submitted_at, enriched_at, last_error,
  send_attempts, sms_sent_at, email_sent_at, enrich_attempts,
  created_at, updated_at
) on public.setup_intakes to authenticated;

revoke select on public.dfy_progress from anon, authenticated;
grant select (
  company_id, organization_id,
  number_attempts, number_last_attempt_at, number_last_error, number_ready_at, number_flagged_at,
  switched_on_at, switch_on_detail, switch_on_attempts,
  forward_text_sent_at, forward_opened_at, forward_tapped_at, forward_help_requested_at,
  forward_tests_started, forward_last_test_at,
  escalated_at, last_run_at, last_error, created_at, updated_at
) on public.dfy_progress to authenticated;

-- company_sites has no secret; anon never needs it (the public page is served by the server).
revoke select on public.company_sites from anon;

-- ── 3. Integrity + updated_at ─────────────────────────────────────────────────
alter table public.setup_intakes drop constraint if exists setup_intakes_company_org_fkey;
alter table public.setup_intakes
  add constraint setup_intakes_company_org_fkey
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade;

alter table public.company_sites drop constraint if exists company_sites_company_org_fkey;
alter table public.company_sites
  add constraint company_sites_company_org_fkey
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade;

drop trigger if exists setup_intakes_set_updated_at on public.setup_intakes;
create trigger setup_intakes_set_updated_at
before update on public.setup_intakes
for each row execute procedure public.touch_updated_at();

drop trigger if exists company_sites_set_updated_at on public.company_sites;
create trigger company_sites_set_updated_at
before update on public.company_sites
for each row execute procedure public.touch_updated_at();
