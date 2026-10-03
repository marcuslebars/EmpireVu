# Platform branding

**Business decision:** client businesses buy the product as **CrankLeads** (a done-for-you
lead system for trades). **EmpireVu** stays the internal engine / repo / infrastructure name.
Owners who log in, receive owner email/push/SMS from the platform, or install the app see
the platform brand — never "EmpireVu".

The brand is **configuration, not copy**: one module, env overrides, CrankLeads defaults.
Rebranding again is an env change and a redeploy, not a find-and-replace.

## Three kinds of surface

| Surface | Whose brand | Source |
|---|---|---|
| **Owner-facing** — app shell, sidebar, auth pages, loading/error states, dashboard + reports, settings, `/privacy`, `/delete-account`, invitation email, owner alerts (`notify_owner`), owner daily digest footer, lead-notification default sender, receptionist-health details, mobile app copy | **Platform** (CrankLeads) | this module |
| **Customer-facing** — public quote page, public booking page, quote/deposit emails, booking confirmations, Marina's voice prompts, Stripe statement descriptors / checkout product names | **The client company** | `companies.brand_*` columns, voice profile |
| **Integration / internal** — table names, env names, headers, storage keys, log tags, package + bundle ids | **EmpireVu** (unchanged) | n/a |

Customer-facing surfaces intentionally carry **no platform name at all** — no "Powered by"
footer (`src/test/quote-branding.test.ts` guards this for quotes). `PlatformBrand.poweredBy`
exists for a future opt-in. The hosted lead form (`/f/:key`) shows a small "Powered by
{platform name}" footer read from `platformBrand.name`. Customer pages set the browser tab
title to the client's business (`useDocumentTitle` in `src/lib/use-document-title.ts`):
"Book with {company}", "{company} — Get a quote", and the quote page's own title.

## The module

```
src/lib/platform-brand-core.ts   PURE: fields, defaults, validation, env-key names
src/lib/platform-brand.ts        SPA adapter → `platformBrand` (VITE_PLATFORM_* via import.meta.env)
src/server/platform-brand.ts     server adapter → `getPlatformBrand()` (PLATFORM_* via process.env)
vite.config.ts                   fills %VITE_PLATFORM_*% in index.html at build time
src/components/brand/Wordmark.tsx  text wordmark ("Crank" accent + "Leads" foreground)
src/components/brand/Logo.tsx    Logo / LogoMark: wordmark, or an image if configured
src/server/templates/platform-emails.ts  owner-facing platform email copy (pure, golden-tested)
mobile/src/lib/brand.ts          mobile app's own small brand config (same env names)
```

Fields: `name`, `shortName`, `tagline`, `supportEmail`, `websiteUrl`, `legalName`,
`emailFromName`, `poweredBy` (derived), `logoUrl`, `faviconUrl`, `accentHsl`, `wordmark`
(derived split of `name` at its first internal capital: CrankLeads → Crank + Leads).

Usage:
- SPA: `import { platformBrand } from "@/lib/platform-brand"; … {platformBrand.name}`
- Server: `import { getPlatformBrand } from "@/server/platform-brand"; getPlatformBrand().name`
- Mobile: `import { brand } from "@m/lib/brand"; … {brand.name}`

Blank, malformed or unsafe values (non-http URLs, protocol-relative URLs, bad emails, bad
HSL, `<>"` in text) fall back to the default instead of winning.

## Environment variables

All optional. Defaults live in `PLATFORM_BRAND_DEFAULTS` (`src/lib/platform-brand-core.ts`).

**Web SPA — build-time, `[web]`** (baked into the bundle and `index.html`; redeploy after changing):

