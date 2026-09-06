-- Realtime (Task 11): stream inserts on the two tables the UI watches live so the
-- dashboard, activity feed, open contact, and inbox update the moment a customer replies
-- or a workflow fires.
--
-- Row visibility is still governed by the tables' existing RLS SELECT policies
-- (activity_events_org_members_select / message_log_org_members_select): the browser
-- subscribes with the authenticated anon client, so a non-member receives nothing.
--
-- Idempotent: skip a table already in the publication (re-running is safe).

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'activity_events'
  ) then
    alter publication supabase_realtime add table public.activity_events;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'message_log'
  ) then
    alter publication supabase_realtime add table public.message_log;
  end if;
end
$$;
