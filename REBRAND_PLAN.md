# EmpireVu + CrankLeads → Everdoer: rebrand plan (Phase 1: audit only)

**Status:** waiting for your approval. Nothing has been changed in any repo, Railway, DNS or provider. This replaces the earlier CrankLeads-only plan.

**Audited** (read-only):

| Repo | Ref | What it is |
|---|---|---|
| `marcuslebars/EmpireVu` | `aaaf7e8`, main with Phases 1–5 | the platform |
| `marcuslebars/crankleads-system` | `accdfcf` | crankleads.com |
| `marcuslebars/empirevu-site` | `3119a5b` | empirevu.com waitlist page |
| `marcuslebars/thinker-holdings` | `1a124a3` | portfolio |
| `a1marinecare`, `a1marinestorage`, `boatnames.ca` | | tenant sites that call our API |

Also read: live Railway service and domain lists and env var *names* (values not read).

Not audited (no reason to think they reference either name; tell me if they do): the other ~45 repos on the account. Supabase, Twilio, Stripe, Retell, Intuit/Xero and Google consoles can't be read from here. They're covered by checks in REBRAND_CHECKLIST.md.

Risk: **L** copy/asset only · **M** touches a flow or many tests · **H** can break something live if done wrong · **C** critical (calls, payments, tenant integrations, mobile).

---

## 0. Summary, and the decisions I need from you

### What's out there today

