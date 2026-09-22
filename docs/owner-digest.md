# Owner daily digest (Task 15)

Every morning the owner gets a short summary of what happened overnight and what needs them,
**without opening the app** — over SMS and/or email, one message **per company**. This is the
SMS/email owner digest; it is distinct from the mobile **push** digest
([`src/server/services/push/digest.ts`](../src/server/services/push/digest.ts)), which is an
org-level web-push notification for app devices. The two coexist: different channels,
different audiences, separate idempotency.

## Pieces

- **Settings**: `companies.digest` jsonb — `{ enabled, send_at_local ("HH:MM", default "06:30"),
  channels (["email","sms"]), always_send }`. null/missing ⇒ disabled. Read/written by
  [`owner-digest.ts`](../src/server/services/owner-digest.ts) (`parseDigestSettings` /
  `getDigestSettings` / `updateDigestSettings`) via `GET`/`PUT /api/organizations/:orgId/ui/digest`.
  Settings → **Notifications** shows a per-company card (toggle, send time, channels,
  quiet-night switch, **Send test digest**).
- **Scheduler job**: `processOwnerDigests` runs inside the existing worker's `runScheduler`
  pass (alongside the push digest). For every company with digest enabled whose local send
  time has passed today and which hasn't been sent yet: compute → claim → send.
- **Templates** ([`src/server/templates/digest.ts`](../src/server/templates/digest.ts)): pure
  `renderDigestSms` / `renderDigestEmail`, reusing the quote-email house style. Golden-tested.
- **Delivery**: `notify_owner` plumbing — `resolveOwnerContacts` (companies.owner_email /
  owner_phone_e164 → `OWNER_EMAIL` → org owner) + `deliverMessage`, which writes `message_log`
  and meters usage. Owner messages carry no consent check and never require approval.

Migration: `supabase/migrations/20260922120000_owner_digest.sql` (+ rollback). Reuses existing
env only: `APP_BASE_URL` (deep link), `BUSINESS_TIMEZONE` / `OWNER_EMAIL` (fallbacks). No new
env vars.

## Timezone & idempotency (per company)

Period boundaries and the send time use the **company's** timezone
(`companies.timezone` → `BUSINESS_TIMEZONE` → `America/Toronto`). The digest is idempotent per
`(company_id, local_date)`, where `local_date` is the calendar date **in the company
timezone** — a UTC date key would double-send around midnight UTC. `owner_digest_sends` holds
one row per (company, local_date) with a `unique` constraint; the worker inserts (claims) the
row before sending, so a second worker in the same window sends nothing.

## What's in it (last 24h unless noted)

| Line | Source |
| --- | --- |
| Calls — total | `retell_calls` created in the window (company-scoped) |
| Calls — need callback | those with `is_urgent` or `in_voicemail` |
| Booked | `bookings` created in the window |
| Quotes sent | `quotes` with `sent_at` in the window |
| New leads | `contacts` created in the window |
| Messages needing reply | `ui_inbox_v` where `needs_reply` (Task 12) |
| Quotes unseen 48h+ | `quotes` sent > 48h ago, `first_viewed_at` null |
| Bookings today | `bookings` scheduled in today's local day |
| Usage this month + cap | `usage_monthly_v` (company) + `orgLimit` for the one capped feature |
| Captured this month | `getAttributionSummary` over `monthRangeInTimeZone` (Task 14) |

## SMS length & quiet handling

- **SMS ≤ 320 chars, deep link always intact**: `renderDigestSms` appends the `/inbox` deep
  link verbatim and truncates only the content (adds `…`) to fit. Golden-tested.
- **Quiet night**: when nothing happened, the digest is skipped unless `always_send` is on, in
  which case a one-line "quiet night" message goes out. A test digest always sends.
- **Quiet failure**: if a channel can't be delivered (e.g. `sms` configured but the owner has
  no phone), that channel is skipped with a logged reason and the other channel still sends —
  the scheduler job never throws.
