-- Phase 1 hardening (docs/front-desk-ai.md, "Hardening"). Additive; rollback in
-- supabase/rollback/20261009160000_front_desk_hardening.down.sql.

-- ── 1. Approvals are decided by text only from the phone that was asked ───────────
-- notified_to = the owner phone the approval text went to. An SMS "Y" only counts for rows
-- notified to that phone (quiet-hours rows that were never sent can't be approved blind).
alter table public.owner_approvals add column if not exists notified_to text;
create index if not exists owner_approvals_notified_idx
  on public.owner_approvals (company_id, created_at desc) where notified_at is not null;
-- Short codes come from one per-company sequence that doesn't reuse a code for 7 days
-- (front-desk/approvals.ts); this index serves that lookup.
create index if not exists owner_approvals_code_recent_idx
  on public.owner_approvals (company_id, created_at desc, short_code);
