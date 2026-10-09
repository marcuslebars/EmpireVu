-- Owner channel (docs/front-desk-ai.md "## Owner by text").
--
-- 1. platform_sms_opt_outs: a business owner who texts STOP to the platform number
--    (TWILIO_FROM_NUMBER) stops getting platform texts from us (approval requests, replies to
--    their commands). Keyed by the phone, not by company: one phone can own several
--    companies, and an unknown sender can opt out too. START / UNSTOP (or YES while opted
--    out) clears it. Service role only — no client ever reads or writes it.
-- 2. Indexes for the approvals sweep (pending + unnotified / pending + expiring) and for the
--    per-phone owner_command_log lookups (recent context, "which business?" follow-ups).
--
-- Additive / idempotent. Rollback: supabase/rollback/20261009121000_owner_channel.down.sql

create table if not exists public.platform_sms_opt_outs (
  phone_e164 text primary key,
  opted_out_at timestamptz,
  opted_in_at timestamptz,
  source_ref text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.platform_sms_opt_outs is
  'Phones that texted STOP to the platform number. opted_out_at not null = do not send platform texts to this phone.';

alter table public.platform_sms_opt_outs enable row level security;
revoke all on public.platform_sms_opt_outs from anon, authenticated;

drop trigger if exists platform_sms_opt_outs_set_updated_at on public.platform_sms_opt_outs;
create trigger platform_sms_opt_outs_set_updated_at before update on public.platform_sms_opt_outs
  for each row execute procedure public.touch_updated_at();

create index if not exists owner_approvals_unnotified_idx
  on public.owner_approvals (created_at) where status = 'pending' and notified_at is null;
create index if not exists owner_approvals_expiring_idx
  on public.owner_approvals (expires_at) where status = 'pending' and expires_at is not null;
create index if not exists owner_command_log_phone_idx
  on public.owner_command_log (from_phone, created_at desc);
