-- Invoice opens + reminder controls.
--
--   • Every customer open of the invoice page is counted (a refresh / return from the
--     pay page within 30 minutes counts once): view_count, last_viewed_at. The first
--     open still sets first_viewed_at, which is what moves the status to "viewed".
--   • Email opens (a tracking image in the invoice + reminder emails): email_open_count,
--     first_ / last_email_opened_at. Kept apart from page views — some mail apps
--     report an open on their own, so it never changes the invoice status.
--   • reminders_paused: stop the automatic overdue reminders for ONE invoice. Staff
--     can set it (column grant below); the counters are server-owned (no grant).
--
-- Both counters are bumped by service-role-only functions so the increment and the
-- "first one?" answer are atomic and a burst of requests can't double count.

alter table public.invoices
  add column if not exists view_count integer not null default 0 check (view_count >= 0),
  add column if not exists last_viewed_at timestamptz,
  add column if not exists email_open_count integer not null default 0 check (email_open_count >= 0),
  add column if not exists first_email_opened_at timestamptz,
  add column if not exists last_email_opened_at timestamptz,
  add column if not exists reminders_paused boolean not null default false;

-- Invoices already opened before this existed count as one open.
update public.invoices
   set view_count = 1, last_viewed_at = first_viewed_at
 where first_viewed_at is not null and view_count = 0;

grant update (reminders_paused) on public.invoices to authenticated;

create or replace function public.record_invoice_view(
  p_invoice_id uuid,
  p_dedupe_seconds integer default 1800
) returns table (counted boolean, first_view boolean, view_count integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_first timestamptz;
  v_count integer;
begin
  select i.first_viewed_at into v_first
    from public.invoices i
   where i.id = p_invoice_id
     and i.status not in ('draft', 'void')
   for update;
  if not found then
    return query select false, false, 0;
    return;
  end if;

  update public.invoices i
     set view_count = i.view_count + 1,
         last_viewed_at = now(),
         first_viewed_at = coalesce(i.first_viewed_at, now())
   where i.id = p_invoice_id
     and (i.last_viewed_at is null
          or i.last_viewed_at < now() - make_interval(secs => greatest(p_dedupe_seconds, 0)))
  returning i.view_count into v_count;

  if v_count is null then
    select i.view_count into v_count from public.invoices i where i.id = p_invoice_id;
    return query select false, false, v_count;
    return;
  end if;
  return query select true, v_first is null, v_count;
end;
$$;

create or replace function public.record_invoice_email_open(
  p_invoice_id uuid,
  p_dedupe_seconds integer default 1800
) returns table (counted boolean, first_open boolean, open_count integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_first timestamptz;
  v_count integer;
begin
  select i.first_email_opened_at into v_first
    from public.invoices i
   where i.id = p_invoice_id
     and i.status not in ('draft', 'void')
   for update;
  if not found then
    return query select false, false, 0;
    return;
  end if;

  update public.invoices i
     set email_open_count = i.email_open_count + 1,
         last_email_opened_at = now(),
         first_email_opened_at = coalesce(i.first_email_opened_at, now())
   where i.id = p_invoice_id
     and (i.last_email_opened_at is null
          or i.last_email_opened_at < now() - make_interval(secs => greatest(p_dedupe_seconds, 0)))
  returning i.email_open_count into v_count;

  if v_count is null then
    select i.email_open_count into v_count from public.invoices i where i.id = p_invoice_id;
    return query select false, false, v_count;
    return;
  end if;
  return query select true, v_first is null, v_count;
end;
$$;

revoke all on function public.record_invoice_view(uuid, integer) from public, anon, authenticated;
revoke all on function public.record_invoice_email_open(uuid, integer) from public, anon, authenticated;
grant execute on function public.record_invoice_view(uuid, integer) to service_role;
grant execute on function public.record_invoice_email_open(uuid, integer) to service_role;
