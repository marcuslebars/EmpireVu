-- Rollback of 20261009160000_front_desk_hardening.sql.
drop index if exists public.owner_approvals_code_recent_idx;
drop index if exists public.owner_approvals_notified_idx;
alter table public.owner_approvals drop column if exists notified_to;
