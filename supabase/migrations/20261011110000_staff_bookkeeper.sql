-- Phase 2 — the AI Bookkeeper (docs/ai-staff.md → "Bookkeeper").
--
-- 1. invoice_collections     one row per invoice the Bookkeeper is chasing: text-reminder progress,
--                            a promise to pay, a hold on automatic reminders, the final notice.
-- 2. invoice_reminder_texts  every reminder TEXT (scheduled, final notice, owner-approved, payment-plan
--                            instalment), claimed by a unique (invoice_id, reminder_key) before it is sent.
-- 3. payment_plans           owner-approved instalment plans ("3 payments of $400").
-- 4. money_alerts            the daily owner money alert, one row per company per local day (the claim).
-- 5. money_alert_items       what an alert already told the owner (never repeated).
--
-- Settings live in companies.ai_settings.collections (no column needed).
--
-- Additive only and re-runnable. All writes go through the server (service role); members may READ
-- their company's rows (1–4). Nothing here is client-writable (see 20261006170000).
-- Rollback: supabase/rollback/20261011110000_staff_bookkeeper.down.sql

-- ── 1. Collections state per invoice ─────────────────────────────────────────────
create table if not exists public.invoice_collections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null,
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  -- Scheduled reminder texts sent so far (the index of the next step) and when the last text went.
  sms_count integer not null default 0 check (sms_count >= 0),
  last_sms_at timestamptz,
  -- No automatic reminders (text OR email) through this local date: a promise to pay or a plan.
  hold_until date,
  hold_reason text check (hold_reason is null or hold_reason in ('promise', 'payment_plan')),
  promise_date date,
  promise_recorded_at timestamptz,
  promise_status text check (promise_status is null or promise_status in ('open', 'kept', 'missed')),
  final_notice_status text not null default 'none'
    check (final_notice_status in ('none', 'proposed', 'approved', 'sent', 'skipped')),
  final_notice_approval_id uuid references public.owner_approvals(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (invoice_id),
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade
);
create index if not exists invoice_collections_company_idx on public.invoice_collections (company_id, updated_at desc);
create index if not exists invoice_collections_promise_idx on public.invoice_collections (promise_date) where promise_status = 'open';

-- ── 2. Reminder texts (claim-then-send) ───────────────────────────────────────────
create table if not exists public.invoice_reminder_texts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null,
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  -- "step:2", "final", "manual:<approval id>", "plan:<plan id>:<n>", "plan:<approval id>:confirm|decline"
  -- — one text per key, ever. plan_notice = a payment-plan confirmation/decline (queued like the rest).
  reminder_key text not null,
  kind text not null check (kind in ('scheduled', 'final_notice', 'manual', 'instalment', 'plan_notice')),
  -- queued = approved by the owner, waiting for the 09:00–20:00 send window.
  status text not null default 'claimed' check (status in ('queued', 'claimed', 'sent', 'blocked', 'failed', 'skipped')),
  body text,
  -- The balance the text states (an owner-approved text is not sent if it changed).
  balance_cents integer,
  reason text,
  approval_id uuid references public.owner_approvals(id) on delete set null,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (invoice_id, reminder_key),
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade
);
create index if not exists invoice_reminder_texts_contact_idx on public.invoice_reminder_texts (company_id, contact_id, created_at desc);
create index if not exists invoice_reminder_texts_queued_idx on public.invoice_reminder_texts (created_at) where status = 'queued';

-- ── 3. Payment plans ──────────────────────────────────────────────────────────────
create table if not exists public.payment_plans (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null,
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  approval_id uuid references public.owner_approvals(id) on delete set null,
  status text not null default 'active' check (status in ('active', 'completed', 'cancelled')),
  -- [{ n, dueDate: 'YYYY-MM-DD', amountCents }]
  instalments jsonb not null default '[]'::jsonb,
  total_cents integer not null check (total_cents > 0),
  -- The invoice's balance when the plan started (what's been paid since = this − balance now).
  starting_balance_cents integer not null,
  activated_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade
);
create unique index if not exists payment_plans_approval_idx on public.payment_plans (approval_id) where approval_id is not null;
create unique index if not exists payment_plans_one_active_idx on public.payment_plans (invoice_id) where status = 'active';
create index if not exists payment_plans_company_idx on public.payment_plans (company_id, status);

