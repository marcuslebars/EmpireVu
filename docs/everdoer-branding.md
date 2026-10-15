# Everdoer: one platform brand, behaviour on the product line

Everdoer is the platform's one brand ("The employee who never clocks out."). It replaced
**EmpireVu** (the standard product, used by the house tenants: A1 Marine, Blair's, …) and
**CrankLeads** (the done-for-you product Ontario trades businesses buy on everdoer.com, formerly
crankleads.com). Since rebrand PR 2 every org's owner and staff, on every host, signed in or
signed out, see **Everdoer**: one name, one logo set, one lime theme. Nobody sees "EmpireVu",
"CrankLeads" or "Syncoree" any more.

What used to be "the brand" also carried the **product line** (standard vs done-for-you), and
some behaviour still follows that. So the code keeps the product line and branches on it, never
on a name.

Brand rules: the name is "Everdoer" (one word, capital E only). Colours: lime `#A6EE2B`,
near-black `#0C0E12`, off-white `#F4F4F1`, deep lime `#4F8A00` for lime on white. Font: Inter.
Logos and icons: `public/brand/everdoer/` (brand kit) and the root favicons. The old asset
files stay in `public/brand/` because emails and pages already sent link to them.

## How it works

| Piece | Where |
|---|---|
| The product line | `organizations.platform_brand` (`'empirevu'` = standard, `'crankleads'` = done-for-you; Phase 3 renames the values to `'standard'` / `'done_for_you'`). Every read goes through `src/lib/product-line.ts` (`productLineForOrg`, `isDoneForYou`), which understands both. |
| One source of truth | `src/lib/platform-brand.ts`: `EVERDOER_BRAND` (name, logo, mark, favicon, PNG icons, `hello@everdoer.com`, theme hex), `EVERDOER_COLORS`, `EVERDOER_ENTITY_LINE`, and `PLATFORM_BRANDS`: both old keys, each the same Everdoer display config plus `productLine`. `brandForOrg`, `brandForHost`, `withProductName()`. Shared by the SPA and the server. |
| Behaviour switches | Branch on `brand.productLine` (`isDoneForYouBrand`): `receptionistCopy` ("Marina" for standard orgs, "the AI receptionist" for done-for-you), plan copy, weekly-report defaults, the scorecard env override, generated-site links, the owner SMS prefix. |
| Server links | `src/server/services/platform-brand.ts`: `appBaseUrlFor(brand)` (`EVERDOER_APP_BASE_URL` for every org once set; until then standard orgs use `APP_BASE_URL` and done-for-you orgs the old `CRANKLEADS_APP_BASE_URL`, then `APP_BASE_URL`), `configuredAppBaseUrlFor()`, `loadOrganizationBrand()`. |
| SPA | `src/lib/brand-context.tsx` `BrandProvider`: tab title and favicon. One theme for everyone (`index.css` `:root`). `index.html` is static Everdoer. |
| Customer pages | `/q /i /p /v /f /book`, quotes, invoices, PDFs, the portal and review pages are the **company's** pages. They carry no platform theme, title, icon, name or "Powered by" line. The tab icon is the company logo, or a neutral icon (`public/brand/neutral-favicon.svg`). |

### Where people see Everdoer

* Sidebar, auth pages, onboarding, Dashboard and Reports ("Captured by Everdoer"), the command palette, settings text, the Help panel (with the D10 line "Everdoer is operated by Everdoer Technologies Inc." at its foot), help articles (`{{product}}`, filled in by `brandHelpArticle`) and the help assistant.
* `/privacy` and `/delete-account` (same paths on every host; they're in the app-store listings), with `hello@everdoer.com` and the D10 line.
* Emails to owners and staff: invites, the workflow "notify owner" subject ("Everdoer alert"), voicemail emails, digests, the monthly scorecard, the purchase welcome email, setup reminders, "you're live", the support email subject ("[Everdoer Help] …"), and accounting memos ("From Everdoer"; already-synced memos stay as they were).
* **SMS is the exception** (A2P): every text stays exactly as before ("CrankLeads: " on done-for-you owner texts, no prefix for other orgs, the CrankLeads platform-number reply) until `EVERDOER_SMS_BRANDING=1`. Then every org's owner texts start with **"Everdoer: "** and every platform SMS says Everdoer (see below).
* Generated done-for-you sites (`/s/<slug>`) end with a small "Powered by Everdoer" link to https://everdoer.com (`EVERDOER_SITE_URL` overrides it). This is the only place the platform is credited to end customers, and it replaced the old "Site by CrankLeads".
* The `/welcome/crankleads` purchase page and the `/forward/<token>` page: Everdoer logo, title and icon.
* Stripe Checkout (purchase and Settings → Billing) shows Everdoer (`crankleadsCheckoutBranding()`).
* Operator-only: the Concierge list ("Everdoer setups"), operator emails ("Everdoer health", "Everdoer ops", purchase and failure notices), the waitlist notice.

## Still an old name, by design

| What | Why |
|---|---|
| `x-empirevu-*` headers (still accepted), `empirevu*` storage keys (still read and cleared), `crankleads_*` tables, `platform_brand` values, identifiers, file and package names | API, storage and DB contracts. Nobody sees them. Renamed in PR 5 (code) and PR 7 (DB). |
| Mobile app (`mobile/`) | A separate store listing and binary, rebranded in PR 6. |
| Stripe **billing portal** header, receipts, statement descriptor, legal name in Checkout terms | Set per Stripe account, not per session. Change them in the Stripe dashboard. |
| Old asset files (`public/brand/crankleads-*`) | Already-sent emails and pages link to them. |
| `/welcome/crankleads`, `/api/public/crankleads/*` paths | Already in buyers' emails and Stripe success URLs. |

## Env switches

* `EVERDOER_SMS_BRANDING=1` [web, worker, billing-worker]: the ONE switch for platform names in
  SMS (`src/server/services/rebrand/sms-branding.ts`). **Off by default**: every SMS is
  byte-identical to before the rebrand. On: "Everdoer: " on every org's owner texts and Everdoer
  in every platform SMS. Before turning it on, update the A2P 10DLC campaign's brand and sample
  messages in Twilio. Unset it to roll back (docs/messaging-compliance.md).
* `PLATFORM_BRAND_NAME` [monthly-scorecard]: still overrides the scorecard name for standard
  orgs. Defaults to "Everdoer". Leave it unset (or set it to `Everdoer`); if it is set to
  `EmpireVu` today, remove it.
* `EVERDOER_APP_BASE_URL`: see `REBRAND_CHECKLIST.md` for the host move.

### Brand-neutral Supabase Auth templates

These templates are global for the Supabase project. They name no brand.
`{{ .ConfirmationURL }}` already points at the host the user started from.

**Confirm signup.** Subject: `Confirm your email`

```html
<h2>Confirm your email</h2>
<p>Thanks for signing up. Click below to confirm this email address and finish creating your account.</p>
<p><a href="{{ .ConfirmationURL }}">Confirm my email</a></p>
<p>If you didn't sign up, you can ignore this email.</p>
```

**Reset password.** Subject: `Reset your password`

```html
<h2>Reset your password</h2>
<p>Someone asked to reset the password for this email address. Click below to choose a new one.</p>
<p><a href="{{ .ConfirmationURL }}">Choose a new password</a></p>
<p>This link works once and expires soon. If you didn't ask for this, you can ignore this email — your password won't change.</p>
```

**Magic link.** Subject: `Your sign-in link`

```html
<h2>Sign in</h2>
<p>Click below to sign in. The link works once and expires soon.</p>
<p><a href="{{ .ConfirmationURL }}">Sign in</a></p>
```

**Invite user** (only if used). Subject: `You've been invited`

```html
<h2>You've been invited</h2>
<p>You've been invited to join a team. Click below to accept and set up your login.</p>
<p><a href="{{ .ConfirmationURL }}">Accept the invitation</a></p>
```

**Change email address.** Subject: `Confirm your new email`

```html
<h2>Confirm your new email</h2>
<p>Click below to confirm changing your login email from {{ .Email }} to {{ .NewEmail }}.</p>
<p><a href="{{ .ConfirmationURL }}">Confirm the change</a></p>
```

Set the sender name (Authentication → SMTP Settings) to "Everdoer" once the everdoer.com
sending domain is verified.

## Local development

`http://everdoer.localhost:5173` (or `crankleads.localhost`) gives you the done-for-you product
line before login; `localhost` gives you the standard line. Both display Everdoer. Chromium
resolves `*.localhost` by itself. Other browsers may need a hosts entry.

## Adding copy

* SPA: `const brand = useBrand()`, then `brand.name`. In shared text, write `{{product}}` and pass it through `withProductName(text, brand)`.
* Server, for owner and staff messages: `loadOrganizationBrand(supabase, orgId)`, then `brand.name` and `appBaseUrlFor(brand)`.
* Behaviour that differs between the product lines: branch on `brand.productLine` / `isDoneForYou()`, never on a name or the stored key.
* Customer-facing copy names the **company** and never the platform.
* AI-written text runs through the platform-name filters (`sms-agent/guard.ts`, `email-clerk/parse.ts`, marketer, estimator, purchasing, recruiter, `voice/post-call.ts`), which strip Everdoer, EmpireVu and CrankLeads.
