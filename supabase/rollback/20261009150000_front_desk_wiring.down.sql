-- Rollback of 20261009150000_front_desk_wiring.sql: members may read call_answering_notices again.
grant select on public.call_answering_notices to authenticated;
drop policy if exists "call_answering_notices_select" on public.call_answering_notices;
create policy "call_answering_notices_select" on public.call_answering_notices
  for select using (public.is_organization_member(organization_id));
