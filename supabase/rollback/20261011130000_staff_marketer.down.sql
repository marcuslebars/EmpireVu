-- Rollback for 20261011130000_staff_marketer.sql (the AI Marketer). Drops only what it added.
-- owner_approvals rows of kinds marketing_campaign / review_reply / google_post are left in
-- place (they're history); their executors are gone once the code is reverted.
drop table if exists public.marketing_sweep_claims;
drop table if exists public.google_post_drafts;
drop table if exists public.google_reviews;
drop table if exists public.marketing_campaign_recipients;
drop table if exists public.marketing_campaigns;
