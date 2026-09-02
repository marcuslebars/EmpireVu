# One-dollar production verification

Ten minutes, one real dollar, refunded at the end. Run this **before you set
`SELF_SERVE_QUOTES_ENABLED=1`**, so the first person to pay through this flow is
you and not a customer.

It exercises the whole chain: quote → email → hosted page → approval → Stripe →
webhook → deposit recorded → receipt email → refund. Every step has a check, so a
failure tells you *which* link broke rather than "it didn't work".

Use **live** keys. Test mode does not exercise the connected account, the real
tax registration, or deliverability — which are the three things that break.

---

## Step 0 is already done

A1 Marine Storage is connected and **ready to charge** — verified in Settings →
Payments ("Charges enabled · payouts enabled") and confirmed by a live Stripe
session opening on the connected account. Nothing to do here.

For any FUTURE company: Settings → Payments, pick it, press **Connect Stripe
account**. Payments is not Billing & Plans — Billing is what you pay for
EmpireVu, Payments is how a company gets paid by its customers.

---

## Before you start

- [ ] Migrations applied through `20260902000000_catalog_modifiers_and_bands`
- [ ] A1MS branding set — logo, colours, from-name, reply email, cancellation policy
- [ ] `a1marinestorage.ca` verified in Resend, SPF + DKIM published
- [ ] `quotes.a1marinestorage.ca` resolves with a valid certificate
- [ ] Railway env on **EmpireVu's** web service: `QUOTE_PUBLIC_BASE_URL`,
      `STRIPE_SECRET_KEY`, `STRIPE_CONNECT_WEBHOOK_SECRET`, and the Resend
      from-address config
- [ ] `RESUME_TOKEN_SECRET` on **a1marinestorage**, not here — it signs the
      calculator's PDF resume links and this app never reads it
- [ ] Connect webhook registered at
      `https://app.empirevu.com/api/webhooks/stripe/connect`, listening on
      **connected accounts**, events `checkout.session.completed` and
      `account.updated`

**Pre-flight.** Note the id is HARD-CODED. An earlier version of this file
looked the company up with `name ilike '%a1 marine%' limit 1`, and three of the
four companies match that — it returned **A1 Marine Care**, which is how a set of
A1 Marine Storage's branding ended up on the wrong company. Never guess a company
by name here.

```sql
select name,
       stripe_charges_enabled                        as charges_enabled,
       (stripe_mode = 'live')                        as live_mode,
       (brand_reply_email is not null
        and brand_primary_color is not null
        and cancellation_policy_text is not null)    as branding_set,
       exists (select 1 from public.service_catalog_items i
               where i.company_id = c.id)            as catalog_seeded
from public.companies c
where id = 'a1000000-0000-4000-8000-000000000003';   -- A1 Marine Storage
```

All four true as of the last check. The company ids, for reference:

| id | company |
|---|---|
| `a1000000-…-0002` | A1 Marine **Care** |
| `a1000000-…-0003` | A1 Marine **Storage** ← this one |
| `a1000000-…-0004` | A1 Coatings |

**Ontario tax registration must be ACTIVE on the connected account.** Checkout
sets `automatic_tax: { enabled: true }`, which fails the session outright without
one. Connected account's dashboard → Tax → Registrations.

**Get a contact whose email is yours:**

```sql
select id, full_name, email from public.contacts
where organization_id = '<org-id>' and email = 'marcus@tilotto.com';
```

If there isn't one, create it in the CRM screen first. The quote email goes to
the **contact**, not to you as the operator.

---

## The run

### 1. Create the draft (2 min)

Go to **app.empirevu.com/quotes**. The page is a JSON body — replace the template with
this. The single custom line is chosen so the deposit lands on exactly **$1.00**:

```json
{
  "title": "Deposit flow verification",
  "companyId": "a1000000-0000-4000-8000-000000000003",
  "contactId": "<the contact id from above>",
  "services": [],
  "customLines": [
    { "label": "Verification line", "amountCents": 354 }
  ],
  "introMessage": "Internal verification — please ignore."
}
```

Press **Create draft**.

**Check:** it appears in *Recent quotes* as `(draft — no number yet)` reading
**total $4.00, deposit $1.00**.

The arithmetic: subtotal $3.54 → HST 13% = $0.46 → total $4.00 → deposit 25% =
$1.00. If the deposit is not exactly $1.00, `QUOTE_TAX_RATE_BPS` or
`QUOTE_DEPOSIT_BPS` is overridden in the environment. Find out where before
charging anything.

### 2. Send it (1 min)

**Click `Edit` on the new quote first.** The **Send** button stays disabled until
a quote is loaded for editing — creating a draft does not select it. This is the
step most likely to strand you.

Then press **Send**. That allocates the quote number, stamps `valid_until`, and
emails the contact.

If the contact has no email address you now get an amber **notice**, not an
error: "Quote sent. No email address on file — share the link directly." The
quote is genuinely sent and payable either way. It used to return a 500 for that
case while the quote was live, which is how Q-2026-0001 came to exist.

**Check:** the email arrives from the A1 Marine Storage from-name at the address
in `brand_reply_email`, brand-styled, with one button.

**Check the email says nothing about EmpireVu.** The platform is the backend; if
its name reaches a customer, that is a bug.