| Var | Default | Used for |
|---|---|---|
| `VITE_PLATFORM_BRAND_NAME` | `CrankLeads` | Everywhere the product is named; `<title>`, meta tags |
| `VITE_PLATFORM_BRAND_SHORT_NAME` | = name | Attribution CSV filename prefix |
| `VITE_PLATFORM_BRAND_TAGLINE` | `Done-for-you lead system for trades` | meta description / og:description |
| `VITE_PLATFORM_SUPPORT_EMAIL` | `hello@crankleads.com` ⚠ confirm the mailbox | `/privacy`, `/delete-account` |
| `VITE_PLATFORM_WEBSITE_URL` | `https://crankleads.com` | `/privacy` contact |
| `VITE_PLATFORM_LEGAL_NAME` | = name ⚠ placeholder | `/privacy` contact line (the operating entity) |
| `VITE_PLATFORM_BRAND_LOGO_URL` | unset → text wordmark | Optional image wordmark (absolute URL or `/path`) |
| `VITE_PLATFORM_BRAND_FAVICON_URL` | `/crankleads-favicon.svg` | Favicon; collapsed-sidebar mark when an image logo is set |
| `VITE_PLATFORM_BRAND_ACCENT_HSL` | `82 85% 55%` | `--brand-accent` (wordmark only) |

**Server — runtime, `[web]` + `[worker]`** (set the same values on both Railway services):

| Var | Default | Used for |
|---|---|---|
| `PLATFORM_BRAND_NAME` | `CrankLeads` | Invitation subject/body, `notify_owner` default subject, digest footer, receptionist-health details |
| `PLATFORM_SUPPORT_EMAIL` | `hello@crankleads.com` | Invitation + digest footer |
| `PLATFORM_EMAIL_FROM_NAME` | = `PLATFORM_BRAND_NAME` | From display name on platform email (invitations, owner alerts, digest when the company has no `brand_from_name`, default `LEAD_FROM_EMAIL`) |

Which service reads what (traced): invitations, lead notifications and `/voice/health` run in
**web**; owner alerts run in the **workflow-events worker** (and in web for "Run now");
the owner digest runs in the **worker** scheduler (and web for "Send test"). The billing,
reconcile, quote-maintenance and jobber-sync services don't read these.

**Mobile — build-time** (`mobile/.env`): `VITE_PLATFORM_BRAND_NAME`,
`VITE_PLATFORM_SUPPORT_EMAIL`, `VITE_PLATFORM_BRAND_ACCENT_HSL`.

The **address** on outgoing mail is still `OUTBOUND_FROM_EMAIL` / `LEAD_FROM_EMAIL` (it has
to be a Resend-verified domain). Only the display name follows the brand. If those vars are
set in Railway as `EmpireVu <…>`, update them too. Mail that passes an explicit display name
overrides it anyway.

## Colours

The web app is dark-only and its `--primary` is a blue with **white** foreground text. The
CrankLeads lime (`hsl(82 85% 55%)`) needs **dark** text to be legible, so swapping
`--primary` globally would break contrast on every primary button. Decision: the brand
accent is a separate `--brand-accent` CSS variable (`src/index.css`, overridable through
`VITE_PLATFORM_BRAND_ACCENT_HSL`) used by the wordmark only. The global theme is
unchanged. Making the app chrome lime is a separate design task (swap `--primary` **and**
`--primary-foreground` together, and re-check every primary surface).

## How to rebrand

