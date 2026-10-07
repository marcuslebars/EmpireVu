# EmpireVu hub — env vars and webhook endpoints

Single reference for the EmpireVu hosts. The hub is `app.empirevu.com`. EmpireVu is the backend for
everything; customer-facing surfaces carry the **brand's** identity, never the
platform's (see `docs/stripe-org-scoping.md`).

## Domains

| Host | Serves | Railway |
|---|---|---|
| `app.empirevu.com` | hub app + platform webhooks | **web** service, custom domain |
| `api.empirevu.com` | inbound integrations (webhooks, intake, voice) | same **web** service, second custom domain |
| `quotes.a1marinestorage.ca` | customer-facing quote pages (`/q/{token}`) | same **web** service, third custom domain |
| `empirevu.com` | **marketing / early-access site — a DIFFERENT service** | not the hub |

⚠️ `empirevu.com` is NOT the hub. It serves the early-access marketing SPA, whose
catch-all answers ANY unmatched path with 200 and index.html. Pointing an
integration at it therefore looks like success and silently discards the payload:
`EMPIREVU_INTAKE_URL` was set to `https://empirevu.com/api/intake` and every lead
from the storage site was posted into a void, with "forwarded" in the log. Point
integrations at `api.empirevu.com`, and the hub UI is `app.empirevu.com`.

Railway accepts multiple custom domains on one service — no second deployment.
The apex cannot be a CNAME: use the ALIAS/ANAME or A records Railway lists for
the root; `api` is a normal CNAME.

## Railway env vars

Everything below goes on the **web** service (`railway.json`) unless stated.

One NEW service is required: **quote-maintenance**, a nightly cron
(`railway.quote-maintenance.json`, `0 13 * * *` UTC = 9am ET). It sends expiry
reminders and expires stale quotes. It needs `SUPABASE_SERVICE_ROLE_KEY`,
`RESEND_API_KEY`, `OUTBOUND_FROM_EMAIL`, `QUOTE_PUBLIC_BASE_URL` and
`STRIPE_QUOTES_ENABLED` — but no Stripe keys, since it never charges anything.
Create it whenever you like: while `STRIPE_QUOTES_ENABLED` is unset it logs and
exits 0.

The other background services (`railway.worker.json`,
`railway.billing-worker.json`, `railway.billing-reconcile.json`) need **no new
variables** — none of them touch Stripe
or quotes.

### New — set these now

| Variable | Value | Notes |
|---|---|---|
| `STRIPE_MERCHANT_A1MS_SECRET_KEY` | A1MS account secret key | Test key first. The `STRIPE_MERCHANT_` prefix is **enforced** in the DB and app — other names are rejected. |
| `STRIPE_MERCHANT_A1MS_WEBHOOK_SECRET` | A1MS webhook signing secret | From the endpoint you register below. |
| `QUOTE_PUBLIC_BASE_URL` | `https://quotes.a1marinestorage.ca` | Origin for customer quote links and Stripe return URLs. Must be a **brand** host — see below. Leave unset until the domain resolves with a valid cert. |

### Changed — the domain move

| Variable | Was | Now |
|---|---|---|
| `APP_BASE_URL` | `https://hub.tilotto.com` | `https://app.empirevu.com` |

Builds Stripe Checkout/Portal return URLs and self-booking links, so it must
match a host customers can actually reach.

### Hold until the runbook passes

| Variable | Value |
|---|---|
| `STRIPE_QUOTES_ENABLED` | `1` |

Strictly `=== "1"`. While unset, every quote route returns 404 and the whole
feature is inert.

### Existing — unchanged

`STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` (the **platform** account —
EmpireVu billing orgs for their subscriptions; nothing in the quotes path reads
them), `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`, `OUTBOUND_FROM_EMAIL`,
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.

### Optional tuning — defaults are correct

| Variable | Default |
|---|---|
| `QUOTE_TAX_RATE_BPS` | `1300` (13% HST) |
| `QUOTE_DEPOSIT_BPS` | `2500` (25% deposit) |
| `QUOTE_EXPIRY_DAYS` | `30` |

## Webhooks to register

### Stripe — A1MS merchant account (new)

```
https://api.empirevu.com/api/webhooks/stripe/merchant/<a1ms-company-id>
```

