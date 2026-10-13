# CrankLeads → Everdoer: rebrand plan (Phase 1, audit only)

Status: **waiting for approval.** Nothing has been changed in either repo.
Audited: `marcuslebars/EmpireVu` at `aaaf7e8` (main, includes Phases 1–5) and `marcuslebars/crankleads-system` (the crankleads.com site) at `accdfcf`. Also checked: live Railway services, domains and env var *names* (values not read).

---

## 0. Summary and the decisions I need from you

**The shape of the change.** "CrankLeads" is mostly a *display name* sitting on top of an internal *data key*. Rebranding safely means splitting them:

| Layer | Example | Plan |
|---|---|---|
| What people see | "CrankLeads" in UI, emails, SMS prefix, logo, checkout, site | **Change now → "Everdoer"** |
| Domains people visit | crankleads.com, app.crankleads.com | **Move to everdoer.com / app.everdoer.com**, old ones 301-redirect forever |
| Internal keys | `platform_brand = 'crankleads'`, `crankleads_purchases`, `crankleads_tier`, `CrankleadsTier`, Stripe metadata `source: "crankleads"`, `STRIPE_PRICE_CL_*` | **Keep** (renaming breaks live gating, Stripe lookups and RLS for zero customer benefit) |
| Webhooks | Twilio, Stripe, Retell, Telnyx | **No change needed.** They all point at `app.empirevu.com` (the internal platform host, which stays), not at a CrankLeads domain |

**Findings that shrink the job:**
- Every provider webhook is on `app.empirevu.com` (`APP_BASE_URL`, `TWILIO_WEBHOOK_BASE_URL`, `TWILIO_INBOUND_SMS_URL`). The rebrand doesn't need to touch Twilio, Stripe or Retell webhook URLs or secrets at all.
- The "crank" pun in copy is already gone. The old hero "We Crank Leads for Local Businesses Automatically" was replaced in `47935eb` by "Stop losing jobs to missed calls." The only remaining pun is the **logo mark itself** (a hand crank). The brand kit replaces it.
- No migration seeds brand text, and recipes and templates are in code. The database part is tiny: see §5.
- The email inbox (Phase 5) isn't switched on yet (`INBOUND_EMAIL_DOMAIN` unset), so it can launch on `in.everdoer.com` from day one with nothing to migrate.

**Decisions for you** (my recommendation first):
1. **Keep internal keys as-is** (`platform_brand='crankleads'`, table and column names, Stripe ids and metadata, TS identifiers, `src/server/services/crankleads/` folder). *Recommended.* Rename later in a no-customer-impact refactor if you want.
2. **App host:** `app.everdoer.com` (mirrors today). *Recommended.*
3. **Sender address for Everdoer email.** Today all email (A1 *and* CrankLeads) comes from one `OUTBOUND_FROM_EMAIL`. I'd add `EVERDOER_FROM_EMAIL` (e.g. `hello@everdoer.com`), used only for Everdoer orgs, so A1 mail is untouched. *Recommended.*
4. **Site `<title>`/OG title**, which today is "CrankLeads — Stop Losing Jobs to Missed Calls". Options:
   - (a) "Everdoer — Stop Losing Jobs to Missed Calls" (keeps the positioning; *recommended*)
   - (b) "Everdoer — The employee who never clocks out"
   - (c) "Everdoer — The employee who never clocks out. Stop losing jobs to missed calls."

   Your rule says to use the tagline "where a tagline already exists", so I'd also put it as the small eyebrow above the hero H1 (replacing "One missed call, handled"? See §7).
5. **EmpireVu leaks.** Some screens shown to CrankLeads customers say "EmpireVu", not "CrankLeads" (link previews of app links, `/privacy`, `/delete-account`, the website-form snippet). Your rule "anything a customer sees says Everdoer" puts these in scope. *Recommended: fix them in this pass* (§1.6).
6. **Repos and services not audited**: `empirevu-site`, `thinker-holdings`, `a1*` repos. I only had access to EmpireVu and crankleads-system in this session. Tell me if any of the others links to crankleads.com.
7. **Brand kit.** `Everdoer-brand-kit-fully-rounded.zip` isn't in this session. Please attach it before Phase 2.

