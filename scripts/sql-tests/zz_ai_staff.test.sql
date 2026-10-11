-- Privilege tests for the AI staff (Phase 2): 20261011100000 … 20261011130000.
-- Every new table has RLS on and is never client-writable (anon / authenticated); the
-- service-role-only tables aren't client-readable either; the new companies / membership
-- columns aren't client-writable. Catalog checks, so they hold for any future rows.
\set ON_ERROR_STOP on
set client_min_messages = notice;
reset role;

do $$
declare
  t text;
  r text;
  p text;
  all_tables text[] := array['estimate_requests','quote_follow_ups','invoice_collections','invoice_reminder_texts','payment_plans',
    'money_alerts','money_alert_items','dispatch_messages','dispatch_runs','dispatch_weather_cache','marketing_campaigns',
    'marketing_campaign_recipients','google_reviews','google_post_drafts','marketing_sweep_claims'];
  service_only text[] := array['money_alert_items','dispatch_weather_cache','marketing_sweep_claims'];
begin
  raise notice '== ai staff: RLS on, no client writes';
  foreach t in array all_tables loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      raise exception 'FAIL % has RLS off', t;
    end if;
    foreach r in array array['anon','authenticated'] loop
      foreach p in array array['INSERT','UPDATE','DELETE'] loop
        if has_table_privilege(r, 'public.' || t, p)
           and exists (select 1 from pg_policies where schemaname = 'public' and tablename = t
                       and (cmd = p or cmd = 'ALL') and (roles @> array[r::name] or roles @> array['public'::name])) then
          raise exception 'FAIL % can % %', r, p, t;
        end if;
      end loop;
    end loop;
  end loop;
  raise notice 'ok   % tables: RLS on, no client insert/update/delete policies', array_length(all_tables, 1);

  foreach t in array service_only loop
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and cmd in ('SELECT','ALL')) then
      raise exception 'FAIL % has a client read policy (service role only)', t;
    end if;
  end loop;
  raise notice 'ok   service-role-only tables have no client read policy';

  foreach r in array array['anon','authenticated'] loop
    foreach p in array array['latitude','longitude','location_source','location_checked_at'] loop
      if has_column_privilege(r, 'public.companies', p, 'UPDATE') then
        raise exception 'FAIL % can update companies.%', r, p;
      end if;
    end loop;
    if has_column_privilege(r, 'public.organization_memberships', 'phone_e164', 'UPDATE') then
      raise exception 'FAIL % can update organization_memberships.phone_e164 directly', r;
    end if;
  end loop;
  raise notice 'ok   new company location / member phone columns not client-writable';
  raise notice '== ai staff: privilege tests passed';
end $$;
