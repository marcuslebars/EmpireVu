# Online booking

Each brand's booking page is `https://<brand quote domain>/book/{companyId}`. Automations
reach it as `{{company.booking_url}}`. It's on the brand's own domain, never the app's;
Marina's prompt and the AI lead suggestions use the same link.

The customer:
1. **Picks a service** from the brand's price list (active catalog items), with the price
   shown the way it's charged ("$450", "$12.50 per foot", "From $200"), or "Not sure, just
   book a time" unless the brand requires a service.
2. **Picks a time** from the brand's real open times, the same rules the visit page
   (`/v/`) uses to move a visit:
   - brands with a booking-window policy (`companies.booking_policy`, e.g. A1) get their
     windows ("Morning", "Afternoon") with capacity, lead time and days respected;
   - everyone else gets slots inside their **bookable hours**: first start, done-by,
     slot length, days, notice needed and how far ahead (Settings → Online booking).
   Anything already on the calendar is never offered; the server re-derives the times
   on submit and rejects any time it wouldn't offer now.
3. **Leaves details**: name, email, mobile (for reminders), where, and notes. A new
   contact is created (implied consent: they booked); an existing one (same email) is
   reused and gets a missing phone filled in.
4. **Pays a deposit** when the brand takes one (below), otherwise is booked: *confirmed*
   right away if the brand auto-confirms, else *pending* until the owner confirms. Either
   way they get a link to their visit page to confirm, move or cancel later.

The booking is titled "<Service> — <Name>", carries the service, its fixed price, the
location and notes, fires `booking.created` (so automations such as reminders run), and the
owners and admins get a push.

## Deposits

Settings → Online booking → Deposit to book: none, a fixed amount, or a percent of the price.

- Only for services with a **fixed price** (flat), never more than the price, and only
  when the brand's Stripe account is connected (`stripeReady`).
- Booking holds the slot (*pending*, `hold_expires_at` = now + "hold the time for",
  default 60 min) and creates a small **deposit invoice** (tax-free, it's a prepayment;
  no `booking_id` on it, linked as `bookings.deposit_invoice_id`), sends it, and sends
  the customer straight to its pay page (card or bank debit, exactly like any invoice).
- **Paid** (any path that marks the invoice paid: Stripe webhook or a payment recorded by
  staff): the booking is confirmed, the hold cleared, `booking.deposit_paid` logged, and
  the owner pushed. Paid after the slot was already released: a high-priority task to
  rebook or refund.
- **Not paid in time**: the worker (every 5 min) cancels the booking (the slot reopens,
  reminders stop) and voids the deposit invoice. A deposit still clearing (a bank debit
  in flight) keeps the slot and is re-checked daily.
- **The job's invoice** (made when the job is done, by hand or by "job done → invoice")
  starts from the booked price and **credits the paid deposit**, so the customer is
  asked only for the balance. The reports dashboard counts the deposit once (deposit
  invoices are left out of "Invoiced"; both payments count in "Collected").

## Settings (per brand, owners/admins)

`companies.online_booking_settings` (jsonb, defaulted in code): `enabled`, `startHour`,
`endHour`, `workingDays`, `slotMinutes`, `minNoticeHours`, `horizonDays`, `showServices`,
`requireService`, `autoConfirm`, `depositMode`, `depositFixedCents`, `depositPercent`,
`holdMinutes`. Defaults: on, Mon–Sat 9–5, 1-hour slots, 2 hours' notice, 14 days ahead,
services shown, not required, not auto-confirmed, no deposit.

The visit page's "change the time" uses the same bookable hours (and the visit's own length).

## Code

- `services/scheduling/rules.ts`: pure (settings, deposit maths, open times, labels).
- `services/public-booking.ts`: the public page and booking (sanctioned service role).
- `services/scheduling/deposits.ts`: deposit paid / hold expiry (sweep is service role).
- `services/scheduling/settings.ts` + `GET/PUT /api/organizations/{org}/online-booking-settings/{company}`.
- `services/scheduling/urls.ts`: `bookingPageUrl` (brand domain).
- Page: `src/screens/PublicBookingPage.tsx`; settings: `src/components/settings/OnlineBookingSettings.tsx`;
  the job sheet shows the deposit status.

Migration `20261005160000_online_booking.sql` (rollback in `supabase/rollback/`):
`companies.online_booking_settings`, and on bookings `service_item_id`, `price_cents`,
`deposit_cents`, `deposit_invoice_id`, `deposit_paid_at`, `hold_expires_at`.