---

## 1. Customer-facing copy

Risk legend: **L** low (copy only), **M** medium (touches a flow or a test-heavy area), **H** high (can break a live flow if done wrong).

### 1.1 Single source of the display name, EmpireVu app (L)
`src/lib/platform-brand.ts:70-80` → `name: "Everdoer"`, `supportEmail: "hello@everdoer.com"`, the new asset paths and theme-color. This one change flips ~40 rendered places:
- the sidebar logo alt and `document.title`;
- "Get started with …", "Finish setting up …", "Captured by …" (Dashboard and Reports), "Set up …" (onboarding), "Your … number", the Help panel, help articles (`{{product}}`), the help assistant, the accounting memos written into QuickBooks/Xero ("From Everdoer"), monthly scorecard and weekly report (fromName and footer), invite emails, the default owner-alert subject, missed-call transcript text, DFY intake SMS ("Everdoer: you're in…").

### 1.2 Hard-coded "CrankLeads" literals (L)

| Where | Today | Change |
|---|---|---|
| `src/server/services/crankleads/config.ts:23` `CRANKLEADS_OFFER_NAME` | "CrankLeads" | value → "Everdoer" (welcome email, setup reminders, "you're live" email/SMS, forwarding email/SMS, stop-reminders page, operator emails) |
| `src/lib/crankleads-purchase-api.ts:10,12` | "CrankLeads" | → "Everdoer" (purchase welcome page) |
| `src/screens/CrankleadsWelcomePage.tsx:30-31,127`, `src/screens/ForwardPage.tsx:23-24,125` | crankleads logo/alt | Everdoer assets/alt |
| `src/content/help/articles.ts:18,31,201` | "If you bought through CrankLeads" | "…through Everdoer" (keep the `crankleads` search keyword and add `everdoer`) |
| `src/components/settings/WeeklyReportSettingsSection.tsx:81` | "Texts are part of CrankLeads plans." (shown to non-CrankLeads orgs, incl. A1) | "Texts are part of Everdoer plans." |
| `src/server/services/staff/office-manager/briefing.ts:94` | fromName "CrankLeads" | `brand.name` |
| `src/server/services/dfy/site-render.ts:583` | "Site by CrankLeads" on every generated `/s/<slug>` site (seen by end customers) | "Site by Everdoer" → `https://everdoer.com` |
| `src/server/services/help/account-context.ts:34-36` | "CrankLeads Catch / Close / Front Desk" | "Everdoer Catch / Close / Front Desk" |
| `src/server/services/staff/dispatcher/environment-canada.ts:34` | `User-Agent: CrankLeads-Dispatcher/1.0` | `Everdoer-Dispatcher/1.0` (EC sees it only) |
| `index.html:16-34` (pre-React script) | sets title "CrankLeads", favicon, rewrites meta "EmpireVu"→"CrankLeads" | Everdoer, on both crankleads and everdoer hosts |
| Concierge (operator-only): `ConciergeListPage.tsx:124,179`, `concierge/*actions.ts`, `operator-health/render.ts`, provisioning errors | "CrankLeads setups" etc. | "Everdoer" (internal but cheap; keeps the operator consistent) |

### 1.3 SMS (M: wording seen by owners on every text)
- `owner-channel/common.ts:180-181` `signaturePrefix()` → `"Everdoer: "`. This is applied to every owner text, approvals included. The 07:00 briefing budget uses the prefix length: "Everdoer: " is 10 chars vs 12, so it is not affected.
- `twilio/inbound-sms.ts:206` `PLATFORM_UNKNOWN_SENDER` → "Everdoer: this number is for Everdoer account owners. To reach a business, please text or call them directly. Reply STOP to opt out."
- STOP and START replies are Twilio-managed (no custom copy in code). The HELP reply only gets the prefix. **Check in the Twilio console** whether the platform Messaging Service has custom Advanced Opt-Out text that says CrankLeads (see the checklist).
- CASL footers are brand-neutral ("Reply STOP to stop these texts.").

