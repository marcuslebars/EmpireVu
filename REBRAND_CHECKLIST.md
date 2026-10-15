# Everdoer rebrand: manual steps checklist

These are the steps that only you can do: SQL, DNS, dashboards and env. Do them **in order**. Every step says where to do it, the exact value, how to check it worked, and how to undo it. Each PR adds its own section. This version covers **PR 1 (compatibility layer)** in full; the later sections are a skeleton that gets filled in as each PR lands.

Ground rules:
- Old hosts stay up for at least 12 months.
- app.empirevu.com `/api/*` stays up until the last old mobile build is gone.
- Never delete an old webhook, URI or redirect entry while a new one is being added. Add the new one alongside the old.

Values written as `‹…›` come from a dashboard at the time you do the step (for example, the CNAME target Railway shows you). Everything else is exact.

---

## PR 1: compatibility layer (no visible change)

### 1.1 After PR 1 is merged and deployed
- [ ] **Run the migration.**
  - Supabase → SQL editor → paste `supabase/migrations/20261016100000_legacy_usage.sql` → Run.
  - Check: `select count(*) from public.legacy_usage;` returns 0, then grows within a minute or two. The A1 sites still send `x-empirevu-*` headers, so `header` rows should appear.
  - Undo: `supabase/rollback/20261016100000_legacy_usage.down.sql`. The app keeps working without the table; it logs to the console only.
- [ ] **Watch the deploy logs for 10 minutes.** `[legacy-usage] kind=header key=x-empirevu-…` lines are expected (one per A1 intake / Retell / Telnyx request). Nothing else should change.
  - Watch for any new `401` / `403` / `503` on the paths whose checks changed:
    - `/api/twilio/voice/*` (signature candidates)
    - `/api/intake`, `/api/retell/functions/*`, `/api/telnyx/*` (header names)
    - `/api/webhooks/stripe` and `/api/webhooks/stripe/connect` (optional second secret)

    If one appears, roll back the deploy.

### 1.2 New hosts: DNS + Railway
- [ ] **Railway → project EmpireVu → service EmpireVu (web) → Settings → Networking → Custom domain → add `app.everdoer.com`.** Railway shows a CNAME target `‹target›`.
- [ ] Same → add **`api.everdoer.com`**.
- [ ] **DNS (everdoer.com zone):**
  - `CNAME app → ‹target for app.everdoer.com›`
  - `CNAME api → ‹target for api.everdoer.com›`
  - TTL 300 for now.
- [ ] Wait for Railway to show both as active (certificate issued). Check: `curl -sI https://app.everdoer.com/api/health` → `200`.
- [ ] Leave app.empirevu.com, api.empirevu.com and app.crankleads.com exactly as they are.
- [ ] Do **not** set `EVERDOER_REDIRECT_LEGACY_HOSTS` yet; that's after PR 2.
- Undo: remove the two custom domains. Nothing points at them yet.

### 1.3 Sign-in allowlists (before anyone signs in on the new host)
- [ ] **Supabase → Authentication → URL configuration → Redirect URLs → add:**
  - `https://app.everdoer.com/**`
  - `https://app.everdoer.com/oauth/callback`
  - `https://app.everdoer.com/update-password`

  Keep every existing entry. Leave the Site URL unchanged for now (PR 2).
- [ ] **Google Cloud → APIs & Services → Credentials → the web OAuth client → Authorized JavaScript origins → add** `https://app.everdoer.com`. Keep the old origins. Authorized redirect URIs are unchanged (they point at Supabase).
- [ ] **Cloudflare Turnstile → the widget used by `VITE_TURNSTILE_SITE_KEY` → Hostnames → add** `app.everdoer.com` and `api.everdoer.com`. Keep the old ones.
- Check: open https://app.everdoer.com/signin. It shows today's lime (CrankLeads) sign-in for now; PR 2 makes it Everdoer. Google sign-in should return you signed in.

### 1.4 Email domains (verification takes time, so start now)
- [ ] **Resend → Domains → add `everdoer.com`** (sending). Add the SPF/DKIM records Resend shows (`‹values›`) to the everdoer.com zone. Add DMARC `TXT _dmarc → v=DMARC1; p=none; rua=mailto:hello@everdoer.com`. Don't send from it yet; that's PR 2 (D7).
- [ ] **Resend → Domains → add `in.everdoer.com`** with receiving on. Add `MX in → ‹Resend inbound MX›` (priority 10).
- [ ] **Mailbox `hello@everdoer.com`.** Create it, or forward it to wherever hello@empirevu.com goes today. Keep hello@empirevu.com and hello@crankleads.com forwarding for at least 12 months.
- [ ] **Railway → EmpireVu (web) + "EmpireVu worker" → variables:** `INBOUND_EMAIL_DOMAINS=in.everdoer.com`. Inbound email isn't live today (`INBOUND_EMAIL_DOMAIN` is unset), so nothing old needs listing. If you ever set `INBOUND_EMAIL_DOMAIN`, list both, new first.
  - Set it only once Resend shows `in.everdoer.com` verified, together with the `RESEND_WEBHOOK_SECRET` step from the Phase 5 checklist.

