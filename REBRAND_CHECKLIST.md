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
  - There should be no `403` on `/api/twilio/voice/*`. If one shows up, roll back the deploy; that's the only path whose validation logic changed.

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
For each pair, copy the **current value** of the old variable into the new name. Leave the old variable in place until PR 8 so a rollback still works. The app reads the new name first. Do these on **Railway → project EmpireVu → service EmpireVu (web)** unless noted:

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
- Check: in the deploy logs, `[legacy-usage] kind=env key=CRANKLEADS_…` lines stop appearing for every name you've set.
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
| env | CRANKLEADS_* / STRIPE_*_CL_* / INBOUND_EMAIL_DOMAIN | step 1.5 on every service, then delete the old vars |
| route | /api/public/crankleads/* | the marketing site posting to the new path (PR 3); 30 days of old stop links |
| host | app.empirevu.com, app.crankleads.com | redirects are on (PR 2); pages traffic tapers off. **The hosts themselves stay ≥12 months.** |
| host | app.empirevu.com/api, api.empirevu.com | old mobile builds retired, A1 sites and Retell re-pointed. **Stays until the last old build is gone.** |
| payload_key | EmpireVuForwardingTestId | step 1.6 (jobs drain within a day) |
| stripe_metadata | source=crankleads | step 1.6. Live subscriptions still carry the old value until the PR 4 metadata backfill. |

---

## Tenant-repo PRs (after PR 1 is deployed)
To be filled in with those PRs. They cover `EVERDOER_*` env on the a1marinecare, a1marinestorage and boatnames.ca services, the intake URL changing to `https://api.everdoer.com/api/intake`, the `x-everdoer-*` headers, and boatnames' `everdoer_outbox` migration.

## PR 2: Everdoer for every customer
To be filled in. It covers:
- `EVERDOER_APP_BASE_URL=https://app.everdoer.com`, then `EVERDOER_REDIRECT_LEGACY_HOSTS=1`
- the Supabase Site URL
- sender domain cut-over per company (D7)
- A2P campaign sample messages updated before the "Everdoer: " SMS prefix goes live
- the values migration
- the App Review demo login `demo@everdoer.com`

## PR 3: marketing
To be filled in. It covers:
- everdoer.com and www on the crankleads-system service
- the crankleads.com and empirevu.com 301s
- Search Console
- archiving empirevu-site
- the thinker-holdings card

## PR 4: provider re-point
To be filled in. It covers:
- `job:twilio-repoint` (dry run, then `--apply`), plus A1's hand-set numbers
- `job:retell-repoint`. **It re-pushes each whole receptionist agent** (prompt, tools, analysis fields) from today's company data, not just the URLs, so any prompt edited by hand in Retell is overwritten. Review the dry run first.
- A1's Care agent, by hand
- Telnyx
- Stripe endpoint URLs edited in place
- Stripe lookup keys transferred, metadata backfilled, and product/price display names renamed
- the Intuit/Xero redirect URIs, added alongside the old ones
- Google consent screen

## PR 5: internal renames and dashboards
To be filled in. It covers:
- the GitHub repo renames
- Railway projects and services: rename `billiing-worker`, delete jobber-sync
- the Supabase project name
- Resend, the Twilio subaccount and messaging services
- the Stripe account name and branding
- the Google Cloud project
- the Intuit/Xero app names
- logging and monitoring

## PR 6: new mobile app
To be filled in once you've confirmed the store install counts. It covers:
- `com.everdoer.app` listings and the APNS key/topic
- the final old-app update
- the review notes

## PR 7: database object renames
To be filled in: the migration and rollback that you run.

## PR 8: remove shims
To be filled in, using the table in 1.8.
