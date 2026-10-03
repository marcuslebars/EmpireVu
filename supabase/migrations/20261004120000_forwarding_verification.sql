-- Automatic forwarding verification for the missed-call catcher
-- (docs/missed-call-catcher.md → "Forwarding verification").
--
-- The owner sets carrier conditional call forwarding from their business line to the
-- catcher number. If that is wrong, text-back silently never fires. EmpireVu now proves it:
-- the server places a test call TO the business line (caller ID = the catcher number, or the
-- platform verifier TWILIO_FORWARDING_TEST_FROM), lets it ring out, and watches for the
-- forwarded leg to arrive back on the catcher number's inbound voice webhook.
--
-- Additive:
--   1) voice_numbers.forwarding_verified_at / forwarding_last_test_at /
--      forwarding_last_test_result — the verification state of a catcher number. THIS COLUMN
--      CONTRACT IS RELIED ON BY OTHER FEATURES (keep the names). forwarding_verified_at is
--      set by a passed test or by a real forwarded missed call (passive proof), and cleared
--      (null) ONLY by 'not_forwarded'. 'answered' / 'busy' (inconclusive) and 'failed' (our
--      side: Twilio refused / no status) leave it untouched. forwarding_last_test_at is
--      stamped when a test is CREATED (before dialling — cost guard) and again on completion.
--   2) forwarding_tests — one row per test call (owner-triggered or scheduled). Written by
--      the service role only (the test API's sanctioned service, the Twilio webhooks and the
--      worker); org members may read their own (the wizard polls it).
--   3) Backfill: an active catcher number that already has a missed_calls row is marked
--      verified (forwarding_verified_at = its latest missed call) — a catcher number is only
--      ever given to customers via carrier forwarding, so a caught call is proof forwarding
--      worked. Idempotent (only fills NULLs; re-running changes nothing).

-- 1) voice_numbers verification state
alter table public.voice_numbers add column if not exists forwarding_verified_at timestamptz;
alter table public.voice_numbers add column if not exists forwarding_last_test_at timestamptz;
alter table public.voice_numbers add column if not exists forwarding_last_test_result text;
alter table public.voice_numbers drop constraint if exists voice_numbers_forwarding_last_test_result_check;
alter table public.voice_numbers
  add constraint voice_numbers_forwarding_last_test_result_check
  check (forwarding_last_test_result is null
         or forwarding_last_test_result in ('passed', 'answered', 'busy', 'not_forwarded', 'failed'));

-- 2) forwarding_tests
create table if not exists public.forwarding_tests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  company_id uuid not null,
  voice_number_id uuid not null references public.voice_numbers (id) on delete cascade,
  -- 'owner' (the wizard's "Test my forwarding" button / API) | 'scheduled' (worker retest).
  trigger text not null check (trigger in ('owner', 'scheduled')),
  requested_by uuid references public.profiles (id) on delete set null,
  -- 'calling' while the test call is in flight; then exactly one outcome. 'passed' is
  -- sticky: a forwarded leg that is processed late upgrades any other outcome to passed.
  status text not null default 'calling'
    check (status in ('calling', 'passed', 'answered', 'busy', 'not_forwarded', 'failed')),
  -- The test call: FROM caller_id (catcher number or platform verifier) TO business_line;
  -- carrier forwarding should bring it back to catcher_number. The forwarded leg is matched
  -- ONLY by From = caller_id (a number we own) + To = catcher_number, never by the business
  -- line (real forwarded customers carry it).
  caller_id text not null,
  business_line text not null,
  catcher_number text not null,
  outbound_call_sid text unique,
  outbound_status text,
  outbound_answered_by text,
  outbound_duration_seconds integer,
  -- The forwarded leg that arrived on the catcher number (proof of forwarding).
  forwarded_call_sid text,
  forwarded_from text,
  error_code text,
  error_message text,
  started_at timestamptz not null default timezone('utc', now()),
  completed_at timestamptz,
  -- Owner SMS/email about the result, claimed atomically (sent at most once).
  notified_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  foreign key (company_id, organization_id)
    references public.companies (id, organization_id) on delete cascade
);

-- At most one in-flight test per number (owner button vs scheduler race → unique violation).
create unique index if not exists forwarding_tests_one_calling_idx
  on public.forwarding_tests (voice_number_id) where status = 'calling';
create index if not exists forwarding_tests_company_created_idx
  on public.forwarding_tests (company_id, created_at desc);
create index if not exists forwarding_tests_number_started_idx
  on public.forwarding_tests (voice_number_id, started_at desc);
create index if not exists forwarding_tests_org_idx
  on public.forwarding_tests (organization_id);
-- The voice webhook's leg lookup (catcher_number = To, caller_id = From, recent started_at).
create index if not exists forwarding_tests_leg_lookup_idx
  on public.forwarding_tests (catcher_number, caller_id, started_at desc);

drop trigger if exists forwarding_tests_set_updated_at on public.forwarding_tests;
create trigger forwarding_tests_set_updated_at
before update on public.forwarding_tests
for each row execute procedure public.touch_updated_at();

alter table public.forwarding_tests enable row level security;

-- Members read their org's tests (the wizard polls the latest). Writes are service-role
-- only — there is deliberately no member insert/update/delete policy: a test places a
-- billed phone call, so it is only ever created through the rate-limited server path.
drop policy if exists "forwarding_tests_members_select" on public.forwarding_tests;
create policy "forwarding_tests_members_select"
  on public.forwarding_tests for select
  using (public.is_organization_member(organization_id));

-- 3) Backfill passive proof for catcher numbers that have already caught calls.
update public.voice_numbers vn
set forwarding_verified_at = caught.latest_at
from (
  select organization_id, company_id, to_number, max(created_at) as latest_at
  from public.missed_calls
  group by organization_id, company_id, to_number
) caught
where vn.provider = 'twilio'
  and vn.mode = 'missed_call_catcher'
  and vn.active
  and vn.forwarding_verified_at is null
  and caught.organization_id = vn.organization_id
  and caught.company_id = vn.company_id
  and caught.to_number = vn.phone_e164;