### 1.5 Env: new names alongside the old (no behaviour change)
For each pair, copy the **current value** of the old variable into the new name **on every service where the old variable is set**. Check each service in project EmpireVu, not just web: Railway → service → Variables. The known readers are:
- `STRIPE_PRICE_*`: EmpireVu (web), billiing-worker and billing-reconcile, which map price → plan.
- `QUOTE_PUBLIC_BASE_URL_*`: EmpireVu (web) and the worker services.
- Everything else in the table: EmpireVu (web) only.

If a service is missed, it keeps reading the old name and keeps logging `env/<old name>`, so the 1.8 check will catch it. Leave every old variable in place until PR 8 so a rollback still works. The app reads the new name first.

| New variable | Copy the value from | Notes |
|---|---|---|
| `EVERDOER_SITE_ORIGINS` | `CRANKLEADS_SITE_ORIGINS` | **Then append** `,https://everdoer.com,https://www.everdoer.com`. If `CRANKLEADS_SITE_ORIGINS` is unset, leave this unset too (the built-in default already includes everdoer.com). |
| `EVERDOER_CANCEL_URL` | `CRANKLEADS_CANCEL_URL` | only if set |
| `EVERDOER_CHECKOUT_DISPLAY_NAME`, `_LOGO_URL`, `_BACKGROUND_COLOR`, `_BUTTON_COLOR` | `CRANKLEADS_CHECKOUT_*` | only if set; the copy changes in PR 2 |
| `STRIPE_PRICE_EVERDOER_CATCH`, `_CLOSE`, `_FRONT_DESK` | `STRIPE_PRICE_CL_CATCH`, `_CLOSE`, `_FRONT_DESK` | same price ids (they are immutable; that's an approved exception) |
| `STRIPE_SETUP_FEE_EVERDOER_CATCH`, `_CLOSE`, `_FRONT_DESK` | `STRIPE_SETUP_FEE_CL_*` | same ids |
| `STRIPE_COUPON_EVERDOER_FOUNDING` | `STRIPE_COUPON_CL_FOUNDING` | same id |
| `QUOTE_PUBLIC_BASE_URL_EVERDOER` | `QUOTE_PUBLIC_BASE_URL_CRANKLEADS` | only if set |

- **Don't** set `EVERDOER_APP_BASE_URL` yet. It moves done-for-you links to app.everdoer.com and is a PR 2 step.
- Check: in each service's logs, `[legacy-usage] kind=env key=CRANKLEADS_…` / `STRIPE_PRICE_CL_…` lines stop appearing once its new names are set.
- Undo: delete the new variable; the old name is read again.

### 1.6 Turn on new names for writes (after PR 1 has been stable for 48 h)
- [ ] **Set `EVERDOER_WRITE_NEW_NAMES=1` on every service in project EmpireVu:**
  - EmpireVu (web)
  - EmpireVu worker
  - workflow-events
  - crankleads-sweep
  - billiing-worker
  - billing-reconcile
  - quote-maintenance
  - monthly-scorecard

  (Skip jobber-sync; it's deleted in PR 5.)

  From then on:
  - new Retell tool configs use the `x-everdoer-retell-secret` header
  - new Twilio numbers are tagged `Everdoer catcher <id>` / `Everdoer line <id>`
  - forwarding tests write `EverdoerForwardingTestId`
  - new Stripe checkouts carry `source: "everdoer"` and land on `/welcome/everdoer`
  - Undo: unset the variable on every service; readers accept both names either way.
- [ ] **Retag our Twilio numbers.**
  - Railway → EmpireVu worker → shell (or locally with prod env): `npm run job:twilio-retag`. This is a dry run and prints every number it would rename.
  - Check the list contains only `EmpireVu catcher …` / `EmpireVu line …` numbers and no A1 numbers.
  - Then run `npm run job:twilio-retag -- --apply`. It refuses unless step 1.6 is on.
  - Undo: none needed; both tags are recognised.

### 1.7 Optional, only if you need two Stripe webhook endpoints at once
- `STRIPE_WEBHOOK_SECRET_2` / `STRIPE_CONNECT_WEBHOOK_SECRET_2` on EmpireVu (web): the second endpoint's `whsec_…`. The plan is to **edit each endpoint's URL in place** in PR 4 (it keeps the secret), so normally you won't need these.

### 1.8 What the logs should show before each shim can go (PR 8)
Run this weekly:
```sql
select kind, key, max(day) as last_seen, sum(count) as uses_30d
  from public.legacy_usage
 where day > current_date - 30
 group by 1, 2
 order by 1, 2;
```
A shim is removed only when its `kind/key` has had no rows for 30 days:

| kind | key | Goes to zero after |
|---|---|---|
| header | x-empirevu-* | the tenant-repo PRs (A1 sites), `job:retell-repoint`, Telnyx re-point |
| twilio_signature | app.empirevu.com / api.empirevu.com / app.crankleads.com | `job:twilio-repoint` + A1's numbers re-pointed by hand (PR 4) |
| twilio_tag | EmpireVu catcher / line | `job:twilio-retag` |
| env | CRANKLEADS_* / STRIPE_*_CL_* / INBOUND_EMAIL_DOMAIN | step 1.5 on **every** service that had the old var. Delete an old var only once no service logs it. |
| route | /api/public/crankleads/* | the marketing site posting to the new path (PR 3); 30 days of old stop links |
| host | app.empirevu.com, app.crankleads.com | redirects are on (PR 2); pages traffic tapers off. **The hosts themselves stay ≥12 months.** |
| host | app.empirevu.com/api, api.empirevu.com | old mobile builds retired, A1 sites and Retell re-pointed. **Stays until the last old build is gone.** |
| payload_key | EmpireVuForwardingTestId | step 1.6 (jobs drain within a day) |
| stripe_metadata | source=crankleads | step 1.6. Live subscriptions still carry the old value until the PR 4 metadata backfill. |

---

## Tenant-repo PRs
- **A1 Marine Care ([a1marinecare#28](https://github.com/marcuslebars/a1marinecare/pull/28)): ✅ merged and deployed 2026-10-13.**
  - Railway (a1-marine-care → a1marinecare):
    - `EVERDOER_INTAKE_URL=https://api.everdoer.com/api/intake`
    - `EVERDOER_INTAKE_SECRET=${{EMPIREVU_INTAKE_SECRET}}`
    - `RETELL_FORWARD_WEBHOOK_URL=https://api.everdoer.com/api/retell/webhook`
  - [ ] **Make one test call** to the A1 number and check the call lands in Everdoer. The Retell forward is the only path phone leads take, and it doesn't retry.
  - [ ] PR 8: delete `EMPIREVU_INTAKE_URL` / `EMPIREVU_INTAKE_SECRET`. Turn the `EVERDOER_INTAKE_SECRET` reference into its literal value first.
- **A1 Marine Storage and boatnames.ca:** no longer maintained (owner, 2026-10-13). Their PRs ([#45](https://github.com/marcuslebars/a1marinestorage/pull/45), [#3](https://github.com/marcuslebars/boatnames.ca/pull/3)) can be closed. The `EVERDOER_INTAKE_*` vars set on their Railway services are harmless; the deployed code doesn't read them.

## PR 2: Everdoer for every customer
After PR 2 deploys, **every org, A1 included, sees the lime Everdoer app.** Customer pages (quotes, invoices, booking, portal, forms) stay company-branded. These stay exactly as today until you flip their switch:
- links
- SMS wording
- the email sender

### 2.1 Before merging
- [x] `EVERDOER_APP_BASE_URL` is unset on every EmpireVu service. (I checked on 2026-10-13. PR 2 also ignores any value not on everdoer.com.)
- [x] `PLATFORM_BRAND_NAME` and `CRANKLEADS_CHECKOUT_*` are unset on every service. (Checked 2026-10-13.)
- [ ] **Run the values audit.** Supabase → SQL editor → `supabase/tests/rebrand_values_audit.sql` (read-only).
  - It lists quote links on app.crankleads.com / app.empirevu.com that will move to app.everdoer.com.
  - It lists tenants named exactly "CrankLeads" or "EmpireVu". Rename those in the app; the migration doesn't.
  - Check any **A1 rows** in the quote-link list. A1's `quotes.a1marine*.ca` never matches, but an A1 company set to `app.empirevu.com` would move. That host serves the same app, so it's harmless.
- [ ] **Run the migration**: `supabase/migrations/20261017100000_rebrand_everdoer_values.sql`.
  - It adds `companies.email_from_address` (service-role only, empty), moves those quote links, and changes the waitlist default and column comments.
  - Check: run the audit again; there should be no "will change" rows.
  - Undo: `supabase/rollback/20261017100000_rebrand_everdoer_values.down.sql` (unset `EVERDOER_DEFAULT_FROM_EMAIL` first).
  - **This must run before 2.4**, or every company email fails once `EVERDOER_DEFAULT_FROM_EMAIL` is set.

### 2.2 Merge and deploy, then watch for 10 minutes
- Logs: no new errors.
- A1's quote and invoice emails still come from the same address.
- The owner dashboard on app.empirevu.com shows Everdoer.
- Accounting sync doesn't re-push old records. Synced memos stay as they are; new ones say "From Everdoer".
- Undo: roll back the deploy. PR 1's shims keep both names working either way.

### 2.3 Move everyone to app.everdoer.com
- [ ] Do this only once 1.3 is done: the Supabase redirect URLs, Google JS origin and Turnstile hostnames include app.everdoer.com.
- [ ] `EVERDOER_APP_BASE_URL=https://app.everdoer.com` on **every** EmpireVu service:
  - EmpireVu (web)
  - EmpireVu worker
  - workflow-events
  - crankleads-sweep
  - billiing-worker
  - billing-reconcile
  - quote-maintenance
  - monthly-scorecard

  Effect: owner and staff links (invites, digests, alerts, billing and Stripe returns) and third-party links (compliance shares and uploads, `/s/` sites, importer, porting) point at app.everdoer.com. A1's customer quote, invoice and portal links don't move.
  Check: `legacy_usage` has no `env / EVERDOER_APP_BASE_URL(invalid-host)` row.
- [ ] Supabase → Authentication → URL configuration → **Site URL** `https://app.everdoer.com`. Keep the old redirect URLs.
- [ ] Then `EVERDOER_REDIRECT_LEGACY_HOSTS=1` on **EmpireVu (web)**. Page views on app.empirevu.com / app.crankleads.com then 301 (not cached) to app.everdoer.com. `/api`, `/embed`, `/f`, `/.well-known` and sign-in callbacks never redirect, and api.empirevu.com never redirects.
  - People sign in once on the new host. The announcement says so.
  - Undo: unset it. The redirect isn't cached, so the undo takes effect immediately.

### 2.4 Email sender (after 1.4: Resend shows everdoer.com verified for SPF, DKIM and DMARC)
- [ ] **Confirm A1 is the house org** in the SQL editor:
  `select slug, plan from organizations where plan = 'internal' or slug = 'a1-group';`
  A1's org must show `plan = internal` or the slug in `LEAD_INTAKE_ORG_SLUG`. House-org companies always keep `OUTBOUND_FROM_EMAIL`.
- [ ] `EVERDOER_DEFAULT_FROM_EMAIL=hello@everdoer.com` on every EmpireVu service (same list as 2.3).
  - Non-A1 companies' mail and platform mail (invites, welcome, scorecard, weekly report) then come from hello@everdoer.com.
  - A1's customer mail stays on its A1 address with the same display name.
  - Check: send an invite (from hello@everdoer.com), and an A1 quote (from the same address as before).
  - Undo: unset it.

### 2.5 SMS wording (A2P compliance first)
- [ ] Twilio Console → Messaging → Regulatory Compliance → your A2P **brand and campaign**: update the brand name and the sample messages to the Everdoer wording:
  - "Everdoer: …" owner texts
  - "Everdoer: this number is for Everdoer account owners…"

  Wait for approval if Twilio requires a re-review.
- [ ] Then `EVERDOER_SMS_BRANDING=1` on every EmpireVu service (same list as 2.3). After that:
  - owner texts for **every** org (A1 included) start "Everdoer: ";
  - the platform number's unknown-sender/HELP reply and the done-for-you setup, reminder, live and forwarding texts say Everdoer.

  Until then, every text is byte-identical to today. Undo: unset it.

### 2.6 Stripe (dashboard; nothing in code)
- [ ] Settings → Branding: business name "Everdoer", icon `public/brand/everdoer/everdoer-icon.svg` (or `icon-512.png`), brand colour `#A6EE2B`, accent `#0C0E12`. This also brands the Billing Portal, which has no per-session branding. Checkout already sends Everdoer branding per session.
- [ ] Optional, once everdoer.com is live (PR 3): `EVERDOER_CANCEL_URL=https://everdoer.com/#pricing` and `EVERDOER_SITE_URL=https://everdoer.com` on web.

### 2.7 Demo account (App Review)
- [ ] **Don't do this while a store review is in progress.** From the Railway web shell:
  1. Dry run: `npm run job:seed-demo -- --email demo@everdoer.com`. It prints the old demo org, row counts and the old login, and changes nothing.
  2. `DEMO_PASSWORD='<password>' npm run job:seed-demo -- --email demo@everdoer.com --apply`. This deletes the old "EmpireVu Demo" org and the `demo@empirevu.com` login, then seeds "Everdoer Demo".
- [ ] Put `demo@everdoer.com` and the password into Play Console → App access and App Store Connect → App Review Information. `mobile/STORE.md` has the notes.
- If the job deletes the org but fails to delete the old login, delete `demo@empirevu.com` by hand in Supabase → Authentication → Users.

### 2.8 What's still EmpireVu or CrankLeads after PR 2 (by design)
- The mobile app in the stores: that's PR 6. The privacy and delete-account pages say "(formerly EmpireVu)" until then.
- crankleads.com and empirevu.com marketing: PR 3.
- Internal code names, log prefixes, `crankleads_*` tables and `platform_brand` values: PR 5 and PR 7.
- Old asset files (`/empirevu-*`, `/brand/crankleads-*`), kept because sent emails link to them.
- Accounting sync hashes use the old product names (`HASH_PRODUCT_NAMES`), so the rename never re-pushes already-synced records into QuickBooks or Xero. They come out in PR 8 with a one-time rehash job: for each synced record whose stored hash still matches, it recomputes the hash with the new name. No record is pushed. Don't remove the constant without that job.

## PR 3: marketing
Three repos, each with a `rebrand/everdoer` PR:
- crankleads-system becomes everdoer.com
- empirevu-site becomes a redirect-only server
- thinker-holdings swaps the Syncoree card for Everdoer

There's also a small platform PR: the kit README is no longer served, plus this checklist.

### 3.1 Before merging the site
- [ ] **Issue an intake key for the site's question form.** Production has never had one (`[boot] EMPIREVU_INTAKE_KEY is not set` in the crankleads-system logs since 2026-10-03), so the form has answered 503. The logs show only one form submit since October 1, a 400 test, so no leads were lost.
  - Platform → Settings → Integrations, signed in to the org that should receive site enquiries (the tenant that gets crankleads.com leads) → create an intake key labelled `everdoer.com site`.
  - Railway → project CrankLeads → crankleads-system: set `EVERDOER_INTAKE_KEY=<the key>`. Leave `EVERDOER_INTAKE_URL` unset; it defaults to `https://api.everdoer.com/api/intake`.
- [ ] **Railway → crankleads-system → Settings → Networking**, add custom domains `everdoer.com` and `www.everdoer.com`. In DNS (everdoer.com zone):
  - apex: `ALIAS`/`ANAME` or a flattened `CNAME` → `‹target›`
  - `CNAME www → ‹target›`
- [ ] **Find out where `www.crankleads.com` points.** Only the apex `crankleads.com` is attached to this Railway service. If `www` still points at an old host (the repo began as a Lovable project), that would explain the old "We Crank Leads" hero you saw. Attach `www.crankleads.com` to crankleads-system too, so it 301s with everything else.
- [ ] **Confirm the platform still allows checkout from everdoer.com.** `EVERDOER_SITE_ORIGINS` and `CRANKLEADS_SITE_ORIGINS` are unset on EmpireVu (web) (checked 2026-10-14), so the built-in default applies, and it already includes `https://everdoer.com` and `https://www.everdoer.com`.

### 3.2 Merge and deploy the site, then verify
- [ ] `https://everdoer.com/version.json` shows the merged commit. `https://crankleads.com/version.json` shows the same commit; if it shows HTML or 404, that host isn't this service.
- [ ] Submit a test question on everdoer.com and check it lands in the platform as a lead.
- [ ] Test the checkout dialog up to the Stripe page. Don't pay.

### 3.3 Turn on the old-domain 301s
- [ ] crankleads-system: `EVERDOER_CANONICAL_ORIGIN=https://everdoer.com`. After that:
  - crankleads.com and www.crankleads.com 301 to everdoer.com, keeping the path and query;
  - www.everdoer.com 301s to the apex;
  - `/brand/crankleads-*` (Stripe Checkout logo), `/api/*`, `/healthz` and `/version.json` are served in place.
  - The 301s are cached for 1 hour during the rollout. Undo: unset the variable.
- [ ] Merge **empirevu-site**. empirevu.com then 301s every GET to everdoer.com, sends 308 for other methods, and answers `410` with the new intake URL for `/api/*`.
  - Railway → EmpireVu Frontend → empirevu-site: optional `EVERDOER_ORIGIN`, default `https://everdoer.com`.
  - Delete `TURNSTILE_SECRET_KEY`, `TURNSTILE_SITE_KEY` and `VITE_TURNSTILE_SITE_KEY` there; the server no longer uses them. Keep `WAITLIST_NOTIFY_EMAIL` only if something else reads it.
- [ ] After a week of clean redirects, **archive the empirevu-site repo** on GitHub (Settings → Archive).

### 3.4 Search and portfolio
- [ ] **Google Search Console:** add the `everdoer.com` domain property and submit `https://everdoer.com/sitemap.xml`. On the old `crankleads.com` property, use **Change of address** → everdoer.com, once the 301s are on.
- [ ] Merge **thinker-holdings**. The card says Everdoer, links to https://everdoer.com and uses a new 16:9 screenshot. **Its description still says "CRM / Operations Software"**: your call (PR note).

### 3.5 Open decisions (owner)
- **CASL mailing address:** a placeholder (`[Mailing address coming soon]`) is on the privacy page (linked from the consent checkbox) and footer. **Replace `MAILING_ADDRESS_PLACEHOLDER` in crankleads-system `src/config.ts` once the business address is secured,** before any commercial email or text goes out from the site's leads.
- **"Live in 5 business days or first month free":** kept. The platform tracks the deadline, but the first-month waiver is applied by hand.

## PR 4: provider re-point
To be filled in. It covers:
- **Order matters:**
  1. First switch `TWILIO_WEBHOOK_BASE_URL` (or `APP_BASE_URL`) to `https://app.everdoer.com`. Calls to numbers still on old hosts keep working, because voice signatures accept the old hosts.
  2. Then run `job:twilio-repoint` (dry run, then `--apply`). `--apply` refuses until that base is on the target host, because provisioning and the porting guards compare number URLs to the base exactly.
  3. Then re-point A1's hand-set numbers.
  4. Then update Messaging Service inbound URLs by hand; the job covers phone numbers only.
- `job:retell-repoint`:
  - **It re-pushes each whole receptionist agent** (prompt, tools, analysis fields) from today's company data, not just the URLs, so any prompt edited by hand in Retell is overwritten. Review the dry run first.
  - `--apply` refuses while `APP_BASE_URL` is still an old host.
  - It skips any company whose live Retell number uses a different agent (such as A1's hand-made Care agent).
  - Set `RETELL_REPOINT_SKIP_COMPANIES=<A1 Marine Care company id>` on the shell you run it from, as a belt-and-braces deny-list.
- **A1 Marine Storage is decommissioned, not re-pointed.** Do the "A1 Marine Storage decommission" section below instead of re-pointing its numbers and agent. Leave Storage's numbers out of the hand re-point step.
- A1's Care agent, by hand
- Telnyx
- Stripe endpoint URLs edited in place
- Stripe lookup keys transferred, metadata backfilled, and product/price display names renamed
- the Intuit/Xero redirect URIs, added alongside the old ones
- Google consent screen

## A1 Marine Storage decommission (owner, 2026-10-14)
Storage is wound down: A1 Marine Care does the shrink wrapping, and the facility is gone. It isn't carried through the rebrand.

### D.1 See what's still live (read-only)
- [ ] Supabase → SQL editor → `supabase/tests/storage_decommission_audit.sql`. It lists every live item for the Storage company (quotes, invoices, recurring series, numbers, keys, Stripe Connect, AI settings, queued jobs and more), plus its activity over the last 30 days.

### D.2 Stop the automations
There is a company flag, `companies.stage` (`prospect | active | paused | archived`), but **no screen can change it**, and **only some systems check it**. Archiving it stops:
- the weekly report and monthly scorecard;
- the AI staff roles: dispatcher, marketer, office manager, compliance, customer care, email clerk, fleet, profit advisor, purchasing, recruiter, tax clerk and service plans.

It does **not** stop workflows, recurring jobs, review requests, quote expiry or follow-ups, invoice reminders, the SMS agent, call answering, Stripe, online booking, the estimator, bookkeeper, importer, porting, the owner digest or lead routing. Do both:
- [ ] **Run `supabase/ops/20261014_a1_marine_storage_decommission.sql`** (rollback: `.down.sql` next to it). It archives the company, turns off its switches, pauses its workflows and recurring series, cancels scheduled review requests and open quotes, and deactivates its numbers, voice profile and keys. Every changed row is backed up first. Then do by hand what it leaves alone: Stripe, invoices, service agreements, booked visits and org-wide workflows. Without the script, the flag alone is:
  `update public.companies set stage = 'archived', updated_at = now() where organization_id = (select id from public.organizations where slug = 'a1-group') and slug = 'a1-marine-storage';`
- [ ] Then turn off each item the audit shows, with the company switcher set to **A1 Marine Storage**:
  - **Automations:** pause every Storage workflow. Org-wide workflows (no company) also fire for Storage; check them.
  - **Recurring jobs:** end each active series.
  - **Quotes:** cancel open quotes. Their expiry reminder has no per-company switch.
  - **Invoices:** void or settle them, or turn reminders off in Settings → Invoices.
  - **Settings → Reviews:** off.
  - **Settings → Online booking:** "Take bookings online" off. The `/book/<id>` link otherwise stays open.
  - **Settings → AI front desk:** turn every role off, plus SMS agent and call answering.
  - **Settings → Notifications:** daily digest off.
  - **Settings → Accounting:** disconnect, if connected.
  - **Settings → Integrations:** deactivate its numbers, and revoke its intake keys and its `evpk_` form keys.
- [ ] **Stripe Connect:** nothing in the app can disconnect it. Close or deactivate the Storage connected account in the Stripe dashboard, or clear `stripe_connected_account_id` in SQL once no payments are pending.
- If you want archiving one company to stop **everything** (and to be a button, not SQL), that's a small platform PR: add `stage` checks to the systems listed above, plus an archive control.

### D.3 Phones and voice (replaces Storage's PR 4 re-point)
- [ ] **Storage's phone number(s), from audit row 20:** either forward them to A1 Marine Care's number (Twilio console → the number → Voice "A call comes in" → forward), or set a short closed-business greeting ("A1 Marine Storage has closed; for shrink wrapping call A1 Marine Care at …"). Then deactivate them in Settings → Integrations, or release them in Twilio once forwarding is no longer needed.
- [ ] **Storage's Retell agent** (audit rows 20 and 22, `provider_agent_id` / `retell_outbound_agent_id`): delete it in Retell, or release its Retell number.
- [x] **Done 2026-10-14:** `RETELL_SOURCE_SITE=a1marinecare` set on EmpireVu (web), EmpireVu worker and workflow-events. **Before that it wasn't set** on EmpireVu (web) or the worker, so the code default `a1marinestorage` applies: **any Retell call that matches no number is filed as an A1 Marine Storage lead** (`retell/config.ts:32`, `retell/tenant.ts:120-125`). Set `RETELL_SOURCE_SITE=a1marinecare` on EmpireVu (web), EmpireVu worker and workflow-events.
- [x] **Done 2026-10-14:** `TELNYX_DEFAULT_TENANT_ID=a1000000-0000-4000-8000-000000000002` (A1 Marine Care) set on EmpireVu (web), EmpireVu worker and workflow-events.

### D.4 Lead routing
- [ ] The platform still maps `sourceSite: "a1marinestorage"` → the Storage company (`lead-intake/routing.ts:13`). The site redirects to a1marinecare.ca and posts nothing (no old-header traffic since 2026-10-13). Remove the mapping in the PR 5 code pass.
- [ ] Revoke Storage's intake keys and public form keys (D.2).

### D.5 ⚠️ The a1marinestorage.ca domain carries A1 Marine Care's mail and quote links
`docs/empirevu-hub-setup.md` documents `OUTBOUND_FROM_EMAIL=quotes@a1marinestorage.ca` and `QUOTE_PUBLIC_BASE_URL=https://quotes.a1marinestorage.ca` as **platform-wide** values. The house org's companies (A1 Marine Care included) send from that address, and its quote links use that host.
- [ ] **Don't let a1marinestorage.ca lapse** until both have moved:
  - Verify an `a1marinecare.ca` sending address in Resend (e.g. `quotes@a1marinecare.ca`), then change `OUTBOUND_FROM_EMAIL` on every EmpireVu service. Do this before the PR 8 sender migration, which then pins that address to A1 Marine Care by UUID.
  - `quotes.a1marinecare.ca` is already attached to the EmpireVu web service. Set A1 Marine Care's `companies.quote_public_base_url` to `https://quotes.a1marinecare.ca` (Settings → Branding, or SQL). Then change `QUOTE_PUBLIC_BASE_URL` to it.
  - **Keep `quotes.a1marinestorage.ca` attached and its DNS alive for at least 12 months**, because links in past quotes, invoices and PDFs point there.

## PR 5: internal renames and dashboards
PR 5 renames code, files, docs and the test harness. **Nothing changes behaviour.**

Old names that keep working for one release, then get removed in PR 8:
- **Routes:** `/api/public/crankleads/*` and `/welcome/crankleads`.
- **npm scripts:** `job:crankleads-provision`, `job:crankleads-repair-automations` and `stripe:setup-crankleads`.
- **Railway config:** `railway.crankleads-sweep.json`.
- **Env names:** every old env name still read as a fallback.

Database names (`crankleads_*`, `platform_brand` values) stay until PR 7.

Wire and stored names were deliberately kept; PR 7/8 decide them:
- **API fields:** `isCrankleads`, `crankleads`, `crankleads_tier`.
- **Help request context:** `crankleadsTier`.
- **Twilio payload:** `EmpireVuForwardingTestId`.
- **Orchestrator reason:** `not_crankleads`.
- **Error name:** `CrankleadsProvisioningFailedError`.
- **Stripe idempotency keys:** `crankleads-checkout-*`.
- **Rate-limit scopes:** `crankleads_*`. Renaming them resets live counters.

### 5.1 After PR 5 is deployed
- [ ] **Railway → Everdoer project → `crankleads-sweep` → Settings → Config-as-code path:** `railway.dfy-sweep.json`. Or set the start command to `npm run job:dfy-provision -- --stuck`.
  - Check that one 15-minute run logs `[dfy-sweep] checked N stuck purchase(s)`.
- [ ] **Log searches and alerts:** the old prefixes are now:
  - `[crankleads/provision|checkout|resend|status|stop-reminders]` → `[dfy/…]`
  - `[crankleads-sweep]` → `[dfy-sweep]`
  - `[crankleads-provision]` → `[dfy-provision]`

  Update any Railway alert or saved search, especially `PROVISIONING FAILED` and `WELCOME EMAIL FAILED`.
- [ ] **`PLATFORM_BRAND_NAME` → `EVERDOER_BRAND_NAME`.** Both are unset today, and nothing needs setting. If you ever set it, use the new name; the old one is still read.

### 5.2 Dashboard renames (any time after 5.1)
- [ ] **Railway service renames, in this order:**
  1. **Repoint references first.** Other services reference the web service by name, e.g. workflow-events has `OWNER_EMAIL=${{EmpireVu.LEAD_NOTIFY_EMAIL}}`. Before renaming the `EmpireVu` service, open each service's Variables tab, search for `${{EmpireVu.` and confirm Railway updated each reference after the rename. Otherwise re-point them by hand.
  2. Rename:
     - `EmpireVu` → `Everdoer web`
     - `crankleads-sweep` → `dfy-sweep`
     - `billiing-worker` → `billing-worker`
  3. Delete:
     - **`EmpireVu worker`:** crash-looping since at least Oct 4 against a Supabase project that no longer exists. `workflow-events` does its job.
     - **`jobber-sync`:** only if it's confirmed dead.
  4. **Railway projects:**
     - `CrankLeads` → `Everdoer site`
     - `EmpireVu Frontend` → `Everdoer redirects` (or delete it once empirevu.com no longer needs to redirect)
- [ ] **GitHub:**
  - `crankleads-system` → `everdoer-site`.
  - Archive `empirevu-site` after a week of clean redirects (3.3).
  - After each rename, check Railway → service → Source still shows the repo, and update local remotes.
- [ ] **Supabase:** project name → `Everdoer`. The project URL and keys don't change.
- [ ] **Resend:** the audience and API-key names. Domains are done in PR 1/2.
- [ ] **Twilio:** the subaccount friendly name and Messaging Service names. Don't touch numbers or A2P campaigns here; those go through PR 4 and the A2P re-registration.
- [ ] **Stripe → Settings → Business:** public business name `Everdoer` and statement descriptor. **Customers see this on card statements and receipts.** Check the A2P and Stripe descriptor rules before changing it. The code's checkout display name already says Everdoer.
- [ ] **Google Cloud project display name; Intuit and Xero app names.** These are display names only; the redirect URIs are PR 4.

### 5.3 Behaviour follow-ups (separate small PRs, not PR 5)
- [ ] `RETELL_SOURCE_SITE` code default `"a1marinestorage"` → `"a1marinecare"` (`retell/config.ts`). Railway already sets `a1marinecare`.
- [ ] Remove `a1marinestorage: "a1-marine-storage"` from `lead-intake/routing.ts`, once the audit shows no Storage traffic (D.4).

## PR 6: new mobile app
To be filled in once you've confirmed the store install counts. It covers:
- `com.everdoer.app` listings and the APNS key/topic
- the final old-app update
- the review notes

## PR 7: database object renames
To be filled in: the migration and rollback that you run.

## PR 8: remove shims
To be filled in, using the table in 1.8. Already decided:
- [ ] **Pin A1's sender in data instead of code.**
  - **Today (PR 2):** `src/server/outbound/company-sender.ts` `isHouseOrgRow` treats an org as the house org when `plan = 'internal'` or its slug equals `LEAD_INTAKE_ORG_SLUG`. The code hard-codes the default for that variable, `a1-group`. House-org companies always send from `OUTBOUND_FROM_EMAIL`.
  - **PR 8:** a migration sets `companies.email_from_address` **by explicit UUID** for A1 Marine Care only, plus A1 Coatings if it still sends mail, using values you confirm from the audit. **There's no row for A1 Marine Storage** (decommissioned). It raises an exception if any listed UUID is missing. A rollback goes with it.
  - **Then** delete the house-org branch from `resolveFromAddress` (and its `a1-group` default), so no company's sender depends on a slug or plan.
