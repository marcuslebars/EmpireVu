-- Rollback for 20261009120000_invoice_opens_reminders.sql. Roll the app code back first.
-- first_viewed_at (and the "viewed" status) are untouched; the open counts and the
-- per-invoice reminder pauses are dropped (paused invoices resume reminding).
drop function if exists public.record_invoice_view(uuid, integer);
drop function if exists public.record_invoice_email_open(uuid, integer);
revoke update (reminders_paused) on public.invoices from authenticated;
alter table public.invoices
  drop column if exists view_count,
  drop column if exists last_viewed_at,
  drop column if exists email_open_count,
  drop column if exists first_email_opened_at,
  drop column if exists last_email_opened_at,
  drop column if exists reminders_paused;