1. Web service (Railway): set the `VITE_PLATFORM_*` vars you want to change, **redeploy**
   (they're baked at build).
2. Web **and** worker services: set `PLATFORM_BRAND_NAME`, `PLATFORM_SUPPORT_EMAIL`,
   `PLATFORM_EMAIL_FROM_NAME`. Update the display name inside `OUTBOUND_FROM_EMAIL` /
   `LEAD_FROM_EMAIL` if they carry one.
3. Optional assets: drop a logo/favicon in `public/` and point
   `VITE_PLATFORM_BRAND_LOGO_URL` / `VITE_PLATFORM_BRAND_FAVICON_URL` at it.
4. Mobile: set the vars in `mobile/.env`, rebuild. Native display name + store listing are
   manual (below).
5. Verify (PowerShell):
   ```powershell
   (Invoke-WebRequest https://app.empirevu.com/).Content | Select-String "<title>"
   ```
   and send yourself a team invitation from Settings → Members.

## What intentionally still says EmpireVu

| Item | Why |
|---|---|
| Headers `X-EmpireVu-Key`, `X-EmpireVu-Signature`, `x-empirevu-retell-secret`, `x-empirevu-telnyx-secret` | Integration protocol — A1 spokes, crankleads.com forms, Retell and Telnyx are configured with them. The Integrations settings snippet still shows them because sites must send them verbatim. |
| localStorage keys (`empirevu_org_id`, `empirevu.*`), diagnostics page key listing | Renaming would log everyone out of their org selection. |
| Mobile bundle id / deep-link scheme `com.empirevu.app`, APNs bundle id | Permanent once published to the stores. |
| Mobile native display name (`strings.xml`, `Info.plist`), `capacitor.config.ts` `appName`, `mobile/STORE.md` listing copy | Must change together with the App Store / Play listing — manual. |
| Repo, package names, table/env names, `docs/EMPIREVU_*.md`, log tags, code comments | Internal engine name. |
| `User-Agent: EmpireVu-Onboarding/1.0` (catalog import fetch) | Technical identifier sent to third-party sites. |
| Waitlist operator email/Slack (`services/waitlist/notify.ts`) | Operator-only notification for the empirevu.com marketing waitlist. |
| `EmpireVu Demo` org from `npm run job:seed-demo` | Internal store-review/demo fixture. |
| Default hosts (`api.empirevu.com` in Jobber redirect default, CORS defaults) | Infrastructure; domains change via env, not branding. |

## Guard test

`src/test/platform-brand-guard.test.ts` scans `src/screens`, `src/components`, `src/App.tsx`,
`src/main.tsx`, `src/server/templates`, the owner-facing server services (invitations, owner
digest, lead notify, receptionist health, workflow actions, push, quote emails),
`mobile/src`, and both `index.html` files for the display spelling `EmpireVu` / `Empire Vu`
in code (comments stripped; lowercase identifiers like `x-empirevu-key` are not matched).
Add new owner-facing server modules to its `SCANNED` list. Keep `ALLOW` short (it is empty today).

## Not done / follow-ups

- **Legal name**: `VITE_PLATFORM_LEGAL_NAME` defaults to "CrankLeads". Set the registered
  operating entity before relying on `/privacy`; have the policy reviewed (it is a draft).
- **Support mailbox**: `hello@crankleads.com` is an assumed default — create it or set the env.
- **Mobile store listing + native display name** (`com.empirevu.app` stays).
- **Email sender domain**: if owner mail should come from `@crankleads.com`, verify the
  domain in Resend and change `OUTBOUND_FROM_EMAIL` / `LEAD_FROM_EMAIL`.
- **App domain** (`app.empirevu.com`): unchanged; moving owners to a CrankLeads domain is
  DNS + Supabase redirect URLs + `APP_BASE_URL` + `MOBILE_APP_ORIGINS` + Stripe/Retell
  webhook URLs — a separate cutover.

## Other surfaces that read the brand

- **Monthly scorecard** sender name + footer: `services/monthly-scorecard/platform-brand.ts`
  delegates to `getPlatformBrand()`, so `PLATFORM_BRAND_NAME` rebrands it with everything else
  (set it on the `monthly-scorecard` cron service too).
- **Onboarding wizard** headings use `platformBrand.name`.

## Security: client env is read by name only

`src/lib/platform-brand.ts` reads each `VITE_PLATFORM_*` variable by name. **Never pass
`import.meta.env` around as an object in client code**: Vite then inlines every `VITE_*`
variable present at build time into the public JavaScript. That happened once (Oct 2026):
a server secret configured as `VITE_SUPABASE_SERVICE_ROLE_KEY` on the web service shipped in
the bundle. `src/test/client-env-leak.test.ts` now fails CI on any whole-object reference.
Never give a server secret a `VITE_` prefix.
