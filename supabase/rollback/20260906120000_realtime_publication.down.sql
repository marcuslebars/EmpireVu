-- Rollback for 20260906120000_realtime_publication.sql
do $$
begin
  if exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'activity_events'
  ) then
    alter publication supabase_realtime drop table public.activity_events;
  end if;

  if exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'message_log'
  ) then
    alter publication supabase_realtime drop table public.message_log;
  end if;
end
$$;
