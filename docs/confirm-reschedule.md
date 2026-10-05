# Confirm & reschedule

Every visit (booking) has its own private link, `https://<brand quote domain>/v/{token}`.
From it the customer can:

- **Confirm**: "Yes, I'll be there." The visit is marked *confirmed by the customer*
  (shown on the job sheet) and a *pending* booking becomes *confirmed*.
- **Change the time**: pick from the brand's open times. Brands that book by half-day
  window (`companies.booking_policy`, like A1) see their windows with capacity respected;
  everyone else sees hourly slots (9–5, Mon–Sat) that don't overlap other jobs. Moving
  also counts as confirming.
- **Cancel**, with an optional reason.

Moving and cancelling are allowed up to a per-brand cutoff (24 hours by default); closer
than that the page asks the customer to call or text, with the brand's phone. Confirming
always works until the visit starts. Started, finished, cancelled or past visits are
read-only. The page carries only the brand (logo, colour, phone), never the platform.

## The link in reminders

Reminder automations reach it as **`{{booking.manage_url}}`**. The "Booking reminders"
recipe and every industry pack's reminder now end with "Confirm or change it here:
{{booking.manage_url}}". For reminders installed before this, **Settings → Confirm &
reschedule** lists each reminder automation and whether it has the link, with a button
that adds it (it replaces "Reply if you need to change it." or appends the sentence to
the first customer text). Staff can also copy a job's link from its job sheet
("Visit link").

## What the team sees

- **Moved:** the booking is rescheduled through the normal path (activity
  `booking.rescheduled` with `by: "customer"`, a recurring visit becomes an exception),
  and the owners, admins and the visit's crew get a push: "Pat Smith moved their visit:
  Thu 10:00 a.m. → Fri, 1:00 p.m."
- **Cancelled:** the booking moves to *cancelled* through the normal path (the
  `booking.cancelled` trigger fires), plus a `booking.customer_cancelled` activity with
  the reason, a follow-up task ("… cancelled — follow up"), and a push.
- **Confirmed:** a `booking.customer_confirmed` activity; the job sheet shows "Customer
  confirmed".

## Reminders follow the visit

When a visit is moved (by the customer *or* by staff), any automation run waiting on it
is woken immediately (`workflow-engine/retime.ts`). On resume, a wait written as
`until: "booking.scheduled_for - 2h"` is re-resolved against the booking's current time
and re-pauses if that's still ahead, so the "in about 2 hours" text goes out 2 hours
before the *new* time, never the old one. Plain `duration` waits are unchanged.

## Settings (per brand, owners/admins)

Settings → Confirm & reschedule: customers can move (on), customers can cancel (on),
changes allowed up to 1 day before (or any time, 2/12 hours, 2/3 days). Stored in
`companies.visit_settings` (jsonb, defaulted in code).

## Code

- `services/visits/rules.ts`: pure (settings, state, what's allowed, labels).
- `services/visits/public.ts`: **service role**, the public page (token = credential,
  server-side open times, writes through `rescheduleBooking` / `updateBookingStatus`).
- `services/visits/settings.ts`: staff side under RLS (settings, add link to reminders,
  a job's link).
- API: `GET /api/public/visits/{token}`, `GET …/times`, `POST …/confirm`,
  `POST …/reschedule {startsAt, windowKey}`, `POST …/cancel {reason}` (rate-limited per
  token: 120 views / 10 min, 10 changes / hour); `GET/PUT /api/organizations/{org}/visit-settings/{company}`,
  `POST …/add-link`, `GET /api/organizations/{org}/jobs/{booking}/visit-link`.
- Page: `src/screens/PublicVisitPage.tsx` (`/v/:token`, in `public-routes.ts`).

Migration: `20261005140000_visit_self_service.sql` adds `bookings.manage_token` (unique,
32 hex, defaulted for every existing and new booking), `bookings.customer_confirmed_at`
and `companies.visit_settings`. Rollback in `supabase/rollback/`.
