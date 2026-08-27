-- Org-scoped Stripe: each tenant charges its own customers through its OWN
-- Stripe account.
--
-- There are now TWO unrelated Stripe relationships, and conflating them would be
-- expensive, so the naming keeps them apart:
--
--   organizations.stripe_customer_id        the org AS TILOTTO'S CUSTOMER.
--                                           Platform billing (Phase 1) — the org's
--                                           subscription to us. Runs on the
--                                           PLATFORM account and its global env
--                                           keys. Untouched here.
--
--   organizations.stripe_merchant_*         the org AS A MERCHANT. Its own Stripe
--                                           account, charging ITS customers for
--                                           quote deposits and balances. Resolved
--                                           per org — that is what this migration
--                                           adds.
--
-- WHERE THE SECRETS LIVE
-- The secret key and webhook signing secret are NOT stored here. These columns
-- hold the NAME of the Railway env var that holds each secret. Rationale:
--   • live Stripe secret keys in Postgres would sit in every backup, every
--     read-replica, and every db dump, readable by anything with DB access;
--   • the repo's standing rule is that secrets live server-side in Railway;
--   • rotating a key then means changing one Railway var, not a DB write.
-- Resolution is still fully per-org: the org row decides WHICH var is read.
--
-- The env var names are constrained to a STRIPE_MERCHANT_ prefix. Org settings are
-- admin-editable, so without this an org row could name any variable in the
-- process environment (SUPABASE_SERVICE_ROLE_KEY, say) and have the resolver read
-- it. The prefix contains what an org admin can reach. The application enforces
-- the same pattern; this is the second lock.

alter table public.organizations
  add column if not exists stripe_merchant_account_id text;

alter table public.organizations
  add column if not exists stripe_merchant_secret_key_env text;

alter table public.organizations
  add column if not exists stripe_merchant_webhook_secret_env text;

-- 'test' | 'live' — recorded so the admin UI can show which mode an org is in
-- without dereferencing a secret.
alter table public.organizations
  add column if not exists stripe_merchant_mode text;

alter table public.organizations drop constraint if exists organizations_stripe_merchant_mode_check;
alter table public.organizations add constraint organizations_stripe_merchant_mode_check
  check (stripe_merchant_mode is null or stripe_merchant_mode in ('test', 'live'));

-- Env var names: uppercase, underscore, STRIPE_MERCHANT_ prefixed. See the note above.
alter table public.organizations drop constraint if exists organizations_stripe_merchant_key_env_check;
alter table public.organizations add constraint organizations_stripe_merchant_key_env_check
  check (
    stripe_merchant_secret_key_env is null or
    stripe_merchant_secret_key_env ~ '^STRIPE_MERCHANT_[A-Z0-9_]{1,60}$'
  );

alter table public.organizations drop constraint if exists organizations_stripe_merchant_hook_env_check;
alter table public.organizations add constraint organizations_stripe_merchant_hook_env_check
  check (
    stripe_merchant_webhook_secret_env is null or
    stripe_merchant_webhook_secret_env ~ '^STRIPE_MERCHANT_[A-Z0-9_]{1,60}$'
  );

-- Two orgs must not share a merchant account — that would cross-post one tenant's
-- payments into another's books.
create unique index if not exists organizations_stripe_merchant_account_uniq
  on public.organizations (stripe_merchant_account_id)
  where stripe_merchant_account_id is not null;
