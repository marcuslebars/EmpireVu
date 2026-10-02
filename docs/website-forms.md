# Website lead forms (hosted page + embed script)

A non-technical owner gets a working lead form on their website in one click — no
developer, no server code. Leads land through the **same durable intake path** as every
other lead (`handleLeadIntake`), so dedup, the lead notification, consent recording and
`contact.created` automations (new-lead owner alert, instant reply) all apply.

Migration: `supabase/migrations/20261002120000_public_lead_forms.sql` (rollback in
`supabase/rollback/`). No new env vars.

## How it works

```
Owner clicks "Create your form"  →  public_form_keys row (evpk_…, company-scoped)
                                     │
  ┌──────────────────────────────────┴───────────────────────────────┐
  │ Hosted page  https://APP/f/evpk_…   (link for GBP / Facebook / SMS) │
  │ Embed        <script src="https://APP/embed/v1.js" data-form=…>    │
  │              → iframe of /f/evpk_…?embed=1&page=<parent URL>&utm_* │
  └──────────────────────────────────┬───────────────────────────────┘
                                     │  POST /api/public/forms/evpk_…
                                     ▼
  body cap → per-IP limit → key lookup (tenant from the KEY ROW) → Origin/allowed sites
  → per-form limit → honeypot + min fill time → Turnstile → field validation
  → schemaVersion-1 envelope → handleLeadIntake({ target: key's org+company,
                                                  workflowTrigger: { source: "public_form" } })
       1) raw_leads insert (durable — a failure here is a 500, never a false success)
       2) contact match/create + lead.<formType> activity (+ contact.created dispatch for a NEW contact)
       3) notification
```

| Piece | Where |
| --- | --- |
| Key table | `public.public_form_keys` (org + company tenancy, RLS: members read, admins manage) |
| Admin API | `GET/POST /api/organizations/{orgId}/public-forms`, `PATCH …/public-forms/{formId}`, `POST …/public-forms/{formId}/revoke` |
| Public API | `GET/POST/OPTIONS /api/public/forms/{formKey}` |
| Service | `src/server/services/lead-intake/public-forms.ts` (service role, sanctioned), `public-form-keys.ts` (RLS management), `public-form-envelope.ts` (pure: schema, envelope, origin policy, consent text) |
| Hosted page | `src/screens/PublicLeadFormPage.tsx` at `/f/:formKey` (public route — listed in `src/lib/public-routes.ts`) |
| Embed script | `public/embed/v1.js` (ES5, no build step, < 5 KB) |
| Owner UI | `src/components/website-forms/WebsiteFormsPanel.tsx` — onboarding "Website leads" step and Settings → Integrations |

## The snippet

```html
<!-- Form on the page (auto-resizing) -->
<script src="https://APP/embed/v1.js" data-form="evpk_…" data-mode="inline" async></script>

<!-- Floating "Get a quote" button that opens the form in a modal -->
<script src="https://APP/embed/v1.js" data-form="evpk_…" data-mode="button" data-label="Get a quote" async></script>
```

Optional: `data-color="#1d4ed8"` for the floating button. `APP` is the app origin the
owner copied the snippet from (Settings builds it from `window.location.origin`).

- **inline** inserts an `<iframe>` right after the script tag. The hosted page posts
  `{ type: "evform:resize", height }` to the parent; the script only accepts it from the
  app origin *and* from that iframe's own window, then sets the iframe height.
- **button** renders the button + modal inside a **shadow root** (falls back to a plain
  host element), so neither the host page's CSS nor ours leaks across. The iframe is
  created on first click.
- The script passes the parent page URL and any `utm_*` / `gclid` / `fbclid` params to the
  iframe; they land in `meta.page` / `meta.site` / `meta.utm` on the lead.
- `?embed=1` hides the hosted page's header (the host site already shows the brand).

## Per-platform instructions (shown in the panel)

| Platform | Steps |
| --- | --- |
| **Wix** | Add (+) → Embed Code → Embed HTML → Code → paste → Update. Drag the box to ~750px tall so the form isn't cut off. Wix runs embeds inside its own sandbox frame, so the **button** mode stays inside that box — use **inline**, or link a Wix button to the hosted link. If you restrict allowed websites, the Wix sandbox origin (typically `*.filesusr.com`), not your domain, is what the form sees — leave the list empty for Wix. |
| **Squarespace** | Edit page → (+) → Code block → paste → "Display source" off → Save. Code blocks need a Business plan or higher; on lower plans link a button to the hosted URL. |
| **WordPress** | (+) → Custom HTML block → paste → Update. Elementor: drag in the HTML widget. |
| **GoDaddy** (Websites + Marketing) | Edit Website → Add Section → HTML → paste into Custom Code → Done → Publish. |
| **Anything else** | Any "Embed", "HTML" or "Custom code" block works. No code allowed? Link a button to the hosted link. |

