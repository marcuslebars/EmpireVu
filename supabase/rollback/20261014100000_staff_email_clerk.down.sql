-- Rollback for 20261014100000_staff_email_clerk.sql (the Email inbox). Drops only what it added.
-- Pending email_reply approvals are withdrawn first (superseded) so a late "Y" can't reach an
-- executor whose rows are gone; decided ones are left as history. message_log rows the inbox wrote
-- (inbound emails, sent replies) stay: they're the customer's conversation history.
-- The bucket's files must be emptied first (Storage → email-attachments) or the bucket delete fails.
-- After this, delete the Resend webhook (and unset INBOUND_EMAIL_DOMAIN / RESEND_WEBHOOK_SECRET) —
-- deliveries would otherwise fail.
update public.owner_approvals set status = 'superseded' where kind = 'email_reply' and status = 'pending';

drop table if exists public.email_clerk_digests;
drop table if exists public.email_attachments;
drop table if exists public.inbound_emails;
drop table if exists public.email_inboxes;

delete from storage.buckets where id = 'email-attachments';
