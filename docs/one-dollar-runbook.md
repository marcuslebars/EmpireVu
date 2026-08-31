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

## Step 0: connect A1MS

There is an API route for this now, but **no button yet** — the Settings screen
has not been wired to it. Until it is, POST to it from the browser console while
signed in as an owner or admin:

```js
await fetch(`/api/organizations/${ORG_ID}/companies/${COMPANY_ID}/stripe-connect`,
  { method: "POST" }).then(r => r.json())
```

That returns `{ data: { accountId, url, expiresAt } }`. Open `url` and complete
Stripe's onboarding — business details, bank account, identity. The link is
single-use and expires in minutes; if it goes stale, POST again for a fresh one.

The route creates the Standard account with `company_id` and `organization_id` in
its metadata, and records the id **before** minting the link, so a failure part
way cannot orphan an account in your dashboard and create a second one next time.
Creation is keyed by company, so a double-click cannot either.

Do **not** set `stripe_charges_enabled` by hand. It defaults to false, and the
`account.updated` webhook sets it — which makes the pre-flight below double as
proof that your Connect webhook is wired. If it is still false once Stripe says
onboarding is complete, the webhook is not arriving, and you would much rather
learn that here than at the card screen.

Set the descriptor while you are in Supabase — it is what a cardholder reads on
their statement, and it is not part of onboarding:

```sql
update public.companies
set stripe_statement_descriptor_suffix = 'A1 MARINE',
    stripe_account_label = 'A1 Marine Storage'
where id = '<a1ms-company-id>';
```

---

## Before you start

- [ ] Migrations applied through `20260902000000_catalog_modifiers_and_bands`
- [ ] A1MS branding set — logo, colours, from-name, reply email, cancellation policy
- [ ] `a1marinestorage.ca` verified in Resend, SPF + DKIM published
- [ ] `quotes.a1marinestorage.ca` resolves with a valid certificate
- [ ] Railway env on the **web** service: `QUOTE_PUBLIC_BASE_URL`,
      `RESUME_TOKEN_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_CONNECT_WEBHOOK_SECRET`,
      and the Resend from-address config
- [ ] Connect webhook registered at
      `https://api.empirevu.com/api/webhooks/stripe/connect`, listening on
      **connected accounts**, events `checkout.session.completed` and
      `account.updated`

**Pre-flight.** This gets your ids and checks the preconditions in one query. All
five `ok` values must be true:

```sql
with c as (
  select * from public.companies where name ilike '%a1 marine%' limit 1
)
select c.id as company_id, c.organization_id, x.check_name, x.ok
from c
cross join lateral (values
  ('connected account', (c.stripe_connected_account_id is not null)::text),
  ('charges enabled',   (c.stripe_charges_enabled)::text),
  ('live mode',         (c.stripe_mode = 'live')::text),
  ('branding set',      (c.brand_reply_email is not null
                         and c.brand_primary_color is not null
                         and c.cancellation_policy_text is not null)::text),
  ('catalog seeded',    (exists (select 1 from public.service_catalog_items i
                                 where i.company_id = c.id))::text)
) as x(check_name, ok);
```

`charges enabled = false` is the usual one: Stripe onboarding can *complete*
while verification is still pending. The app turns that into a clear
`charges_disabled` error rather than letting a customer discover it at the card
screen — but tonight it means wait, not proceed.

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

Go to **/quotes** in the Hub. The page is a JSON body — replace the template with
this. The single custom line is chosen so the deposit lands on exactly **$1.00**:

```json
{
  "title": "Deposit flow verification",
  "companyId": "<a1ms-company-id>",
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

**Check:** the email arrives, from the A1 Marine Storage from-name at
`quotes@a1marinestorage.ca`, brand-styled, with one button.

**Check the email says nothing about EmpireVu.** The platform is the backend; if
its name reaches a customer, that is a bug, not a preference.

If no email arrives, read the events before blaming Resend:

```sql
select event_type, metadata, created_at from public.quote_events
where quote_id = '<quote-id>' order by created_at;
```

`quote_email_skipped` means no recipient or no email provider configured;
`quote_email_failed` carries the provider's own error in `metadata`. Neither
fails the send — the quote is sent and payable either way, which is exactly why
you check rather than assume.

### 3. Open it on your phone (1 min)

Tap the button in the email. A phone is how a customer will see this, so look at
it on one.

**Check:** logo, brand colour, quote number, valid-until, the line item, totals,
the deposit amount, and your cancellation policy. The URL should read
`quotes.a1marinestorage.ca/q/...`.

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
| Onboarding link expired | POST step 0 again; links are single-use |
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