Events: `checkout.session.completed`, `invoice.paid`

Get the id with:

```sql
select id, slug, name from public.companies where slug = 'a1-marine-storage';
```

The company id is in the path so the brand is known **before** the signature is
verified — exactly one secret is tried, and one brand's secret can never validate
another's payload.

### Stripe — platform account (re-point)

```
https://app.empirevu.com/api/webhooks/stripe
```

Same path as before; **the host changed**. If this is still registered against
`hub.tilotto.com`, update it or subscription billing events stop arriving.

## Every other inbound URL that moves with the domain

A domain change breaks every registered inbound webhook. Each of these is a URL
held by a third party and must be re-pointed at the new host — none of them fail
loudly; they simply stop delivering.

| Endpoint | Registered with |
|---|---|
| `/api/intake` | the A1 marketing sites (HMAC-signed lead intake) |
| `/api/retell/webhook` | Retell |
| `/api/retell/functions/capture-lead` | Retell (function/tool URL) |
| `/api/telnyx/webhook`-family: `/api/telnyx/lead-intake`, `/api/telnyx/dynamic-variables`, `/api/telnyx/insights`, `/api/telnyx/tools/quote` | Telnyx / the voice assistant config |
| `/api/public/booking/{companyId}` | any published booking links |

Prefix each with `https://api.empirevu.com`.

**Do these AFTER DNS resolves**, and verify one delivery per integration before
retiring the old host.

## Why quote links use a BRAND domain

The quote URL is customer-visible twice over: in the email body, and in the
address bar once they tap it. Serving it from `api.empirevu.com` would put the
platform's name in front of every customer — the exact thing the branding rule
forbids, and easy to miss because nobody thinks of a URL as branding.

So `/q/{token}` is served from `quotes.a1marinestorage.ca`, a CNAME to the same
Railway web service. No code change: `QUOTE_PUBLIC_BASE_URL` selects it.

`quote-emails.test.ts` asserts strictly against the platform name appearing
anywhere in a rendered email, URL included, so pointing this back at
`api.empirevu.com` fails the suite rather than shipping quietly.

Add the domain in Railway and the CNAME at the `a1marinestorage.ca` DNS **now** —
it is independent of the code and TLS provisioning should not be on the cutover
critical path. It is a subdomain, so the apex and the storage site are untouched.
Leave `QUOTE_PUBLIC_BASE_URL` unset until it resolves with a valid certificate.

## Email sending

`OUTBOUND_FROM_EMAIL` is a single global address, and the From line is one of the
most visible things on a customer email. Sending quote mail from an
`@empirevu.com` address would put the platform's name in front of customers,
which is exactly what the branding rule forbids.

**Decided:** `OUTBOUND_FROM_EMAIL=quotes@a1marinestorage.ca`.

Requires `a1marinestorage.ca` verified in Resend with its SPF and DKIM records
published, or mail will not send.

The display name comes from the company, so it reads
`"A1 Marine Storage" <quotes@a1marinestorage.ca>`. `formatFrom` strips quotes and
backslashes from the name: an unescaped quote breaks the From header and Resend
rejects the whole message, and a stray character in a company record must not be
able to stop mail going out.

**When a second brand starts sending**, this single global address stops working
— Marine Care mail would go out from a Storage address. That needs a
`brand_from_email` column, per-company selection at send time, and each brand's
domain separately verified in Resend. Not needed while A1MS is the only sender.

## Order of operations

1. Add all three custom domains in Railway (`empirevu.com`, `api.empirevu.com`,
   `quotes.a1marinestorage.ca`); create the DNS records for each.
2. Verify `nslookup` resolves all three, and that `https://app.empirevu.com` and
   `https://quotes.a1marinestorage.ca` both load with a valid certificate.
3. Set `APP_BASE_URL` and `QUOTE_PUBLIC_BASE_URL`.
4. Add the two `STRIPE_MERCHANT_A1MS_*` vars (test keys).
5. Apply pending migrations; run the `companies` update for Stripe refs and
   branding.
6. Register the A1MS merchant webhook; re-point the platform Stripe webhook.
7. Re-point the other inbound URLs above; verify one delivery each.
8. Sort the email From address.
9. Only then set `STRIPE_QUOTES_ENABLED=1` and run the one-dollar runbook.
