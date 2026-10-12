-- Rollback for 20261013120000_staff_compliance.sql (the AI Compliance clerk: insurance, WSIB,
-- licences, subs). Drops only what it added. owner_approvals rows of kinds request_sub_docs /
-- share_compliance_doc are left in place (they're history); their executors are gone once the
-- code is reverted. Shared links stop working (the redirect route and its rows are gone).
-- The bucket's files must be emptied first (Storage → compliance-docs) or the bucket delete fails.
drop table if exists public.compliance_uploads;
drop table if exists public.compliance_events;
drop table if exists public.compliance_shares;
drop table if exists public.compliance_upload_requests;
drop table if exists public.compliance_documents;
drop table if exists public.subcontractors;

delete from storage.buckets where id = 'compliance-docs';
