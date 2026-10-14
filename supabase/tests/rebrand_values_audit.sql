-- READ-ONLY audit for supabase/migrations/20261017100000_rebrand_everdoer_values.sql
-- (Everdoer rebrand, PR 2). Run it in the Supabase SQL editor BEFORE the migration, and again
-- after it (every "will change" row should then be gone, and the A1 rows show their sender).
-- It only SELECTs: no table, row, comment or setting is changed.
--
-- The settings block below MUST match the one at the top of the migration.
--
-- One result set, one row per thing, sorted by step:
--   step         what the migration does with it
--   action       'will change' | 'skipped' (and why) | 'info'
--   target       table.column (or the comment / default)
--   row_id       the org / company id
--   label        name / slug, to recognise the row
--   current      the value now
--   after        the value after the migration ('' = unchanged)
--   note         why it matched (A1 rows say which rule matched)
--
-- What to check:
--   • step 1-2 (names): only the tenant(s) literally named CrankLeads / EmpireVu. No A1 row.
--   • step 3 (quote links): only app.crankleads.com / app.empirevu.com values; A1's quotes.* rows
--     appear only as 'skipped'.
--   • step 7 (A1 sender): exactly the A1 companies (A1 Marine Care, A1 Marine Storage, A1 Coatings,
--     boatnames.ca, …), each with the A1 sender. If a company is missing, or one is listed that
--     is not A1's, stop and fix the settings (or tell the developer) before migrating.
--   • the 'info' rows: things that look related but are deliberately NOT changed.

