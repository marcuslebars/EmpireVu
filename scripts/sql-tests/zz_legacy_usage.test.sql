-- Privilege + behaviour tests for 20261016100000_legacy_usage.sql (Everdoer rebrand, PR 1).
--   • RLS on; anon/authenticated can neither read nor write nor call the RPC; service role can;
--   • the RPC counts per (day, kind, key), keeps the first sample, truncates long keys/samples;
--   • an unknown kind is rejected.
\set ON_ERROR_STOP on
set client_min_messages = notice;
reset role;

do $$
declare
  r text;
  p text;
  n bigint;
  s text;
begin
  raise notice '== legacy_usage: RLS on, service role only';
  if not (select relrowsecurity from pg_class where oid = 'public.legacy_usage'::regclass) then
    raise exception 'FAIL legacy_usage has RLS off';
  end if;
  foreach r in array array['anon','authenticated'] loop
    foreach p in array array['SELECT','INSERT','UPDATE','DELETE'] loop
      if has_table_privilege(r, 'public.legacy_usage', p) then
        raise exception 'FAIL % has % on legacy_usage', r, p;
      end if;
    end loop;
    if has_function_privilege(r, 'public.note_legacy_usage(text, text, text)', 'EXECUTE') then
      raise exception 'FAIL % can execute note_legacy_usage', r;
    end if;
  end loop;
  if not has_function_privilege('service_role', 'public.note_legacy_usage(text, text, text)', 'EXECUTE') then
    raise exception 'FAIL service_role cannot execute note_legacy_usage';
  end if;
  if not has_table_privilege('service_role', 'public.legacy_usage', 'SELECT') then
    raise exception 'FAIL service_role cannot read legacy_usage';
  end if;

  raise notice '== legacy_usage: counting';
  perform public.note_legacy_usage('header', 'x-empirevu-key', '/api/intake');
  perform public.note_legacy_usage('header', 'x-empirevu-key', null);
  perform public.note_legacy_usage('header', 'x-empirevu-key', '/api/other');
  perform public.note_legacy_usage('host', 'app.empirevu.com', '/dashboard');
  select count, sample into n, s from public.legacy_usage where kind = 'header' and key = 'x-empirevu-key' and day = (now() at time zone 'utc')::date;
  if n <> 3 then raise exception 'FAIL expected count 3, got %', n; end if;
  if s is distinct from '/api/other' then raise exception 'FAIL expected latest non-null sample, got %', s; end if;
  if (select count(*) from public.legacy_usage) <> 2 then raise exception 'FAIL expected 2 rows'; end if;

  perform public.note_legacy_usage('env', repeat('K', 300), repeat('s', 500));
  if (select length(key) from public.legacy_usage where kind = 'env') <> 120 then raise exception 'FAIL key not truncated'; end if;
  if (select length(sample) from public.legacy_usage where kind = 'env') <> 200 then raise exception 'FAIL sample not truncated'; end if;

  begin
    perform public.note_legacy_usage('nonsense', 'x', null);
    raise exception 'FAIL unknown kind accepted';
  exception when check_violation then
    null;
  end;

  delete from public.legacy_usage;
  raise notice 'legacy_usage: OK';
end $$;

-- As the client roles, the RPC must be refused outright.
set role anon;
do $$
begin
  perform public.note_legacy_usage('header', 'x', null);
  raise exception 'FAIL anon called note_legacy_usage';
exception when insufficient_privilege then
  null;
end $$;
reset role;
set role authenticated;
do $$
begin
  perform public.note_legacy_usage('header', 'x', null);
  raise exception 'FAIL authenticated called note_legacy_usage';
exception when insufficient_privilege then
  null;
end $$;
reset role;
