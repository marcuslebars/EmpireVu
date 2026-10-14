-- READ-ONLY audit for supabase/migrations/20261017100000_rebrand_everdoer_values.sql
-- (Everdoer rebrand, PR 2). Run it in the Supabase SQL editor BEFORE the migration, and again
-- after it (every "will change" row should then be gone). It only SELECTs.
--
-- One result set, one row per thing:
--   step     what the migration does with it
--   action   'will change' | 'info: NOT changed' (and why)
--   target   table.column (or the comment / default)
--   row_id   the company id
--   label    org slug / company slug (name), to recognise the row
--   current  the value now
--   after    the value after the migration ('' = unchanged)
--   note     why
--
-- What to check:
--   • step 1 (quote links): only app.crankleads.com / app.empirevu.com values change; A1's
--     quotes.a1marine*.ca rows appear as 'info: NOT changed'.
--   • step 4: the email_from_address column doesn't exist yet (or is empty): the migration sets
--     no value. The house org (A1) keeps OUTBOUND_FROM_EMAIL in code.
--   • the 'info' rows: things that look related but are deliberately NOT changed here (the tenant
--     named CrankLeads / EmpireVu is renamed in the app).

with co as (
  select c.id, c.name, c.slug, c.quote_public_base_url, c.brand_from_name,
         to_jsonb(c) ->> 'email_from_address' as email_from_address,   -- works before the column exists
         o.slug as org_slug
    from public.companies c
    join public.organizations o on o.id = c.organization_id
),
legacy_quote as (
  select co.*, regexp_replace(co.quote_public_base_url, '^https://app\.(crankleads|empirevu)\.com', 'https://app.everdoer.com') as new_url
    from co
   where co.quote_public_base_url ~ '^https://app\.(crankleads|empirevu)\.com([/:?#]|$)'
),
audit as (
  -- 1. quote link hosts
  select '1 quote link' as step, 'will change' as action, 'companies.quote_public_base_url' as target, lq.id as row_id,
         lq.org_slug || '/' || lq.slug || ' (' || lq.name || ')' as label, lq.quote_public_base_url as current, lq.new_url as after, '' as note
    from legacy_quote lq
  union all
  select '1 quote link', 'info: NOT changed', 'companies.quote_public_base_url', co.id, co.org_slug || '/' || co.slug || ' (' || co.name || ')',
         co.quote_public_base_url, '', 'not on app.crankleads.com / app.empirevu.com'
    from co
   where co.quote_public_base_url is not null and co.id not in (select id from legacy_quote)

  -- 2. waitlist.source default
  union all
  select '2 default', case when pg_get_expr(d.adbin, d.adrelid) = '''everdoer.com''::text' then 'info: already done' else 'will change' end,
         'waitlist.source (default)', null, '', pg_get_expr(d.adbin, d.adrelid), '''everdoer.com''::text',
         'existing rows keep their source: ' || (select count(*) from public.waitlist)::text || ' row(s)'
    from pg_attrdef d
    join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
   where d.adrelid = 'public.waitlist'::regclass and a.attname = 'source'

  -- 3. comments
  union all
  select '3 comment',
         case when (c.relname, coalesce(a.attname, '')) in (('dfy_progress', ''), ('organizations', 'platform_brand'), ('waitlist', ''))
              then 'will change' else 'info: NOT changed (another PR)' end,
         c.relname || coalesce('.' || a.attname, ' (table)'), null, '', ds.description, '', ''
    from pg_description ds
    join pg_class c on c.oid = ds.objoid and ds.classoid = 'pg_class'::regclass
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
    left join pg_attribute a on a.attrelid = c.oid and a.attnum = ds.objsubid and ds.objsubid > 0
   where ds.description ~ '(empirevu|crankleads)\.com|EmpireVu|CrankLeads'

  -- 4. D7 column (nothing is set by the migration)
  union all
  select '4 sender', 'info: NOT changed', 'companies.email_from_address', co.id, co.org_slug || '/' || co.slug || ' (' || co.name || ')',
         co.email_from_address, '', 'already set (by the service role)'
    from co
   where co.email_from_address is not null

  -- info: names the migration no longer touches (rename in the app)
  union all
  select '5 names', 'info: NOT changed (rename in the app)', 'organizations.name', o.id, o.slug, o.name, '', ''
    from public.organizations o
   where o.name ~* 'crank ?leads|empire ?vu'
  union all
  select '5 names', 'info: NOT changed (rename in the app)', 'companies.name', co.id, co.org_slug || '/' || co.slug, co.name, '', ''
    from co
   where co.name ~* 'crank ?leads|empire ?vu'
)
select * from audit order by step, action, target, label;