### 1.4 AI agents (H if missed: the AI could say "Everdoer" to a business's customers)
Every "never mention the platform" filter needs `everdoer` added, keeping `crank\s?leads|empire\s?vu`:
- `sms-agent/guard.ts:11`
- `staff/email-clerk/parse.ts:136`
- `staff/marketer/ai.ts:157`
- `staff/estimator/estimate.ts:31`
- `staff/purchasing/ai.ts:78`
- `staff/recruiter/ai.ts:121`
- `voice/post-call.ts:125`
- `scripts/sms-agent-eval/run.ts:208`
- `scripts/e2e-dfy/staff.ts:709`

Prompts contain no brand. Retell `agent_name` is "<company> — Marina" (no platform brand). Nothing to change in Retell for the name (§4).

### 1.5 Emails (M)
All brand text comes from §1.1/§1.2 constants (fromName, sign-offs "— The Everdoer team", subjects). **Sender address:** see decision 3 and §3.4. Supabase auth email templates (dashboard) name neither brand (docs/crankleads-branding.md:80); verify in the checklist.

### 1.6 EmpireVu branding a CrankLeads customer can see today (M; in scope per your rule)

| Where | Today | Proposal |
|---|---|---|
| `index.html:6-13` static `<title>`/description/og:* | "EmpireVu" for link-preview crawlers (iMessage, Slack, Facebook) of **every app.crankleads.com link** | Serve brand-correct head per host: middleware rewrite on Everdoer hosts to an `index.everdoer.html` with Everdoer title, OG, favicons, `theme-color` and manifest |
| `/privacy` (`PrivacyPolicyPage.tsx`), `/delete-account` (`DeleteAccountPage.tsx`) | EmpireVu only, `hello@empirevu.com` | brand-aware: name and contact email from `brand` (legal entity line unchanged) |
| Onboarding website-form snippet `OnboardingWizard.tsx:364` | `https://api.empirevu.com/api/intake`, `x-empirevu-*` headers | URL → `https://app.everdoer.com/api/intake` on Everdoer orgs (the same service serves it). **Header names stay** (`x-empirevu-*`); they're a wire contract |
| Mobile app (Capacitor, "EmpireVu") | EmpireVu | **Defer**: needs store listing and bundle changes. Separate project |
| Fallbacks to "EmpireVu" when the brand load fails | rare | leave |

### 1.7 Marketing site, crankleads-system (L)
13 strings:
- `index.html:6,8,15` (title, author, og:title)
- `Navbar.tsx:15,24` (logo alt, aria-label)
- `Footer.tsx:30` (©)
- `Faq.tsx:18`
- `LeadForm.tsx:126`: the **CASL consent wording**. It must change, because consent names who'll contact them.
- `Proof.tsx:29`
- `Privacy.tsx:14,26`: update "Last updated" to the release month.
- `src/config.ts:10,13`

Legal entity: "Thinker Holdings Inc." isn't named on the site or in the app today. Nothing to keep or change. (Do you want it added to the privacy pages? Not proposed.)

### 1.8 Docs (L)
- 16 docs, ~270 lines (`docs/crankleads-purchase.md`, `crankleads-branding.md`, `ai-staff.md`, `done-for-you.md`, `front-desk-ai.md`, `billing.md`, …).
- Update prose to Everdoer. Keep file names; `crankleads-branding.md` gets a "renamed to Everdoer" note and becomes the cut-over runbook.

---

## 2. Brand assets
Needs the brand kit (decision 7).