The hosted link (`/f/evpk_…`) also works standalone: Google Business Profile (website /
booking link), Facebook page button, Instagram bio, or texted to a customer.

## Form fields

Name, phone, email (**phone or email required**), service (catalog labels + "Other"),
details, optional preferred date (`meta.preferredDate`), and — when a phone is entered —
an SMS opt-in checkbox. Service choice rides in `services[]` and in the message text.

## Security model

- **The key is publishable.** It sits in HTML on purpose; it is stored in plain text
  (unlike `intake_keys`, which are hashed secrets) so the owner can copy the snippet again.
  All it can do is submit a lead into **its own company**.
- **Tenant from the key row only.** The submission schema has no tenant fields; any
  `organizationId` / `companyId` / `sourceSite` in the body is stripped. `sourceSite` on the
  envelope is the company slug (a free-text tag in pinned mode — it never routes).
- **Revocation** (`active=false`) makes the link and every embed return 404 immediately.
- **Abuse layers** (all before any write):
  1. body cap 16 KB → 413;
  2. per-IP limit `public_form_post` 8 / 10 min → 429;
  3. per-form limit `public_form_post_key` 100 / hour → 429;
  4. Origin: a write with no `Origin` → 403; a cross-origin site must be on
     `allowed_origins` when the list is non-empty; the hosted page (app origin) is always
     allowed, but when the list is non-empty and the iframe reports an embedding site
     (`location.ancestorOrigins` → `document.referrer` → `page`) that isn't listed → 403;
  5. honeypot `website` + minimum fill time 3 s → 400 (generic, so a real person can just
     press Send again);
  6. Cloudflare Turnstile (fail-open until `TURNSTILE_SECRET_KEY` is set — render it with
     `VITE_TURNSTILE_SITE_KEY`, which the hosted page and the test-lead button both do).
  The GET is limited to 60 / 10 min per IP (`public_form_get`).
- `allowed_origins` is a **browser-level control**, not the security boundary: the embed
  origin is reported by the client. The real protections are tenant pinning, rate limits,
  bot checks, and the paid-action guard below.
- **Paid-action guard.** New contacts from a form dispatch `contact.created` stamped
  `metadata.source = "public_form"`, which is in the guard's unauthenticated-source set
  (`workflow-engine/guards.ts`) — so a `call_lead` / `send_sms` automation triggered by a
  stranger's submission gets the same cooldown + daily cap as public booking.
- **Public GET exposes display fields only:** company name, logo URL (https only), public
  reply phone (`brand_reply_phone` — never the owner's personal number), brand colour,
  active catalog **labels** (no keys, no prices), the form type, and the consent wording.
- **Service role** is confined to `lead-intake/public-forms.ts` (SANCTIONED EXCEPTION
  header; listed in the runbook). Management runs on the caller's RLS client.

## Consent (CASL / CTIA)

The checkbox wording comes from the server (`smsConsentText()` in
`public-form-envelope.ts`) and is shown verbatim, so what the visitor read and what is
stored are the same string:

> Yes, {Company} may text me about my request at the number above. Message frequency
> varies. Message and data rates may apply. Reply STOP to opt out, HELP for help. Consent
> is not a condition of purchase.

- **Ticked** → `meta.smsConsent = { granted: true, text, capturedAt }`; the contact is
  recorded with `consent_source = 'express_optin'` (express — does not expire). A matched
  contact's *implied* consent is upgraded; an opted-out contact is never touched.
- **Unticked** → implied inquiry consent (`implied_inquiry`, 6 months), exactly like
  every other lead path.
- The raw envelope (with the consent text) stays in `raw_leads.raw_payload` as the record.
See [messaging-compliance.md](messaging-compliance.md).

## "Send a test lead"

The panel posts a real submission through `POST /api/public/forms/{key}` (same origin, so
the Origin check passes; Turnstile token included when configured). It is sent **as the
signed-in owner's email** (fallback `test.lead+webform@example.com`), so an instant-reply
automation lands in their own inbox, and it creates a "Test Lead" contact they can delete.
A 200 means the durable write and enrichment already completed.

## Differences from server-to-server intake keys

Intake keys (`evk_…`, `/api/intake`, HMAC-signed) remain for developers and the A1 spokes
— they're in the "Advanced: server-to-server" disclosure in onboarding and in
Settings → Integrations. Those leads do **not** dispatch `contact.created` (unchanged);
website-form leads do, because a CrankLeads client's owner alert and instant reply are
`contact.created` recipes.
