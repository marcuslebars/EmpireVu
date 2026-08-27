# EmpireVu hub — env vars and webhook endpoints

Single reference for the move to `empirevu.com`. EmpireVu is the backend for
everything; customer-facing surfaces carry the **brand's** identity, never the
platform's (see `docs/stripe-org-scoping.md`).

## Domains

| Host | Serves | Railway |
|---|---|---|
| `empirevu.com` | hub app + platform webhooks | **web** service, custom domain |
| `api.empirevu.com` | inbound integrations + customer-facing pages (`/q/{token}`) | same **web** service, second custom domain |

Railway accepts multiple custom domains on one service — no second deployment.
The apex cannot be a CNAME: use the ALIAS/ANAME or A records Railway lists for
the root; `api` is a normal CNAME.

## Railway env vars

Everything below goes on the **web** service (`railway.json`) unless stated. The
four background services (`railway.worker.json`, `railway.billing-worker.json`,
`railway.billing-reconcile.json`, `railway.jobber-sync.json`) need **no new
variables** — none of them touch Stripe or quotes.

### New — set these now

| Variable | Value | Notes |
|---|---|---|
| `STRIPE_MERCHANT_A1MS_SECRET_KEY` | A1MS account secret key | Test key first. The `STRIPE_MERCHANT_` prefix is **enforced** in the DB and app — other names are rejected. |
| `STRIPE_MERCHANT_A1MS_WEBHOOK_SECRET` | A1MS webhook signing secret | From the endpoint you register below. |
| `QUOTE_PUBLIC_BASE_URL` | `https://api.empirevu.com` | Origin for customer quote links and Stripe return URLs. Omit to fall back to `APP_BASE_URL`. |

### Changed — the domain move

| Variable | Was | Now |
|---|---|---|
| `APP_BASE_URL` | `https://hub.tilotto.com` | `https://empirevu.com` |

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
https://empirevu.com/api/webhooks/stripe
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
| `/api/jobber/webhook`, `/api/jobber/callback` | Jobber — being retired; leave until wind-down |
| `/api/public/booking/{companyId}` | any published booking links |

Prefix each with `https://api.empirevu.com`.

**Do these AFTER DNS resolves**, and verify one delivery per integration before
retiring the old host.

## Email sending — the open question

`OUTBOUND_FROM_EMAIL` is a single global address, and the From line is one of the
most visible things on a customer email. Sending quote mail from an
`@empirevu.com` address would put the platform's name in front of customers,
which is exactly what the branding rule forbids.

Options:

1. **Per-brand domain (recommended).** Verify `a1marinestorage.ca` in Resend and
   set `OUTBOUND_FROM_EMAIL=quotes@a1marinestorage.ca`. Works today with one
   brand. Needs SPF/DKIM records on that domain.
2. **Per-company from address.** Add a `brand_from_email` column and select per
   company at send time. Needed once a second brand sends mail. Each brand's
   domain must be separately verified in Resend.

`brand_from_name` already exists and sets the display name, which is what a
recipient reads first — but the address is still visible, so option 1 is the
minimum for A1MS.

## Order of operations

1. Add both custom domains in Railway; create the DNS records.
2. Verify `nslookup` resolves both, and `https://empirevu.com` loads with a valid
   certificate.
3. Set `APP_BASE_URL` and `QUOTE_PUBLIC_BASE_URL`.
4. Add the two `STRIPE_MERCHANT_A1MS_*` vars (test keys).
5. Apply pending migrations; run the `companies` update for Stripe refs and
   branding.
6. Register the A1MS merchant webhook; re-point the platform Stripe webhook.
7. Re-point the other inbound URLs above; verify one delivery each.
8. Sort the email From address.
9. Only then set `STRIPE_QUOTES_ENABLED=1` and run the one-dollar runbook.