| Asset | Where today | Replace with |
|---|---|---|
| `public/brand/crankleads-logo.svg` (app) | `platform-brand.ts:71`, welcome, forward pages | `public/brand/everdoer-logo-on-dark.svg` (sidebar is dark) plus `everdoer-logo-on-light.svg` for light surfaces |
| `public/brand/crankleads-favicon.svg`, `-favicon-32.png`, `-apple-touch-icon.png` (app) | `platform-brand.ts:74-78`, `index.html:26` | `everdoer/favicon.svg`, `favicon.ico`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png` |
| No web manifest for the app | — | **add** `site.webmanifest` (name "Everdoer", icons 192/512, `theme_color`, `background_color` `#0C0E12`), served on Everdoer hosts |
| theme-color | `#0c0f13` (app config and site `index.html:13`, one off from `#0C0E12`) | `#0C0E12` |
| Stripe Checkout logo | `config.ts:136` → `https://crankleads.com/brand/crankleads-logo.png` | `https://everdoer.com/brand/everdoer-logo-on-light.png`. Checkout's logo sits on Stripe's light header, so per your rule use the deep-lime `#4F8A00` variant. Needs a PNG in the kit |
| Site: `public/brand/crankleads-logo.svg`, `.png`, `crankleads-icon.png` (og:image), `crankleads-icon-192.png`, `favicon.svg`, `favicon.ico`, `apple-touch-icon.png` | `index.html:10-12,18`, Navbar/Footer | kit equivalents. og:image becomes a proper 1200×630 OG card if the kit has one; else the 512 icon |
| CSS theme | lime `#A6EE2B` / `#0C0E12` / `#F4F4F1` / Inter | **unchanged** (confirmed in both repos). Add `#4F8A00` as a "deep lime" token for logo and "doer" on white |

Old `crankleads-*` asset files stay in the site's `public/brand/` for one release, so old emails and Checkout sessions that hot-link them still render.

---

## 3. URLs and domains

### 3.1 Hosts (H: the core cut-over)

| Today | After | How |
|---|---|---|
| `crankleads.com` (Railway project "CrankLeads", service `crankleads-system`) | `everdoer.com` (+ `www`) on the same service | `server/index.mjs` gets a host check: any request on `crankleads.com` / `www.crankleads.com` → **301 `https://everdoer.com` + same path + query**. Railway keeps `crankleads.com` attached. |
| `app.crankleads.com` (on the EmpireVu service, next to `app.empirevu.com`, `api.empirevu.com`, `quotes.a1marine*.ca`) | `app.everdoer.com` on the same service | `src/middleware.ts`: on `app.crankleads.com`, **GET/HEAD of pages** (`/`, `/signin`, `/s/<slug>`, `/f/<key>`, `/r/<token>`, `/port/…`, `/import/…`, `/welcome/…`, `/settings…`) → 301 to `app.everdoer.com` + same path + query. **`/api/*` is never redirected**: it keeps serving on both hosts, because POSTs don't survive redirects and old links like `/api/public/crankleads/setup-reminders?token=…` must keep working. |
| `app.empirevu.com`, `api.empirevu.com`, A1 quote domains | unchanged | not touched |

- `brandForHost()` (`platform-brand.ts:142-153`) and the `index.html` regex add `everdoer.com`, `*.everdoer.com`, `*.everdoer.localhost`, and keep crankleads.
- **Side effect:** Supabase sessions are per-origin. An owner signed in on app.crankleads.com gets redirected and **signs in once** on app.everdoer.com. Mentioned in the announcement.

### 3.2 Env-driven base URLs (H: read the new name, fall back to the old one)

| New env var (read first) | Old (fallback, one release) | Read at |
|---|---|---|
| `EVERDOER_APP_BASE_URL` | `CRANKLEADS_APP_BASE_URL` → `APP_BASE_URL` | `server/services/platform-brand.ts:38,50`, `quotes/config.ts:85` |
| `QUOTE_PUBLIC_BASE_URL_EVERDOER` | `QUOTE_PUBLIC_BASE_URL_CRANKLEADS` | `quotes/config.ts:85` |
| `EVERDOER_SITE_ORIGINS` (default `https://everdoer.com,https://www.everdoer.com,https://crankleads.com,https://www.crankleads.com`) | `CRANKLEADS_SITE_ORIGINS` | checkout CORS (`crankleads/config.ts:101`) |
| `EVERDOER_CANCEL_URL` (default `https://everdoer.com/#pricing`) | `CRANKLEADS_CANCEL_URL` | `config.ts:111` |
| `EVERDOER_CHECKOUT_DISPLAY_NAME` / `_LOGO_URL` / `_BACKGROUND_COLOR` / `_BUTTON_COLOR` | `CRANKLEADS_CHECKOUT_*` | `config.ts:155-158` (defaults → Everdoer values, bg `#0C0E12`) |
| site: `VITE_EVERDOER_APP_URL` / `EVERDOER_APP_URL` (defaults `https://app.everdoer.com`) | `VITE_CRANKLEADS_APP_URL` / `CRANKLEADS_APP_URL` | `src/config.ts:26`, `server/index.mjs:214` |

