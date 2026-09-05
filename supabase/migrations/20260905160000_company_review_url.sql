-- Recipe library (Task 10): a company branding field for the review-request recipe.
--
-- The review-request recipe texts a customer a "leave us a review" link a day after a
-- completed booking. That link is per-company branding, so it lives alongside the other
-- brand_* columns on companies and is exposed to templates as {{ company.review_url }}
-- (like the computed {{ company.booking_url }}).
--
-- Additive: one nullable column.

alter table public.companies add column if not exists brand_review_url text;