If no email arrives, read the events before blaming Resend:

```sql
select event_type, metadata, created_at from public.quote_events
where quote_id = '<quote-id>' order by created_at;
```

`quote_email_skipped` means no recipient or no provider configured;
`quote_email_failed` carries the provider's own error in `metadata`.

### 3. Open it on your phone (1 min)

Tap the button in the email. A phone is how a customer will see this, so look at
it on one.

**Check:** logo, brand colour, quote number, valid-until, the line item, totals,
the deposit amount, and your cancellation policy. The URL should read
`quotes.a1marinestorage.ca/q/…` — verified working, signed out.

**Check** the status moved:

```sql
select quote_number, status, first_viewed_at from public.quotes where id = '<quote-id>';
```

### 4. Approve and pay (3 min)

Type your name, accept the terms, tap approve.

**Check: Stripe Checkout shows $1.00, not $4.00.** If it shows the total, stop —
the deposit is not being applied and no customer should reach this.

**Check the total is still exactly $1.00, with tax shown as included.** The
deposit line goes out `tax_behavior: "inclusive"` precisely because the deposit
is 25% of the tax-*inclusive* total. A charge of $1.13 means it went out
exclusive and Stripe added HST a second time.

Pay with a real card.

### 5. Verify what landed (2 min)

```sql
select quote_number, status, approved_by_name, approved_at,
       deposit_cents, approved_deposit_cents, deposit_paid_at,
       stripe_payment_intent_id, stripe_customer_id
from public.quotes where id = '<quote-id>';
```

Expect `status = 'deposit_paid'`, `deposit_paid_at` set, both Stripe ids
populated, and **100** in `approved_deposit_cents` — that is the amount actually
approved, and it is the authoritative one once the customer has toggled anything.

**Check the audit trail is complete:**

```sql
select event_type, created_at from public.quote_events
where quote_id = '<quote-id>' order by created_at;
```

Expect: `created`, `sent`, `quote_email_sent`, `viewed`, `approved`,
`checkout_session_created`, `deposit_paid`, `receipt_email_sent`.

Missing `deposit_paid` means the **webhook** did not arrive. Stripe → Developers
→ Webhooks → the Connect endpoint. A 400 there is a wrong signing secret; a 500
is the handler throwing, and Stripe will retry.

**Check the receipt email** arrives, brand-styled.

**Check the money is in the A1MS account, not the platform account.** If it
landed in the platform balance, the charge did not go through the connected
account, and nobody else should pay until that is fixed.

**Check the statement descriptor** on the charge reads as A1 Marine Storage.

### 6. Refund (1 min)

Refund the $1.00 from the **connected** account's dashboard.

The quote stays `deposit_paid` — there is no "unpay", and the Void button is
hidden once a deposit is recorded, by design. Leave it, or delete the row
directly if you would rather not see it in the list.

---

## Then, and only then

Set `SELF_SERVE_QUOTES_ENABLED=1` on the Railway **web** service.

Until it is set, qualifying leads are quoted by hand exactly as they are today.

---

## If it fails, where to look

| Symptom | Cause |
|---|---|
| No quote email | Check `quote_email_skipped` / `_failed` in `quote_events` |
| Email in spam | SPF/DKIM not published on `a1marinestorage.ca` |
| Quotes screen says "not enabled" | `STRIPE_QUOTES_ENABLED=0` |
| **Send** greyed out | Click **Edit** on the quote first |
| Approve → "not connected" | Step 0 not done, or done against another company |
| Onboarding link expired | Press Connect again; links are single-use |
| Payments panel says "only an owner or admin" | Your membership role on this org |
| Approve → "cannot accept charges yet" | Stripe verification still pending |
| Checkout errors on tax | No active Ontario registration on the connected account |
| Checkout shows $4.00 | Deposit not applied — stop |
| Charged $1.13 | Deposit sent tax-exclusive; HST added twice |
| Paid but status still `approved` | Connect webhook not arriving |
| Money in the platform balance | Charge not directed at the connected account |

## Rollback

Unset `SELF_SERVE_QUOTES_ENABLED`. Leads revert to being quoted by hand
immediately; nothing else changes, and quotes already sent stay live and payable.

To take the customer-facing surface down entirely — including quotes already
emailed — set `STRIPE_QUOTES_ENABLED=0`. That 404s every `/q/{token}` page for
everyone, so it is the bigger hammer.

---

## What this runbook no longer has to prove

The self-serve path was verified end to end on 2026-09-01, signed out, on the
customer's own domain:

- calculator submit → lead reaches EmpireVu → auto-quote created and sent
- the confirmation screen shows a real **Pay 25% Deposit** button
- the link opens `quotes.a1marinestorage.ca/q/{token}` and renders the quote
  with A1MS branding, correct totals, and no mention of the platform
- approve opens a **live** Stripe Checkout on A1MS's connected account, charging
  the DEPOSIT, with the quote number on the line item

That covers everything up to the card form. **The only unproven link is the
payment itself**: that `checkout.session.completed` arrives on the Connect
webhook, that `deposit_paid` is recorded, and that the receipt email sends.

That is what the dollar is for. `Q-2026-0001` is already approved with an open
session, so it can be paid directly without creating anything new.