- **Keep as-is:** `STRIPE_PRICE_CL_*`, `STRIPE_SETUP_FEE_CL_*`, `STRIPE_COUPON_CL_FOUNDING` ("CL" is opaque, and renaming risks 503s at checkout); `APP_BASE_URL`, `TWILIO_WEBHOOK_BASE_URL`, `TWILIO_INBOUND_SMS_URL` (EmpireVu host; webhooks).
- **Site note:** the site's Dockerfile passes no build args, so production always uses the defaults in `src/config.ts`. Changing the default is what moves the Sign-in link. Fixed in Phase 2 by adding `ARG`s.

### 3.3 Hard-coded URLs (L–M)
- **EmpireVu:**
  - `crankleads/config.ts:96-97,136` (defaults above)
  - `dfy/site-public.ts:20` `CRANKLEADS_SITE_CREDIT_URL` → `https://everdoer.com`
  - `platform-brand.ts:79` support email
  - `.env.example` comments
- **Site:**
  - `index.html:9` canonical → `https://everdoer.com`
  - `index.html:18` og:image → everdoer.com asset
  - `server/index.mjs:108` lead meta `site: "everdoer.com"`
  - `Privacy.tsx:14` "through everdoer.com"
  - `README.md`
  - `server/lead.test.mjs` expectations
- **No sitemap exists in either repo.** robots.txt is domain-free. Proposal: add `sitemap.xml` for everdoer.com (one URL plus `/privacy`) and a `Sitemap:` line, which helps the Search Console change of address.
- **CORS:** only the checkout endpoint is brand-sensitive (above). App CORS (`server/api/cors.ts`) is mobile-only. Public forms are host-agnostic.
- **Auth redirects:** built from `window.location.origin` and `appBaseUrlFor("crankleads")`, so code is fine. **Dashboard work:** Supabase Redirect URLs and Google OAuth origins must include `https://app.everdoer.com` (checklist).
- **Stripe success/cancel URLs:**
  - Built from `appBaseUrlFor` at session creation, so new sessions get app.everdoer.com automatically.
  - Already-open sessions return to app.crankleads.com, which 301s, so they're fine.
  - New purchases land on `/welcome/everdoer`. `/welcome/crankleads` stays as an alias forever, because it's baked into issued success URLs.
- **Unsubscribe and stop links:** the setup-reminders stop link moves to `/api/public/everdoer/setup-reminders` (an alias route sharing the handler). The old path keeps working.
- **Checkout API path:** add `/api/public/everdoer/checkout[…]` aliases. The site switches to the new path in the same release; the old path keeps working for cached pages.

### 3.4 Email sending (H for deliverability)
- All mail uses one sender, `OUTBOUND_FROM_EMAIL`, whose value I can't see. **Its domain must not change**, because A1 mail uses it too.
- New `EVERDOER_FROM_EMAIL` (e.g. `hello@everdoer.com`) is used only for `platform_brand='crankleads'` orgs, with a fallback to `OUTBOUND_FROM_EMAIL`. It is only set **after** everdoer.com passes SPF/DKIM/DMARC in Resend.
- Reply-to for brand mail: `hello@everdoer.com`.
- `hello@crankleads.com` → `hello@everdoer.com` everywhere (site config, `platform-brand.ts`). Keep `hello@crankleads.com` receiving mail (forward to the new inbox) for at least a year.

---

## 4. Webhooks
**No provider change required.**