| | EmpireVu | CrankLeads |
|---|---|---|
| Marketing site | empirevu.com: early-access waitlist, blue/violet brand, Bricolage + Inter | crankleads.com: sales site, lime/near-black, Inter |
| App host(s) | app.empirevu.com, api.empirevu.com (same Railway service) | app.crankleads.com (same service) |
| Who sees it | house tenants (A1 Marine Care, A1 Marine Storage, Blair's, …) and the mobile app | orgs that bought CrankLeads (`platform_brand='crankleads'`) |
| App theme | blue `#1a7aff`-ish / violet (`index.css:9-35`) | lime `#A6EE2B` on `#0C0E12` (`index.css:70`) |
| Mobile app | "EmpireVu", bundle `com.empirevu.app` | — |
| Also | "Syncoree" card in thinker-holdings (the same platform under a third name) | — |

### The core risk
Our domains are baked into things we don't control:
- shipped mobile builds (`app.empirevu.com/api/*`)
- Twilio numbers, whose **voice** signatures are checked against one configured base URL
- Retell agents
- tenant websites, which post to `api.empirevu.com/api/intake` with `x-empirevu-*` headers, and Retell forwards hard-coded to api.empirevu.com
- embedded lead-form scripts (`/embed/v1.js`)
- every link already sent in email, SMS and PDFs

So the plan is:
1. **Every old host keeps serving everything for ≥12 months.**
2. **Page views** on old app hosts get a 301. **Anything a machine calls** (`/api/*`, `/embed/*`, `/f/*` iframes) never redirects. A 301/302 turns a POST into a GET, and the A1 sites' signed POSTs and the mobile app would break.
3. Every wire contract (headers, storage keys, Stripe metadata, Twilio tags, DB keys) **accepts old and new names** before anything starts writing the new one.

### A warning from history
`docs/crankleads-branding.md:8` records that a full rename was tried in **PR #127 and reverted**. The policy since then has been "per-account switch, not a rename", with contracts kept as EmpireVu. This brief overrides that policy, so I've split the work into stacked PRs, each safe to deploy on its own (§8).

### Decisions (my recommendation first)

| # | Decision | Recommendation |
|---|---|---|
| D1 | New hosts | `everdoer.com` (+ www) for marketing; `app.everdoer.com` for the app; `api.everdoer.com` as an alias of the same service for integrations and docs. `in.everdoer.com` for the email inbox; `pages.everdoer.com` only if you want short site URLs (not live today). |
| D2 | One marketing site | everdoer.com = today's **crankleads.com** site (the live offer), rebranded. empirevu.com and crankleads.com both 301 to everdoer.com. The empirevu.com waitlist page retires; its form endpoint keeps answering. |
| D3 | App theme | One Everdoer theme for **every** tenant: lime on near-black, Inter. That changes the app's look for house tenants' staff (A1 etc. see lime, not blue). It is platform branding, so it's allowed by your rules, but it's visible to them. |
| D4 | Internal brand key | `organizations.platform_brand` today means "which product line": `'empirevu'` = standard, `'crankleads'` = done-for-you (turns on the AI staff defaults). After the rebrand both *display* Everdoer, but the behaviour split stays. Rename the **values** to neutral names in Phase 3, `'empirevu'` → `'standard'` and `'crankleads'` → `'done_for_you'`, with a dual-read shim first. The column name itself has no old name. |
| D5 | Mobile app | Keep bundle id `com.empirevu.app` and the `com.empirevu.app://` scheme forever (changing them publishes a *new* app; installs, push tokens and keychain sessions are lost). Rename only the display name, strings, icons and store listing. |
| D6 | Wire headers | Add `x-everdoer-key`, `-signature`, `-retell-secret`, `-telnyx-secret`. Accept both forever. Docs and snippets show the new ones. |
| D7 | Email senders | Today *all* mail (A1's customer mail and platform mail alike) goes from one `OUTBOUND_FROM_EMAIL`. Docs say `quotes@a1marinestorage.ca`, an **A1 domain**. Add a per-company sender (`companies.email_from_address`, null = platform default `hello@everdoer.com`). A migration pins A1 companies to their current A1 addresses, so A1 customer mail is byte-identical and everyone else moves to @everdoer.com once the domain is verified. |
| D8 | Tenant repos | Don't edit A1 or boatnames repos (tenant-owned). Their env and URLs keep working because old hosts and headers keep working. The checklist lists optional env updates. |
| D9 | thinker-holdings | Rename the "Syncoree" portfolio card to Everdoer (name, screenshot, link everdoer.com). |
| D10 | Legal entity | "Thinker Holdings Inc." appears nowhere today. Add "Everdoer is a product of Thinker Holdings Inc." to the privacy/delete pages and the site footer? |
| D11 | Brand kit | `Everdoer-brand-kit-fully-rounded.zip` isn't in this session. Please attach it before Phase 2. |

---

## 1. Customer- and tenant-facing

### 1.1 One switch flips most of the app (L)
`src/lib/platform-brand.ts` holds both brand configs (`:54-66` EmpireVu, `:68-81` CrankLeads): name, logo, mark, favicon, PNG icons, support email and theme.

**Change:** both configs render as Everdoer (name "Everdoer", the kit's assets, `hello@everdoer.com`, theme `#0C0E12`/`#A6EE2B`), and `brandForHost` learns `everdoer.com`, `*.everdoer.com` and `*.everdoer.localhost`.

That alone renames ~45 UI spots, 21 help-article lines and ~10 email/SMS templates that read `brand.name` / `{{product}}` / `<ProductName/>`:
- sidebar, auth pages, `document.title`;
- "Get started with …", "Welcome to …", "Set up …", "Finish setting up …";
- "Captured by …", "Revenue attributed to …";
- "Your … number", the Help panel, the help assistant;
- invites, scorecard/weekly footers, workflow alerts, voicemail alerts, DFY intake SMS/email;
- accounting memos written into QuickBooks/Xero ("From Everdoer").

Already-synced memos stay as they are in tenants' books.

### 1.2 Hard-coded strings (L unless noted)

| Where | Today | Change |
|---|---|---|
| `index.html:6-35` (crawlers and pre-React) | `<title>EmpireVu</title>`, description/author/og "EmpireVu", EmpireVu favicons; inline script rewrites EmpireVu→CrankLeads on crankleads hosts | Everdoer title/description/OG (+ og:image), Everdoer favicons, manifest, `theme-color #0C0E12`. The inline script goes, since there's one brand now |
| `PrivacyPolicyPage.tsx` (10 lines + `hello@empirevu.com`), `DeleteAccountPage.tsx` (5) | EmpireVu | Everdoer, `hello@everdoer.com`, D10 entity line. These URLs are in the app-store listings, so they stay at the same paths on every host |
| `OnboardingWizard.tsx:364` website-form snippet | `POST https://api.empirevu.com/api/intake` + `x-empirevu-*` | `https://api.everdoer.com/api/intake` + `x-everdoer-*` (old keeps working, D6) **M** |
| `IntegrationsSettings.tsx:139-140` | `x-empirevu-key/-signature` | `x-everdoer-*` **M** |
| `WeeklyReportSettingsSection.tsx:81` | "Texts are part of CrankLeads plans." (shown to non-CrankLeads orgs) | "…Everdoer plans." |
| `CrankleadsWelcomePage.tsx`, `ForwardPage.tsx`, `crankleads-purchase-api.ts:10,12` | CrankLeads logo/alt/name | Everdoer |
| `crankleads/config.ts:23` `CRANKLEADS_OFFER_NAME` (welcome, reminders, "you're live", forwarding, stop page, operator mails) | "CrankLeads" | "Everdoer" |
| `content/help/articles.ts:18,31,201` | "If you bought through CrankLeads" | "…through Everdoer" (keep old search keywords) |
| `dfy/site-render.ts:583` | "Site by CrankLeads" on generated `/s/<slug>` sites (end customers see it) | "Site by Everdoer" → everdoer.com (your "Powered by Everdoer" rule) |
| `office-manager/briefing.ts:94` | fromName "CrankLeads" | `brand.name` |
| `monthly-scorecard/platform-brand.ts:12` `DEFAULT_PLATFORM_BRAND_NAME` (+ env `PLATFORM_BRAND_NAME`) | "EmpireVu" | "Everdoer" |
| `accounting/mapping.ts:103`, `help-assistant.ts:41,73` defaults | "EmpireVu" | "Everdoer" |
| `lead-intake/test-lead.ts:22` (shows in the owner's CRM) | `test.lead+onboarding@empirevu.com` | `…@everdoer.com` |
| `ReportsAttributionPage.tsx:158` | `empirevu-attribution-<date>.csv` | `everdoer-attribution-…` |
| `AppDiagnosticsPage.tsx:213` | "No empirevu localStorage keys" | follows the storage-key change (§6) |
| `help/account-context.ts:34-36` | "CrankLeads Catch/Close/Front Desk" | "Everdoer Catch/Close/Front Desk" |
| `staff/dispatcher/environment-canada.ts:34` | UA `CrankLeads-Dispatcher/1.0` | `Everdoer-Dispatcher/1.0` |
| `seed-demo-org.ts` (App Review demo account) | "EmpireVu Demo", `demo@empirevu.com` | display name "Everdoer Demo". **Keep** the slug and the UUID salt `empirevu-demo-seed:` (changing it duplicates demo rows on reseed). Add `demo@everdoer.com` and update the App Review login **M** |
| Concierge / operator-health / waitlist notify / support escalation (operator-only) | "CrankLeads setups", "EmpireVu waitlist…", "[EmpireVu Help]" | Everdoer |

### 1.3 SMS (M)
- **Owner texts.** `owner-channel/common.ts:180` adds the prefix `"CrankLeads: "` only for CrankLeads orgs. **Proposal:** `"Everdoer: "` for every org whose owner texts come from the platform number.
  - House orgs get no prefix today. Adding one to A1's owner texts is a visible change. Your call, D3-adjacent: I'd prefix for everyone, so owners know who's texting.
  - The 07:00 briefing budget isn't affected (the prefix is 10 chars, shorter than before).
- **Platform-number replies.** `twilio/inbound-sms.ts:206` sends "CrankLeads: this number is for CrankLeads account owners…" to unknown senders → "Everdoer: this number is for Everdoer account owners…".
  - STOP/START are Twilio-managed; HELP only gets the prefix.
  - Check the console for custom Advanced Opt-Out text.
- Tenant-facing SMS to *end customers* never names the platform (verified). Customer-facing texts carry the company's name.

### 1.4 AI agents (H if missed)
- **Callers.** No caller hears "EmpireVu" or "CrankLeads": Retell variables carry company data only, and the receptionist is "Marina", which stays.
- **Platform-name filters.** These stop AI text from naming the platform. Add `everdoer` to each, keeping the old names:
  - `sms-agent/guard.ts:11`
  - `email-clerk/parse.ts:136`
  - `marketer/ai.ts:157`
  - `estimator/estimate.ts:31`
  - `purchasing/ai.ts:78`
  - `recruiter/ai.ts:121`
  - `voice/post-call.ts:125`

  Also the copies in `scripts/sms-agent-eval/run.ts:208`, `scripts/e2e-dfy/staff.ts:709`, and the tests `platform-brand.test.ts`, `quote-branding.test.ts:15`.

### 1.5 End-customer surfaces (quotes, invoices, PDFs, portal, booking, review, forms)
- All are company-branded, with **no platform name and no "Powered by"** (verified, including invoice PDF metadata). No copy change.
- **The host changes** (§3).

### 1.6 Mobile app (M, separate store release)
Display name "Everdoer":
- `capacitor.config.ts:9` `appName`
- `strings.xml:3-4`
- `Info.plist:10` plus 6 permission prompts ("Everdoer uses the camera…")
- `mobile/index.html:9`

19 in-app strings (`App.tsx`, `biometrics.ts`, `session.tsx`, `push.ts` channel name, auth screens, `More`, `Notifications`, `Appearance`, `Members` share text, `Settings`, `BiometricOffer`).

Other changes:
- Icons and splash regenerated from the kit (~60 generated PNGs via `@capacitor/assets`).
- `mobile/STORE.md` listing copy.

Keep: bundle id, URL scheme, Java package path, APNS topic (D5).

### 1.7 Marketing sites
- **crankleads.com → everdoer.com** (L), 13 strings:
  - `index.html` title, author, og:title
  - `Navbar` alt and aria
  - `Footer` ©
  - `Faq`
  - `LeadForm` (the **CASL consent** text must name Everdoer)
  - `Proof`
  - `Privacy` ×2 (+ "Last updated")
  - `config.ts` name and email

  Plus assets (§2), the canonical, og:image, a new sitemap and robots `Sitemap:` line.
- **empirevu.com** (L): 8 strings, 3 aria-labels, 3 inline base64 logos, waitlist copy, "© 2026 EmpireVu".
  - With D2 the site is replaced by a 301 to everdoer.com. If you'd rather keep it as a page, I'd rebrand it, and it would also need the lime/Inter look (it's blue/violet + Bricolage today).

### 1.8 Help docs and legal
- `src/content/help` is covered by 1.1/1.2.
- Legal: §1.2 and D10.

---

## 2. Things outside our servers that point at our domains (H/C)
For each item: how to keep the old domain working.

| External thing | Calls / stores | How it depends on our host | Keep-alive plan | Risk |
|---|---|---|---|---|
| **Mobile app** (shipped builds) | `https://app.empirevu.com/api/*` compiled in (`VITE_API_BASE_URL`) | none in auth; but redirects break native fetch/CORS | app.empirevu.com serves `/api/*` **with no redirect** until every old build is retired (keep ≥12 months, and enforce a minimum app version later). New builds use `app.everdoer.com` | **C** |
| **Tenant website: lead-form embed** | `<script src="https://app.empirevu.com\|app.crankleads.com/embed/v1.js">`, then an iframe `/f/<evpk_…>`, then `POST /api/public/forms/<key>` | the script uses its own host for everything; same-origin check accepts the arriving Host | `/embed/*`, `/f/*`, `/api/public/forms/*` **never redirect** on old hosts. Add new hosts to the Turnstile widget. Settings shows the new snippet; old snippets keep working | **H** |
| **Tenant sites → `/api/intake`** (a1marinecare, a1marinestorage; boatnames gated off) | `EMPIREVU_INTAKE_URL` (env, likely api.empirevu.com), header `x-empirevu-signature`, body HMAC | none (body HMAC) | api.empirevu.com keeps serving; accept old **and** new header names forever. a1marinestorage treats an HTML 200 as failure and boatnames treats any 2xx as success, so **no catch-all or redirect on intake paths** | **C** (A1 leads) |
| **a1marinecare Retell forward** | `https://api.empirevu.com/api/retell/webhook` hard-coded fallback (`src/lib/retell/webhook.ts:20`) | body signature | api.empirevu.com keeps serving | **H** |
| **Twilio numbers: voice** (catcher, ported business lines, A1) | VoiceUrl `{TWILIO_WEBHOOK_BASE_URL→APP_BASE_URL}/api/twilio/voice/*` | **signature is computed over the full URL and checked against ONE base** (`voice-config.ts:38-42`). Change `APP_BASE_URL` alone and every call returns 403 | (1) Code: check voice signatures against a candidate list (configured base + every legacy host + the arriving host), as SMS already does. (2) Keep `TWILIO_WEBHOOK_BASE_URL` pinned to today's value until numbers are re-pointed. (3) New `job:twilio-repoint --dry-run/--apply` re-points our provisioned numbers. A1's hand-set numbers are re-pointed by hand (checklist) | **C** |
| **Twilio numbers: SMS** (tenants, A1, platform) | `/api/twilio/sms/inbound` on app./api. | already validates on any host (candidate list) | old hosts keep serving; re-point at leisure | M |
| **Stripe webhooks** (platform, Connect) | `app.empirevu.com/api/webhooks/stripe[/connect]` | body-signed, **one secret per route** | **Edit each endpoint's URL in place** in Stripe (keeps the secret). Never add a second endpoint unless the code accepts two secrets (I'll add `STRIPE_WEBHOOK_SECRET_2` support anyway). Old host keeps answering | **H** |
| Stripe Checkout / portal / Connect return URLs | built per session from the base env | sessions expire | in-flight sessions land on old hosts → page 301 | L |
| Stripe Checkout logo | `https://crankleads.com/brand/crankleads-logo.png` | must stay hosted | keep the old file on the site; point the env at the new asset | L |
| **Retell agents** (every provisioned receptionist and the shared message agent) | `${APP_BASE_URL}/api/retell/{webhook,inbound,functions/*}` + header `x-empirevu-retell-secret`, frozen in each agent | body signature + header | old hosts keep serving; accept both header names; new `job:retell-repoint` (bulk wrapper around the existing per-company `resyncReceptionistForContext` + `job:retell-message-agent --apply`). A1's Care agent is re-pointed by hand. `retell/health.ts` `pointsHere` shows what's left | **H** |
| **Telnyx** | `{host}/api/telnyx/*` + `x-empirevu-telnyx-secret` | header secret | old host serves; accept both header names | M |
| **QuickBooks / Xero OAuth** | redirect URI `{ACCOUNTING_REDIRECT_BASE_URL→APP_BASE_URL→https://app.empirevu.com}/api/accounting/callback/{p}` (`accounting/config.ts:83`) | must match exactly | Register the new URI **alongside** the old one in both developer portals, then switch `ACCOUNTING_REDIRECT_BASE_URL`. Tokens are unaffected. Renaming the app in Intuit's portal may trigger production re-review (checklist) | M |
| **Google sign-in / Supabase auth** | `{origin}/oauth/callback`, `/update-password`; Site URL | allowlist | Add every new host to Supabase Redirect URLs and Google JS origins *before* the switch; keep the old ones. Rename the consent-screen app name | M |
| **Resend inbound email** (Phase 5) | not live: `INBOUND_EMAIL_DOMAIN` is unset in Railway | — | Launch directly on `in.everdoer.com`. Code also gets multi-domain matching, so a later change can't orphan forwards | L |
| **Generated sites (pages host)** | `PAGES_BASE_URL` is unset today, so sites are `{app}/s/<slug>` | — | `/s/*` 301s to app.everdoer.com (sites are page views). Middleware gains a legacy-hosts list in case a pages host is ever added | L |
| **Links already sent** (quotes `/q`, invoices `/i` + PDF "Pay online", portal `/p`, visits `/v`, booking `/book`, reviews `/r`, invites, setup/forward/port/import/compliance, stop links, `/welcome/crankleads`, the invoice open-pixel `/api/public/invoices/<t>/open`) | old hosts, forever in inboxes and PDFs | — | Page paths 301 to the same path on app.everdoer.com; `/api/*` paths answer on both. A1's `quotes.a1marine*.ca` tenant domains are untouched | **H** |
| **App Store / Play listings** | privacy, delete-account, support URL, `hello@empirevu.com`, demo login | — | paths unchanged on every host; update the listings in the store consoles | M |
| empirevu.com waitlist form | `POST app.empirevu.com/api/waitlist`, CORS `empirevu.com` | — | endpoint keeps answering; add everdoer origins (`WAITLIST_ALLOWED_ORIGINS`) | L |
| crankleads.com purchase form | `POST app.empirevu.com/api/public/crankleads/checkout` cross-origin (CORS `CRANKLEADS_SITE_ORIGINS`) | origin allowlist | add everdoer.com origins; new alias path `/api/public/everdoer/checkout`; old path stays | **H** (sales) |

---

## 3. Domains and URLs

### 3.1 Host plan (H)

| Host | Today | After |
|---|---|---|
| everdoer.com, www | — | marketing site (today's crankleads.com service) |
| crankleads.com, www | marketing site | **301** → everdoer.com, same path + query (site server) |
| empirevu.com, www | waitlist site | **301** → everdoer.com (retire the empirevu-site service, or make it a redirect-only server) |
| app.everdoer.com | — | the app (same EmpireVu service) |
| api.everdoer.com | — | alias of the same service (integrations, docs) |
| app.empirevu.com, app.crankleads.com | app | **page GETs → 301** to app.everdoer.com; `/api/*`, `/embed/*`, `/f/*` answer in place |
| api.empirevu.com | API alias | **no redirects at all**; serves everything as today |
| quotes.a1marinecare.ca, quotes.a1marinestorage.ca | tenant | untouched |
| in.everdoer.com | — | email inbox MX (D1) |

**Mechanism.** `src/middleware.ts` gains a `LEGACY_APP_HOSTS` 301 rule. It only switches on when `EVERDOER_APP_BASE_URL` is set, so merging can't redirect anyone early. Supabase sessions are per-origin, so people sign in once on the new host; the announcement says so.

### 3.2 Base-URL env vars: new name first, old as fallback for one release (H)
- `EVERDOER_APP_BASE_URL` ← `CRANKLEADS_APP_BASE_URL`, then `APP_BASE_URL`. Both brands end up on one host.
- `QUOTE_PUBLIC_BASE_URL_EVERDOER` ← `QUOTE_PUBLIC_BASE_URL_CRANKLEADS`.
- `EVERDOER_SITE_ORIGINS` ← `CRANKLEADS_SITE_ORIGINS`. The default includes everdoer.com, www and both crankleads origins.
- `EVERDOER_CANCEL_URL`, `EVERDOER_CHECKOUT_{DISPLAY_NAME,LOGO_URL,BACKGROUND_COLOR,BUTTON_COLOR}` ← `CRANKLEADS_*`.
- `APP_BASE_URL`, `TWILIO_WEBHOOK_BASE_URL` and `TWILIO_INBOUND_SMS_URL` stay where they are until the provider re-point steps are done (checklist order).

### 3.3 Hard-coded hosts in code (L–M)
- **EmpireVu repo:**
  - `accounting/config.ts:83` fallback, `OnboardingWizard.tsx:364`, `waitlist/route.ts:23` origins
  - `crankleads/config.ts:96,97,136`, `dfy/site-public.ts:20`
  - `platform-brand.ts:65,79,139-149`, `index.html:16-35`
  - `mobile/.env.example:6`, `scripts/dev/sign-intake.mjs:33`
- **crankleads-system:**
  - `index.html:9,18`, `src/config.ts:13,26`
  - `server/index.mjs:108,214`, `Privacy.tsx:14`
  - `.env.example`, README, tests
- **empirevu-site:** `index.html:363,393,657,659,665,693`.

### 3.4 Other URL work (L–M)
- **SEO:**
  - No sitemap exists anywhere.
  - Add `sitemap.xml` and a robots `Sitemap:` line on everdoer.com, plus canonical tags.
  - The app's `robots.txt` stays domain-free.
- **CORS:**
  - Only the checkout endpoint (`CRANKLEADS_SITE_ORIGINS`) and the waitlist endpoint are brand-sensitive.
  - App CORS is mobile-only and form origins are tenant-owned, so neither needs changes.
- **Auth redirects:** built from `window.location.origin`, so only the dashboard allowlists need updating (§2).
- **Stripe URLs:** generated per session from base URLs, so they follow the env. `/welcome/crankleads` gets an `/welcome/everdoer` twin; the old route stays forever.
- **Unsubscribe links:** the only one is the setup-reminder stop link. It moves to `/api/public/everdoer/setup-reminders` and the old path stays.
- **Tenant subdomains:** none exist (no per-tenant subdomain scheme). The `*.crankleads.com` wildcard in `brandForHost` is unused.

---

## 4. Email: every address and sending domain

| Address / var | Today | → Everdoer | Notes |
|---|---|---|---|
| `hello@empirevu.com` (privacy, delete, store listing, empirevu-site, `platform-brand.ts:65`) | | `hello@everdoer.com` | keep the old mailbox forwarding ≥12 months |
| `hello@crankleads.com` (site, `platform-brand.ts:79`) | | `hello@everdoer.com` | same |
| `demo@empirevu.com` (App Review login) | | `demo@everdoer.com` | update App Store Connect / Play review notes |
| `test.lead+onboarding@empirevu.com` | | `test.lead+onboarding@everdoer.com` | cosmetic |
| `OUTBOUND_FROM_EMAIL` (global sender; docs: `quotes@a1marinestorage.ca`) | used for **every** tenant | per-company sender (D7): A1 companies pinned to their A1 address; platform default `hello@everdoer.com` (or `notifications@everdoer.com` if you prefer a no-reply) | only after everdoer.com passes SPF/DKIM/DMARC in Resend |
| `OUTBOUND_REPLY_TO`, `LEAD_FROM_EMAIL`, `LEAD_NOTIFY_EMAIL`, `OWNER_EMAIL`, `WAITLIST_NOTIFY_EMAIL` | env | map 1:1 when the value is @empirevu.com / @crankleads.com; leave A1 values | I can't read values; the checklist has the exact compare-and-replace |
| `leads@a1marinecare.ca` fallback (`lead-intake/notify.ts:93`) | | **leave** (tenant) | |
| `brand_reply_email`, `brand_from_name` (tenant columns) | | **leave** | |
| Supabase auth emails | dashboard SMTP | set the sender to `@everdoer.com` once verified | |
| Display names | "EmpireVu", "CrankLeads", "CrankLeads ops", "EmpireVu Help", the waitlist fromName | "Everdoer", "Everdoer ops", "Everdoer Help" | |

**Sending domains documented today:**
- `a1marinecare.ca` and `a1marinestorage.ca`: tenant domains, untouched.
- **No empirevu.com or crankleads.com sending domain is documented.**
- `in.crankleads.com` (receiving) is in the docs but **not set live**.

---

## 5. Database

### 5.1 Values (Phase 2 migration, L–M; you run it)
`supabase/migrations/20261015100000_rebrand_everdoer_values.sql` + rollback (restores from a backup table the migration fills):
- Org/company named "CrankLeads" (the tenant receiving crankleads.com leads) → "Everdoer".
- `companies.quote_public_base_url` values containing `app.crankleads.com` or `app.empirevu.com` → `app.everdoer.com` (A1 `quotes.*` untouched; non-A1 only).
- Defaults: `waitlist.source` `'empirevu.com'` → `'everdoer.com'` (existing rows keep their value); column comments.
- New `companies.email_from_address` (D7), set for A1 companies to their current sender.
- `rebrand_audit.sql` (read-only SELECTs you run first) shows exactly which rows each step touches.

### 5.2 Persisted values with dual-read shims (Phase 2 code, no DB change)

| Value | Shim |
|---|---|
| `organizations.platform_brand` `'empirevu'`/`'crankleads'` (CHECK constraint; 66 literal comparisons, 9 sweep `.eq()` filters) | `normalizeProductLine()` reads old and new values; all comparisons go through it. Values renamed in Phase 3 (D4) |
| `company_sites.content.facts.brand`, `onboarding_steps.data.source` | normalised on read |
| Stripe `metadata.source:"crankleads"` on every live subscription and invoice | read the set `{crankleads, everdoer}`; write `everdoer` after deploy |
| Twilio FriendlyName `"EmpireVu catcher <id>"` / `"EmpireVu line <id>"` (exact-match idempotency + porting guards) | recognise both prefixes; write `"Everdoer catcher"`; optional retag job |
| `inbound_webhook_jobs.payload.EmpireVuForwardingTestId` | read and strip both keys |
| Web storage `empirevu_org_id`, `empirevu_company_id`, `empirevu_post_auth_path`, legacy `empirevu.active*` | read new key → old key, migrate on read, clear both on sign-out |
| Mobile Preferences `empirevu.*` (incl. **`empirevu.photoQueue`**, the offline photo queue) | one-time copy on app start, or keep the keys (recommended for photoQueue) |
| Rate-limit scopes `crankleads_*`, checkout idempotency keys | rename freely (transient) |
| Demo seed UUID salt `empirevu-demo-seed:` | **keep** |

### 5.3 Database objects with old names (Phase 3, separate PR after Phase 2 is stable)
Only six migrations created real objects.
- **Not present:** schemas (only `public`/`storage`), views, SQL functions, enums, roles, publications, bucket names, PostgREST config. PostgREST runs `db-schemas=public` with standard roles.

| Object | Phase 3 approach | Risk |
|---|---|---|
| Table `crankleads_purchases` (+ 4 indexes, trigger, auto-named CHECKs; 146 code refs) | `ALTER TABLE … RENAME TO everdoer_purchases`, plus a `security_invoker` view `crankleads_purchases` (auto-updatable, same grants) for one release; code switches to the new name | M |
| Table `crankleads_setup_followups` (+ RLS policy `crankleads_setup_followups_members_select`, 2 indexes, trigger) | rename table to `everdoer_setup_followups`, rename policy/indexes/trigger; compat view | M |
| Column `organizations.crankleads_tier` (+ CHECK `organizations_crankleads_tier_check`; returned in billing API JSON) | rename to `plan_tier`. Tables can't alias a column, so either add a generated column `crankleads_tier` for one release, or switch code in the same deploy (simpler: column rename + code + regenerated types in one release, since all writes are server-side) | **H** |
| `platform_brand` values + `organizations_platform_brand_check` | widen CHECK to accept old + new → backfill → (later) narrow; default `'standard'` | **H** |
| Defaults/comments mentioning empirevu.com / crankleads | new migration | L |
| `database.types.ts` | regenerate (CI drift check) | L |

Never edit applied migrations; rollbacks for Phase 3 are new files. The full local Postgres/PostgREST E2E suite plus the multi-tenant isolation SQL tests run against the migrated DB.

---

## 6. Internal code

| Group | Proposal | Risk |
|---|---|---|
| GitHub repos: `EmpireVu` → `everdoer`, `crankleads-system` → `everdoer-site`, `empirevu-site` → archive | rename in GitHub (old URLs redirect); re-check Railway's GitHub source connection; update local remotes (checklist) | M |
| Packages: `empirevu` → `everdoer`, `empirevu-mobile` → `everdoer-mobile`, site `crankleads` → `everdoer-site` (+ lockfiles) | rename | L |
| Directories: `src/server/services/crankleads/` (11 files), `src/app/api/public/crankleads/` (4 routes: **keep the paths as aliases**), `crankleads-purchase-api.ts`, `CrankleadsWelcomePage.tsx`, `jobs/crankleads-*.ts`, `scripts/stripe/setup-crankleads.mjs`, test files | move to `everdoer` / `done-for-you` names; route paths keep old aliases | M |
| Identifiers: `CrankleadsTier` (53), `CrankleadsPurchase` (45), `isCrankleads*` (~70), `createCrankleadsCheckout`, `getAllEmpireVuStorageKeys`, `crankleads:` settings fields across 16 staff roles, CSS `data-brand="crankleads"`, `data-testid` | mechanical rename to `DoneForYou…` / `Everdoer…`; no behaviour change | M (size: ~2,600 lines incl. tests) |
| Env vars: `CRANKLEADS_*` (8 runtime), `EMPIREVU_INTAKE_KEY` (dev script), `PLATFORM_BRAND_NAME` | `EVERDOER_*` read first, old fallback for one release (§3.2); `STRIPE_PRICE_CL_*` / `STRIPE_SETUP_FEE_CL_*` / `STRIPE_COUPON_CL_FOUNDING` → `STRIPE_PRICE_DFY_*` etc. with fallback | M |
| npm scripts `job:crankleads-provision`, `job:crankleads-repair-automations`, `stripe:setup-crankleads`; `railway.crankleads-sweep.json` | rename, **keeping the old script names as aliases for one release** (the Railway cron's `startCommand` and config path change in the dashboard; checklist) | **H** if done out of order |
| Railway: project "EmpireVu" (services: EmpireVu, EmpireVu worker, workflow-events, crankleads-sweep, billiing-worker [sic], billing-reconcile, quote-maintenance, monthly-scorecard, jobber-sync [dead]); project "CrankLeads" (service `crankleads-system`); project "EmpireVu Frontend" | rename in the dashboard (checklist): "Everdoer", "Everdoer worker", "dfy-sweep", "everdoer-site"; fix "billiing-worker"; delete jobber-sync | L |
| Logging: `[crankleads/provision]`, `[crankleads-sweep]`, etc.; UA strings | rename | L |
| Stripe catalog ids `crankleads_<tier>`, lookup keys, coupon ids | **keep** (live objects; renaming makes new products). Display names change in Stripe | — |
| Mobile bundle id, Java package dir, URL scheme, APNS topic | **keep** (D5) | C if changed |
| CI: `.github/workflows/mobile.yml` (build header, provisioning profile key name), `ci.yml` | rename labels; keep the profile key value | L |
| e2e harness: DB names `empirevu_e2e`/`empirevu_sqltest`, host `app.crankleads.localhost` checks in 6 scripts, `@crankleads.test` fixtures | `everdoer_e2e`, `app.everdoer.localhost` + a test that old hosts still answer `/api/*` and 301 pages | L |
| Docs: ~430 lines across 30 docs; `EMPIREVU_RUNBOOK.md` (filename referenced 40×), `EMPIREVU_AUDIT.md`, `empirevu-hub-setup.md`, `crankleads-*.md`, `NEXT_LEVEL_PLAN.md` (14), README | rename files + prose; leave a one-line redirect note in the old filenames for one release | L |
| `CLAUDE.md` / agent instructions | **none tracked** in any audited repo | — |
| Tenant repos (a1marinecare `src/lib/empirevu.ts`, a1marinestorage `server/empirevu.ts`, boatnames `empirevu_outbox` table) | **out of scope** (tenant-owned, D8). They keep working unchanged | — |

---

## 7. Copy that breaks after the swap
- **No pun copy remains in any repo.**
  - The old crankleads.com hero "We Crank Leads for Local Businesses Automatically" was removed in `47935eb`.
  - No "empire" wordplay exists anywhere (searched: empire, kingdom, reign, throne, "build your empire", Vu/view/déjà vu).
- The puns now live only in the **logos**: the hand-crank mark and the lime "Crank" half of the CrankLeads wordmark, plus the EmpireVu compass-star mark. The brand kit replaces them.

Name-dependent lines (pick one each):

**1. Site `<title>` / og:title**, today "CrankLeads — Stop Losing Jobs to Missed Calls":
- (a) "Everdoer — Stop Losing Jobs to Missed Calls" *(recommended: keeps positioning)*
- (b) "Everdoer — The employee who never clocks out"
- (c) "Everdoer: the employee who never clocks out. Stop losing jobs to missed calls."

**2. Hero eyebrow** (the site's only tagline slot), today "One missed call, handled":
- (a) keep it
- (b) "The employee who never clocks out." *(recommended)*
- (c) "Everdoer — the employee who never clocks out."

**3. `Proof.tsx:29`**, "CrankLeads started as the back office of A1 Marine…":
- (a) straight swap to "Everdoer started as the back office of A1 Marine…" *(recommended)*
- (b) "Everdoer started as the employee who never clocked out at A1 Marine…"
- (c) "Before it was Everdoer, it ran the back office at A1 Marine…"

**4. App meta description**, today "EmpireVu - Your business operations platform":
- (a) "Everdoer — the employee who never clocks out." *(recommended)*
- (b) "Everdoer — answers, quotes, books and gets you paid."
- (c) "Everdoer — your business, run while you work."

**5. empirevu.com waitlist H2** "Be first in line when EmpireVu opens." (only if you keep the page, D2):
- (a) "Be first in line for Everdoer."
- (b) "Get Everdoer before your competitors do."
- (c) "Join the Everdoer early-access list."

**6. Owner SMS prefix:**
- (a) "Everdoer: " for all orgs *(recommended)*
- (b) only for done-for-you orgs, as today

---

## 8. Recommended PR order (safest first)
Each PR is deployable alone, with full tests plus the local Postgres/PostgREST E2E suite run on each.

1. **PR 1, compatibility layer** (EmpireVu; no visible change)
   - Dual header names; voice-signature candidate URLs; `brandForHost` + middleware know everdoer hosts.
   - The legacy-host 301 rule (dormant until `EVERDOER_APP_BASE_URL` is set); multi-domain inbound email and pages hosts.
   - `EVERDOER_*` env reads with fallbacks; route aliases (`/welcome/everdoer`, `/api/public/everdoer/*`).
   - Dual Stripe metadata, Twilio tag and storage-key reads; `normalizeProductLine()`; second Stripe webhook secret.
   - New `job:twilio-repoint` and `job:retell-repoint` (dry-run default).
   - *Deploy, then do the DNS/Resend/Railway-domain/allowlist steps in the checklist.*
2. **PR 2, Everdoer for every customer** (EmpireVu)
   - All §1 copy, brand-kit assets, one lime theme, favicons/manifest/OG, AI filter names, legal pages.
   - Per-company sender (D7) + the values migration (§5.1, you run it).
   - *Then set `EVERDOER_APP_BASE_URL`: app hosts start 301-ing page views.*
3. **PR 3, marketing**
   - crankleads-system → everdoer.com (copy, assets, 301 from crankleads.com, sitemap, checkout path alias).
   - empirevu-site → redirect-only.
   - thinker-holdings Syncoree → Everdoer card.
4. **PR 4, provider re-point** (no code; you run the jobs and dashboard steps from the checklist): Twilio numbers, Retell agents, Stripe endpoint URLs, Intuit/Xero URIs, Google consent, Search Console.
5. **PR 5, internal renames** (EmpireVu; no behaviour change)
   - Identifiers, directories, packages, env-var names (fallbacks retained), npm scripts (old aliases), docs, e2e harness, CI labels.
   - Then the GitHub and Railway renames.
6. **PR 6, mobile release:** display name, icons, splash, strings, store listing. Bundle id unchanged.
7. **PR 7, Phase 3 DB object renames** (after 1–5 are stable)
   - `crankleads_purchases`, `crankleads_setup_followups`, `crankleads_tier`, `platform_brand` values, with compat views and widened CHECKs.
   - Migration + rollback for you to run; full E2E + isolation tests on the migrated DB.
8. **One release later:** drop the env fallbacks and compat views. **≥12 months:** review the old-host traffic logs before retiring any old domain. app.empirevu.com `/api/*` stays until the last old mobile build is gone.
