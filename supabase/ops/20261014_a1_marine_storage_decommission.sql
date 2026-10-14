-- A1 Marine Storage decommission (owner decision 2026-10-14). One-off data change, NOT a migration.
-- Run once in the Supabase SQL editor. Re-running is safe: it does nothing new and doesn't
-- overwrite the first backup.
--
-- What it does, for the A1 Marine Storage company only (org a1-group, slug a1-marine-storage):
--   1. companies.stage = 'archived': weekly report, monthly scorecard and the AI staff roles stop.
--   2. Company switches off: review requests, invoice email reminders, online booking (/book/<id>),
--      owner daily digest, monthly scorecard, and the AI texting agent (ai_settings.sms_agent).
--   3. Storage's own workflows active -> paused. Org-wide workflows are NOT touched, because they
--      also run for A1 Marine Care.
--   4. Recurring job series active -> paused, so no new visits are generated.
--   5. Scheduled review requests -> cancelled.
--   6. Open quotes (draft / sent / viewed) -> cancelled, so no expiry or follow-up emails go out.
--      Approved quotes and quotes with a deposit paid are NOT touched (money involved; the audit
--      lists them).
--   7. Phone routing and keys deactivated: voice_numbers, telnyx_numbers, company_voice_profiles,
--      intake_keys, public_form_keys. Calls to Storage's numbers then no longer match Storage. With
--      RETELL_SOURCE_SITE=a1marinecare (set 2026-10-14), an unmatched Retell call becomes an A1
--      Marine Care lead.
--
-- NOT touched: Stripe Connect, invoices, payments, payment plans, service agreements and bookings
-- already on the calendar. Handle those by hand from the audit
-- (supabase/tests/storage_decommission_audit.sql).
--
-- Every changed row's previous state is saved to decommission.a1_marine_storage_20261014, a
-- schema the API doesn't expose. Rollback: supabase/ops/20261014_a1_marine_storage_decommission.down.sql

begin;

create schema if not exists decommission;
revoke all on schema decommission from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on schema decommission from anon, authenticated';
  end if;
end $$;

create table if not exists decommission.a1_marine_storage_20261014 (
  tbl text not null,
  id uuid not null,
  before jsonb not null,
  saved_at timestamptz not null default now(),
  primary key (tbl, id)
);

do $$
declare
  v_org uuid;
  v_co uuid;
  v_n int;
begin
  select id into v_org from public.organizations where slug = 'a1-group';
  if v_org is null then raise exception 'organization a1-group not found'; end if;

  select id into v_co from public.companies where organization_id = v_org and slug = 'a1-marine-storage';
  if v_co is null then raise exception 'company a1-marine-storage not found in a1-group'; end if;

  -- Back up every row this script changes. ON CONFLICT keeps the FIRST backup if it is re-run.
  insert into decommission.a1_marine_storage_20261014 (tbl, id, before)
  select 'companies', c.id, to_jsonb(c) from public.companies c where c.id = v_co
  union all select 'workflows', w.id, to_jsonb(w) from public.workflows w where w.company_id = v_co and w.status = 'active'
  union all select 'recurring_jobs', r.id, to_jsonb(r) from public.recurring_jobs r where r.company_id = v_co and r.status = 'active'
  union all select 'review_requests', r.id, to_jsonb(r) from public.review_requests r where r.company_id = v_co and r.status = 'scheduled'
  union all select 'quotes', q.id, to_jsonb(q) from public.quotes q where q.company_id = v_co and q.status in ('draft', 'sent', 'viewed')
  union all select 'voice_numbers', v.id, to_jsonb(v) from public.voice_numbers v where v.company_id = v_co and v.active
  union all select 'telnyx_numbers', t.id, to_jsonb(t) from public.telnyx_numbers t where t.company_id = v_co and t.active
  union all select 'company_voice_profiles', p.id, to_jsonb(p) from public.company_voice_profiles p where p.company_id = v_co and p.active
  union all select 'intake_keys', k.id, to_jsonb(k) from public.intake_keys k where k.company_id = v_co and k.active
  union all select 'public_form_keys', k.id, to_jsonb(k) from public.public_form_keys k where k.company_id = v_co and k.active
  on conflict (tbl, id) do nothing;

  update public.companies c set
    stage = 'archived',
    review_settings = coalesce(c.review_settings, '{}'::jsonb) || '{"enabled": false}',
    invoice_settings = coalesce(c.invoice_settings, '{}'::jsonb) || '{"remindersEnabled": false}',
    online_booking_settings = coalesce(c.online_booking_settings, '{}'::jsonb) || '{"enabled": false}',
    digest = coalesce(c.digest, '{}'::jsonb) || '{"enabled": false}',
    monthly_scorecard = coalesce(c.monthly_scorecard, '{}'::jsonb) || '{"enabled": false}',
    ai_settings = coalesce(c.ai_settings, '{}'::jsonb)
      || jsonb_build_object('sms_agent', coalesce(c.ai_settings->'sms_agent', '{}'::jsonb) || '{"enabled": false}'),
    updated_at = now()
  where c.id = v_co;

  update public.workflows set status = 'paused', updated_at = now() where company_id = v_co and status = 'active';
  get diagnostics v_n = row_count; raise notice 'workflows paused: %', v_n;
  update public.recurring_jobs set status = 'paused', updated_at = now() where company_id = v_co and status = 'active';
  get diagnostics v_n = row_count; raise notice 'recurring series paused: %', v_n;
  update public.review_requests set status = 'cancelled', updated_at = now() where company_id = v_co and status = 'scheduled';
  get diagnostics v_n = row_count; raise notice 'review requests cancelled: %', v_n;
  update public.quotes set status = 'cancelled' where company_id = v_co and status in ('draft', 'sent', 'viewed');
  get diagnostics v_n = row_count; raise notice 'quotes cancelled: %', v_n;
  update public.voice_numbers set active = false where company_id = v_co and active;
  get diagnostics v_n = row_count; raise notice 'voice numbers deactivated: %', v_n;
  update public.telnyx_numbers set active = false, updated_at = now() where company_id = v_co and active;
  update public.company_voice_profiles set active = false, updated_at = now() where company_id = v_co and active;
  update public.intake_keys set active = false where company_id = v_co and active;
  get diagnostics v_n = row_count; raise notice 'intake keys revoked: %', v_n;
  update public.public_form_keys set active = false where company_id = v_co and active;
  get diagnostics v_n = row_count; raise notice 'form keys revoked: %', v_n;
end $$;

commit;

-- What changed (the backup table):
select tbl, count(*) from decommission.a1_marine_storage_20261014 group by tbl order by tbl;
