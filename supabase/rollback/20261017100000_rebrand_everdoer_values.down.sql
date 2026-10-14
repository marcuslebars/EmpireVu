-- Rollback of 20261017100000_rebrand_everdoer_values.sql (Everdoer rebrand, PR 2: stored values + D7).
--
-- 1. Restores, from public.rebrand_values_backup, every org/company name and quote link host the
--    migration changed, but only where the row still holds the value the migration wrote (a name
--    someone changed by hand since is left alone and reported).
-- 2. Restores the table/column comments and the waitlist.source default from the backup.
-- 3. Drops companies.email_from_address (and its check). The app then sends every message from
--    EVERDOER_DEFAULT_FROM_EMAIL, else OUTBOUND_FROM_EMAIL: UNSET EVERDOER_DEFAULT_FROM_EMAIL
--    BEFORE running this if it is set, or A1's customer mail moves to that address.
-- 4. Drops the backup table, last.
-- Re-runnable: does nothing once the backup table is gone (beyond dropping the column).

begin;

do $$
declare
  r record;
  n integer;
  skipped integer := 0;
begin
  if to_regclass('public.rebrand_values_backup') is null then
    raise notice 'rebrand_values_backup not found: nothing to restore (already rolled back?)';
    return;
  end if;

  -- Names and quote links: only rows still holding the migration's value.
  for r in
    select * from public.rebrand_values_backup
     where step in ('name', 'quote_public_base_url')
     order by id
  loop
    execute format('update public.%I set %I = $1 where id = $2 and %I is not distinct from $3', r.target_table, r.target_column, r.target_column)
      using r.old_value, r.row_id, r.new_value;
    get diagnostics n = row_count;
    if n = 0 then
      skipped := skipped + 1;
      raise notice 'left alone: %.% of % (changed since the migration, or deleted)', r.target_table, r.target_column, r.row_id;
    end if;
  end loop;

  -- Comments.
  for r in select * from public.rebrand_values_backup where step = 'comment' order by id loop
    if to_regclass('public.' || r.target_table) is null then
      continue;
    end if;
    if r.target_column is null then
      execute format('comment on table public.%I is %L', r.target_table, r.old_value);
    else
      execute format('comment on column public.%I.%I is %L', r.target_table, r.target_column, r.old_value);
    end if;
  end loop;

  -- Defaults (the backed-up expression, e.g. 'empirevu.com'::text).
  for r in select * from public.rebrand_values_backup where step = 'default' order by id loop
    if r.old_value is null then
      execute format('alter table public.%I alter column %I drop default', r.target_table, r.target_column);
    else
      execute format('alter table public.%I alter column %I set default %s', r.target_table, r.target_column, r.old_value);
    end if;
  end loop;

  if skipped > 0 then
    raise notice '% value(s) were not restored because they changed after the migration', skipped;
  end if;
end $$;

alter table public.companies drop constraint if exists companies_email_from_address_check;
alter table public.companies drop column if exists email_from_address;

drop table if exists public.rebrand_values_backup;

commit;