| Provider | Endpoint today | Rebrand impact |
|---|---|---|
| Twilio voice (inbound, recording, ai-handoff, business-line, forwarding-test) | `TWILIO_WEBHOOK_BASE_URL ?? APP_BASE_URL` = app.empirevu.com | **None.** Signature validation is over the full URL and pinned to that one base, so **do not move these to an everdoer host**. If you ever do, it has to be one coordinated switch of the env var plus every number's VoiceUrl, A1's included. |
| Twilio SMS inbound | app.empirevu.com (`TWILIO_INBOUND_SMS_URL`) | None. It already validates on any host via candidates. |
| Stripe platform + Connect | app.empirevu.com `/api/webhooks/stripe[/connect]` | None. Secrets are per endpoint and the body is signed. |
| Retell webhooks + function tools | `APP_BASE_URL` (app.empirevu.com), baked into each agent at provisioning | None. |
| Telnyx, `/api/intake` | app.empirevu.com / header secrets | None. |
| Resend inbound (Phase 5, not live yet) | — | Set it up directly as `INBOUND_EMAIL_DOMAIN=in.everdoer.com`. **Don't** launch on crankleads, because changing it later orphans every inbox address. |

Because `/api/*` keeps serving on app.crankleads.com and app.everdoer.com too, any webhook someone pointed at app.crankleads.com still works.

---

## 5. Database values
Live rows can't be queried from here, so Phase 2 ships **`rebrand_audit.sql`** (read-only SELECTs) for you to run first, plus the migration and rollback.

| Item | Plan | Risk |
|---|---|---|
| `organizations.platform_brand = 'crankleads'` + CHECK constraint | **keep** (internal key, ~65 code comparisons incl. 10 `.eq()` queries; renaming falls back to EmpireVu branding) | — |
| `organizations.crankleads_tier`, tables `crankleads_purchases`, `crankleads_setup_followups` | **keep** (your rule: no table/schema renames) | — |
| `company_sites.content→facts.brand = "crankleads"` | **keep** (key, drives the "Site by …" credit) | — |
| The org/company that receives marketing-site leads, **named "CrankLeads"** (`.env.example` / site README) | **migrate**: `name` → "Everdoer" where `name = 'CrankLeads'` (exact) | L |
| `companies.quote_public_base_url` containing `crankleads` (provisioning never sets it, but a manual one may exist) | **migrate**: replace host `app.crankleads.com` → `app.everdoer.com`, only on `platform_brand='crankleads'` orgs | L |
| `companies.brand_*` on Everdoer tenants | tenant-owned (their own business brand). The audit query confirms none say CrankLeads; expected no change | — |
| Historical lead `source` values `crankleads-audit/-call/-question`, `sourceSite "crankleads"` | **keep history**. New site leads send `everdoer-*` / `"everdoer"`. Not used for routing (the site uses a per-tenant intake key); display only | L |
| Column comment on `platform_brand` (names crankleads.com) | update comment | L |

Migration: `supabase/migrations/20261015100000_rebrand_everdoer.sql` + `supabase/rollback/20261015100000_rebrand_everdoer.down.sql` (restores the old names and URLs from a backup table the migration fills). **You run them; I don't.**

---

## 6. Code identifiers: rename now vs defer