-- ── 4. Daily owner money alert (one per company per local day) ───────────────────
create table if not exists public.money_alerts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null,
  alert_date date not null,
  status text not null default 'claimed' check (status in ('claimed', 'sent', 'skipped', 'failed')),
  body text,
  items jsonb not null default '[]'::jsonb,
  sent_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, alert_date),
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade
);

-- ── 5. What the owner was already told (service role only) ───────────────────────
create table if not exists public.money_alert_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null,
  -- "overdue30:<invoice>", "payment_failed:<payment>", "sync_failed:<job>", …
  item_key text not null,
  alert_date date not null,
  created_at timestamptz not null default now(),
  unique (company_id, item_key),
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade
);

-- ── RLS: members read their own; nobody writes from the browser ───────────────────
alter table public.invoice_collections enable row level security;
alter table public.invoice_reminder_texts enable row level security;
alter table public.payment_plans enable row level security;
alter table public.money_alerts enable row level security;
alter table public.money_alert_items enable row level security;

drop policy if exists "invoice_collections_select" on public.invoice_collections;
create policy "invoice_collections_select" on public.invoice_collections
  for select using (public.is_organization_member(organization_id));
drop policy if exists "invoice_reminder_texts_select" on public.invoice_reminder_texts;
create policy "invoice_reminder_texts_select" on public.invoice_reminder_texts
  for select using (public.is_organization_member(organization_id));
drop policy if exists "payment_plans_select" on public.payment_plans;
create policy "payment_plans_select" on public.payment_plans
  for select using (public.is_organization_member(organization_id));
drop policy if exists "money_alerts_select" on public.money_alerts;
create policy "money_alerts_select" on public.money_alerts
  for select using (public.is_organization_member(organization_id));

revoke insert, update, delete on public.invoice_collections from anon, authenticated;
revoke insert, update, delete on public.invoice_reminder_texts from anon, authenticated;
revoke insert, update, delete on public.payment_plans from anon, authenticated;
revoke insert, update, delete on public.money_alerts from anon, authenticated;
revoke all on public.money_alert_items from anon, authenticated;
revoke select on public.invoice_collections, public.invoice_reminder_texts, public.payment_plans, public.money_alerts from anon;
grant select on public.invoice_collections, public.invoice_reminder_texts, public.payment_plans, public.money_alerts to authenticated;
grant all on public.invoice_collections, public.invoice_reminder_texts, public.payment_plans, public.money_alerts, public.money_alert_items to service_role;

drop trigger if exists invoice_collections_set_updated_at on public.invoice_collections;
create trigger invoice_collections_set_updated_at before update on public.invoice_collections
  for each row execute procedure public.touch_updated_at();
drop trigger if exists invoice_reminder_texts_set_updated_at on public.invoice_reminder_texts;
create trigger invoice_reminder_texts_set_updated_at before update on public.invoice_reminder_texts
  for each row execute procedure public.touch_updated_at();
drop trigger if exists payment_plans_set_updated_at on public.payment_plans;
create trigger payment_plans_set_updated_at before update on public.payment_plans
  for each row execute procedure public.touch_updated_at();
drop trigger if exists money_alerts_set_updated_at on public.money_alerts;
create trigger money_alerts_set_updated_at before update on public.money_alerts
  for each row execute procedure public.touch_updated_at();

comment on table public.invoice_collections is 'AI Bookkeeper: text-reminder progress, promise to pay, reminder hold and final notice per invoice (docs/ai-staff.md).';
comment on table public.invoice_reminder_texts is 'AI Bookkeeper: every invoice reminder text, claimed by (invoice_id, reminder_key) before sending.';
comment on table public.payment_plans is 'AI Bookkeeper: owner-approved instalment plans.';
comment on table public.money_alerts is 'AI Bookkeeper: the daily owner money alert (one per company per local day).';
comment on table public.money_alert_items is 'AI Bookkeeper: items already reported in a money alert (never repeated).';
