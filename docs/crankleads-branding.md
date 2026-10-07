# CrankLeads accounts see CrankLeads (per-account platform brand)

CrankLeads (crankleads.com) is what Ontario trades businesses buy. Buying it provisions an org
on this platform. The codebase, API contracts and the house tenants (A1 Marine, Blair, …) stay
**EmpireVu**. Anyone in an org that bought CrankLeads sees **CrankLeads** everywhere and never
the word "EmpireVu".

This is a **per-account switch, not a rename** (the full rename in PR #127 was reverted).

## How it works

| Piece | Where |
|---|---|
| The switch | `organizations.platform_brand` (`'empirevu'` default, `'crankleads'`). Migration `20261006140000_platform_brand.sql` backfills it from `crankleads_tier`. CrankLeads provisioning writes `'crankleads'` (`crankleads/provision.ts` → `organizations.ts createOrganization`). |
| One source of truth | `src/lib/platform-brand.ts`: brand configs (name, logo, mark, favicon, PNG icons, support email, default app host, theme hex) plus `brandForOrg(org)`, `brandForHost(hostname)` and `withProductName()`. Shared by the SPA and the server. `brandForOrg` also treats a non-null `crankleads_tier` as CrankLeads, so a buyer is never shown EmpireVu, even from a row read before the migration. |
| Server links | `src/server/services/platform-brand.ts`: `appBaseUrlFor(brand)` (EmpireVu → `APP_BASE_URL` exactly as before; CrankLeads → `CRANKLEADS_APP_BASE_URL`, default `https://app.crankleads.com`) and `loadOrganizationBrand()`. |
| SPA | `src/lib/brand-context.tsx` `BrandProvider`. **Signed out:** the brand comes from the hostname (`app.crankleads.com`, `*.crankleads.com`, `crankleads.localhost` → CrankLeads). **Signed in:** it comes from the active org's `platformBrand` (sent in `/api/session/context`). It sets `data-brand="crankleads"` on `<html>` (`index.css` swaps the colour tokens to lime on near-black, with dark text on lime), and sets the tab title and favicon. `index.html` runs the same host check inline, so the CrankLeads host never flashes EmpireVu before React loads. |
| Customer pages | `/q /i /p /v /f /book` are the **company's** pages. They carry no platform theme, title, icon or "Powered by" line. The tab icon is the company logo, or a neutral icon (`public/brand/neutral-favicon.svg`) when the company has none. |

### What a CrankLeads account's people see as CrankLeads

* Sidebar and all auth pages (sign in, sign up "Get started with CrankLeads", forgot/update password, phone, OAuth callback): CrankLeads logo, title, favicon and lime theme.
* Loading and error screens are now generic ("Loading…", "The app failed to load"), because the brand isn't known yet at that point.
* Onboarding ("Welcome to CrankLeads", "Set up CrankLeads", phone forwarding copy, forwarding test), the Dashboard and Reports "Captured by CrankLeads" card, the command palette, Voice, Accounting and Integrations settings text, the Help panel, help articles (`{{product}}` in `src/content/help/articles.ts`, filled in by `brandHelpArticle`) and the diagnostics page title.
* Emails and texts: team invite, the default subject of the workflow "notify owner" email ("CrankLeads alert"), the voicemail email, the forwarding-test "test again" link, the owner digest link, the monthly scorecard (sender, footer and link), the purchase welcome email, setup reminders and the "you're live" message ("log in to CrankLeads at app.crankleads.com"), the help assistant prompt, its canned reply and the support email subject, and accounting memos ("Card via CrankLeads", "Expenses (CrankLeads)").
* The `/welcome/crankleads` page: "Open CrankLeads", which leads to CrankLeads sign-in.
* Stripe plan Checkout from Settings → Billing uses the same branding as the crankleads.com purchase (`crankleadsCheckoutBranding()`), and its success and cancel URLs point at the CrankLeads host. Stripe Connect onboarding sends people back to the CrankLeads host too.

## Still EmpireVu by design

| What | Why |
|---|---|
| `x-empirevu-*` headers, `empirevu_*` / `empirevu.*` storage keys, bundle ids, DB/package names | API and storage contracts. Renaming them would break clients. Nobody sees them. |
| Mobile app (`mobile/`) | It's a separate store listing and binary. A per-account brand switch there is follow-up work. The help article no longer names the app ("In the mobile app…"). |
| Stripe **billing portal** header | The portal API has no per-session branding. The portal shows the Stripe account's portal settings (EmpireVu name/logo). Only its return URL follows the org's host. To fix it, use a separate Stripe portal configuration or account. |
| Stripe receipts, statement descriptor, legal name in Checkout terms | These are set per Stripe account, not per session. |
| Supabase Auth emails (confirm sign-up, reset password, magic link) | The templates are global for the project. Use the brand-neutral copy below. |
| House-only pages: `/privacy`, `/delete-account` (store-review pages for the EmpireVu app), `/internal/ops`, operator emails (`OWNER_EMAIL`), the waitlist, A1 imports, the demo seed, Retell/Marina health | Only the platform operator or the EmpireVu app listing sees these. |
| `PLATFORM_BRAND_NAME` env | Still overrides the scorecard name, but only for EmpireVu orgs. |

## Setup you need to do

1. **Domain (Railway).** In the web service → Settings → Networking → Custom Domain, add
   `app.crankleads.com`. Railway shows a CNAME target.
2. **DNS (crankleads.com registrar).** Add `CNAME app → <the Railway target>`. Wait for Railway to
   show the certificate as issued.
3. **Env.** Set `CRANKLEADS_APP_BASE_URL=https://app.crankleads.com` on **web, worker,
   billing-worker and monthly-scorecard**. The default is already that value, so set it anyway to
   be explicit, and use a different value for staging. Stripe Checkout success URLs (the
   crankleads.com purchase and plan upgrades by CrankLeads orgs) depend on it, so don't deploy
   before step 2 works, or buyers land on a dead host after paying.
4. **Supabase → Authentication → URL Configuration → Redirect URLs.** Add:
   * `https://app.crankleads.com/update-password` (set-password / reset links)
   * `https://app.crankleads.com/oauth/callback` (Google sign-in)
   * or simply `https://app.crankleads.com/**`
   Keep the Site URL as the EmpireVu app. Supabase ignores a `redirectTo` that isn't listed and
   falls back to the Site URL, which would send a CrankLeads buyer to the EmpireVu host.
5. **Google OAuth.** If Google sign-in is enabled, add `https://app.crankleads.com` to the Google
   Cloud OAuth client's *Authorized JavaScript origins*. (The redirect URI is Supabase's, so it is
   unchanged.)
6. **Supabase email templates.** Replace them with the brand-neutral copy below.
7. **Run the migration** (`20261006140000_platform_brand.sql`).

### Brand-neutral Supabase Auth templates

These templates go to EmpireVu and CrankLeads users alike, so they name neither brand.
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

Set the sender name (Authentication → SMTP Settings) to something neutral, such as "Account
team", or to the support mailbox name. Don't use "EmpireVu".

## Local development

`http://crankleads.localhost:5173` gives you the CrankLeads brand before login. Chromium resolves
`*.localhost` by itself. Other browsers may need a hosts entry.

## Adding copy

* SPA: `const brand = useBrand()`, then `brand.name`. In shared text, write `{{product}}` and pass it through `withProductName(text, brand)`.
* Server, for owner and staff messages: `loadOrganizationBrand(supabase, orgId)`, then `brand.name` and `appBaseUrlFor(brand)`.
* Customer-facing copy names the **company** and never either platform.