| Group | Recommendation |
|---|---|
| Display constants (`CRANKLEADS_OFFER_NAME` value, `APP_NAME`, `PURCHASED_OFFER_NAME`, brand config name) | **Now** (values only; identifier names stay) |
| Customer-visible paths (`/welcome/crankleads`, `/api/public/crankleads/setup-reminders`, `…/checkout`) | **Now: add `everdoer` aliases**, new links use them, old ones stay forever |
| Asset files (`crankleads-*.svg/png`) | **Now: add `everdoer-*`**, keep the old files one release |
| Env vars (`CRANKLEADS_*`) | **Now:** read `EVERDOER_*` first, fall back to `CRANKLEADS_*` (§3.2). Remove the fallback in the release after you've switched Railway |
| Site `package.json` name `crankleads` | **Now** → `everdoer` (no deploy coupling) |
| `platform_brand` key, DB tables/columns, CHECK constraints | **Defer** (don't rename) |
| TS identifiers (`CrankleadsTier`, `isCrankleads*`, `createCrankleadsCheckout`…), `src/server/services/crankleads/` folder, test file names | **Defer** (internal; a later mechanical refactor) |
| npm scripts `job:crankleads-*`, `railway.crankleads-sweep.json`, Railway service `crankleads-sweep`, Railway project "CrankLeads" | **Defer.** The cron `startCommand` and config path must change in lockstep with the dashboard. Optional later rename in the dashboard only |
| Stripe product ids `crankleads_<tier>`, lookup keys, metadata `source:"crankleads"`, coupon ids | **Defer** (live Stripe data). Rename only the *display names* in Stripe (checklist) and in `scripts/stripe/setup-crankleads.mjs` |
| CSS `data-brand="crankleads"`, `data-testid="crankleads-logo"` | **Defer** (keys) |
| GitHub repo `crankleads-system` | **Defer** (GitHub redirects renames, but Railway's source link should be re-checked). Optional |
| Rate-limit scopes `crankleads_*` | **Keep** |

**Tests.** ~128 assertion lines and 3 snapshots assert "CrankLeads" copy. They're updated to "Everdoer". Tests that use the `crankleads` *key* stay. e2e:
- `env.sh` and `phase*.sh` gain `app.everdoer.localhost`.
- One new e2e step proves `app.crankleads.localhost` page requests 301 to `app.everdoer.localhost`, and that `/api/*` on the old host still answers.

---

## 7. Copy built on the "crank" pun
- **In text: none left.** The hero "We Crank Leads for Local Businesses Automatically" was removed in the site revamp (`47935eb`). Today's H1 is "Stop losing jobs to missed calls." and stays.
- **In the logo:** the mark is a hand crank, and "Crank" is lime in the wordmark. Replaced wholesale by the brand kit.
- **Name-dependent lines that read differently after the swap (pick one each):**
  1. Eyebrow above the hero H1, currently "One missed call, handled":
     - (a) keep it as is;
     - (b) "The employee who never clocks out." (*recommended*: the tagline, kept short);
     - (c) "Everdoer: the employee who never clocks out."
  2. `Proof.tsx:29`, "CrankLeads started as the back office of A1 Marine…":
     - (a) "Everdoer started as the back office of A1 Marine, our marine service company on Georgian Bay. It worked, so now any trades business can plug it in." (*recommended*: straight swap);
     - (b) "Everdoer started as the employee who never clocked out at A1 Marine, our marine service company on Georgian Bay…";
     - (c) "Before it was Everdoer, it ran the back office at A1 Marine…".
  3. `Faq.tsx:18`, "…come straight into CrankLeads.":
     - (a) "…come straight into Everdoer." (*recommended*);
     - (b) "…come straight to your Everdoer inbox.";
     - (c) "…land in Everdoer, where we answer them for you."
  4. SMS `signaturePrefix`:
     - (a) "Everdoer: " (*recommended*);
     - (b) no prefix (not recommended, because owners need to know the text is from us).

---

## 8. What Phase 2 will deliver (on approval)
- **Branches:** `rebrand/everdoer` in EmpireVu and crankleads-system.
- **Changes:** everything marked "Now" above.
- **New files:** REBRAND_PLAN.md (this file), REBRAND_CHECKLIST.md (manual steps with exact values, in order), and the announcement email and SMS.
- **SQL:** migration and rollback, plus `rebrand_audit.sql`. Not run by me.
- **Checks:** full test suite, both typechecks, lint, the SQL harness, all e2e drivers (plus a new redirect step), a re-grep listing the intentional `crankleads` leftovers, and screenshots (homepage, signup/onboarding, dashboard header, a sample email) once the brand kit is attached.
- **Review:** an independent adversarial review (broken links, auth redirects, CORS, webhook signatures, unverified sender domain, A2P wording, any remaining "CrankLeads").
- **Release order:**
  1. DNS, Resend domain and Railway domains are added (old ones keep working).
  2. Merge the EmpireVu PR. Both brands render; nothing redirects until `EVERDOER_APP_BASE_URL` is set.
  3. Set env vars. Redirects turn on.
  4. Merge the site PR.
  5. Send the announcement.

  The redirect only activates when the new host is configured, so merging early can't break anything.