with settings as (
  select
    'quotes@a1marinestorage.ca'::text as a1_from,          -- = Railway OUTBOUND_FROM_EMAIL (bare address)
    'a1-group'::text as a1_org_slug,                         -- = Railway LEAD_INTAKE_ORG_SLUG (unset: a1-group)
    array['a1marinecare.ca', 'a1marinestorage.ca']::text[] as a1_domains
),
co as (
  -- to_jsonb keeps this working before the migration adds email_from_address.
  select c.id, c.organization_id, c.name, c.slug, c.brand_from_name, c.brand_reply_email, c.quote_public_base_url,
         to_jsonb(c) ->> 'email_from_address' as email_from_address,
         o.slug as org_slug, o.name as org_name
    from public.companies c
    join public.organizations o on o.id = c.organization_id
),
a1 as (
  select co.id,
         concat_ws(', ',
           case when co.org_slug = s.a1_org_slug then 'org slug ' || s.a1_org_slug end,
           case when lower(split_part(coalesce(co.brand_reply_email, ''), '@', 2)) = any (s.a1_domains) then 'reply email ' || co.brand_reply_email end,
           case when exists (select 1 from unnest(s.a1_domains) d
                              where co.quote_public_base_url ~* ('^https://([a-z0-9-]+\.)*' || replace(d, '.', '\.') || '(/|$)'))
                then 'quote host ' || co.quote_public_base_url end
         ) as why
    from co, settings s
),
a1_set as (select id, why from a1 where why <> ''),
legacy_quote as (
  select co.*, regexp_replace(co.quote_public_base_url, '^https://app\.(crankleads|empirevu)\.com', 'https://app.everdoer.com') as new_url
    from co
   where co.quote_public_base_url ~ '^https://app\.(crankleads|empirevu)\.com([/:?#]|$)'
),
rows as (
  -- 0. settings sanity
  select '0 settings' as step,
         case when exists (select 1 from public.organizations o, settings s where o.slug = s.a1_org_slug) then 'info' else 'CHECK: no org has this slug' end as action,
         'organizations.slug' as target, null::uuid as row_id, (select a1_org_slug from settings) as label,
         (select string_agg(o.name, ', ') from public.organizations o, settings s where o.slug = s.a1_org_slug) as current,
         '' as after, 'the A1 org (LEAD_INTAKE_ORG_SLUG)' as note

  -- 1. organization names
  union all
  select '1 org name', case when o.slug = s.a1_org_slug then 'skipped: A1 org' else 'will change' end,
         'organizations.name', o.id, o.slug, o.name,
         case when o.slug = s.a1_org_slug then '' else 'Everdoer' end, 'exact name match'
    from public.organizations o, settings s
   where o.name in ('CrankLeads', 'EmpireVu')
  union all
  select '1 org name', 'info: not exact, NOT changed', 'organizations.name', o.id, o.slug, o.name, '', 'contains an old brand but is not exactly CrankLeads / EmpireVu'
    from public.organizations o
   where (o.name ~* 'crank ?leads|empire ?vu') and o.name not in ('CrankLeads', 'EmpireVu')

  -- 2. company names
  union all
  select '2 company name', case when a1_set.id is not null then 'skipped: A1 company' else 'will change' end,
         'companies.name', co.id, co.org_slug || '/' || co.slug, co.name,
         case when a1_set.id is not null then '' else 'Everdoer' end, coalesce(a1_set.why, 'exact name match')
    from co left join a1_set on a1_set.id = co.id
   where co.name in ('CrankLeads', 'EmpireVu')
  union all
  select '2 company name', 'info: not exact, NOT changed', 'companies.name', co.id, co.org_slug || '/' || co.slug, co.name, '', 'contains an old brand but is not exactly CrankLeads / EmpireVu'
    from co
   where co.name ~* 'crank ?leads|empire ?vu' and co.name not in ('CrankLeads', 'EmpireVu')
  union all
  select '2 company name', 'info: NOT changed', 'companies.brand_from_name', co.id, co.org_slug || '/' || co.slug, co.brand_from_name, '', 'the email display name of a company; tenant branding is not touched'
    from co
   where co.brand_from_name ~* 'crank ?leads|empire ?vu'

  -- 3. quote link hosts
  union all
  select '3 quote link', case when a1_set.id is not null then 'skipped: A1 company' else 'will change' end,
         'companies.quote_public_base_url', lq.id, lq.org_slug || '/' || lq.slug || ' (' || lq.name || ')', lq.quote_public_base_url,
         case when a1_set.id is not null then '' else lq.new_url end, coalesce(a1_set.why, '')
    from legacy_quote lq left join a1_set on a1_set.id = lq.id
  union all
  select '3 quote link', 'info: NOT changed', 'companies.quote_public_base_url', co.id, co.org_slug || '/' || co.slug || ' (' || co.name || ')', co.quote_public_base_url, '', 'not on app.crankleads.com / app.empirevu.com'
    from co
   where co.quote_public_base_url is not null and co.id not in (select id from legacy_quote)

  -- 4. waitlist.source default
  union all
  select '4 default', case when pg_get_expr(d.adbin, d.adrelid) = '''everdoer.com''::text' then 'info: already done' else 'will change' end,
         'waitlist.source (default)', null, '', pg_get_expr(d.adbin, d.adrelid), '''everdoer.com''::text',
         'existing rows keep their source: ' || (select count(*) from public.waitlist)::text || ' row(s)'
    from pg_attrdef d
    join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
   where d.adrelid = 'public.waitlist'::regclass and a.attname = 'source'

  -- 5. comments
  union all
  select '5 comment', 'will change',
         c.relname || coalesce('.' || a.attname, ' (table)'), null, '', ds.description, '(reworded to Everdoer)', ''
    from pg_description ds
    join pg_class c on c.oid = ds.objoid and ds.classoid = 'pg_class'::regclass
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
    left join pg_attribute a on a.attrelid = c.oid and a.attnum = ds.objsubid and ds.objsubid > 0
   where ds.description ~ '(empirevu|crankleads)\.com|EmpireVu|CrankLeads'
     and (c.relname, coalesce(a.attname, '')) in (('dfy_progress', ''), ('organizations', 'platform_brand'), ('waitlist', ''))
  union all
  select '5 comment', 'info: NOT changed (another PR / not listed)',
         c.relname || coalesce('.' || a.attname, ' (table)'), null, '', ds.description, '', ''
    from pg_description ds
    join pg_class c on c.oid = ds.objoid and ds.classoid = 'pg_class'::regclass
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
    left join pg_attribute a on a.attrelid = c.oid and a.attnum = ds.objsubid and ds.objsubid > 0
   where ds.description ~ '(empirevu|crankleads)\.com|EmpireVu|CrankLeads'
     and (c.relname, coalesce(a.attname, '')) not in (('dfy_progress', ''), ('organizations', 'platform_brand'), ('waitlist', ''))

  -- 7. A1 sender (D7)
  union all
  select '7 A1 sender',
         case when co.email_from_address is not null then 'skipped: already set' else 'will change' end,
         'companies.email_from_address', co.id, co.org_slug || '/' || co.slug || ' (' || co.name || ')',
         coalesce(co.email_from_address, '(none)'),
         case when co.email_from_address is not null then '' else s.a1_from end,
         a1_set.why
    from co join a1_set on a1_set.id = co.id, settings s
)
select * from rows order by step, action, target, label;
