# AI staff

CrankLeads replaces everyone in the office except the owner. The AI front desk (docs/front-desk-ai.md) answers calls and texts; the AI staff roles below take the rest of the office jobs. They share the front desk's plumbing:

- **Owner by text** — every sensitive action is an `owner_approvals` row the owner answers with `Y 12` / `N 12` from the platform number.
- **One registry** — `src/server/services/staff/registry.ts` merges each role module (`staff/<role>/index.ts`, type `StaffRoleModule` in `staff/types.ts`) into:
  - the customer SMS agent (extra tools + prompt notes),
  - the owner-by-text agent (extra tools + prompt notes),
  - the approval runner (`owner-channel/approvals.ts` → the role's executor for its own kinds; the result is recorded on the row),
  - the scheduler (`runStaffSweeps`, each sweep throttled and isolated).
- **Settings** — Settings → AI front desk, one section per role (`src/components/settings/staff/*`), each role its own `companies.ai_settings.<section>` key.

Roles: Estimator, Bookkeeper, Dispatcher, Marketer — each section below is written by that role's builder.

## Estimator

## Bookkeeper

## Dispatcher

The Dispatcher runs the schedule around the weather and the crew: it proposes moving jobs when bad weather is coming (the owner OKs the batch), texts customers when the crew is on the way, texts each crew member their next day, and offers freed-up spots to customers booked later. Code: `src/server/services/staff/dispatcher/`. Migration: `20261011120000_staff_dispatcher.sql` (rollback in `supabase/rollback/`).

### What the owner and their customers experience

- **15:00, rain coming tomorrow.** The owner gets one text from the platform number: `#12 Weather: move these 2 jobs? Sam Lee roof repair Thu 9am to Fri 11am (rain 90%, 5 mm); Jo Park gutter cleaning Thu 1pm to Fri 9am (rain 90%, 2.5 mm). Each customer gets: "Hi Sam, it's Northshore Roofing. Rain is in the forecast for your roof repair on Thu Oct 15, so we've moved it to Fri Oct 16, 11:00 a.m. Need a different time? [their booking link]" Reply Y 12 to approve, N 12 to skip.` On **Y** each job moves and each customer gets that text with their own `/v/{manage_token}` link. On **N** nothing happens. Nothing ever moves without the owner's Y.
- **The crew taps "On my way"** on the job sheet. When the Dispatcher will text the customer (setting on, no "On my way" automation), the button asks for an ETA (10 / 20 / 30 / 45 min / 1 hr, or none); otherwise it stays a single tap (house orgs, A1). The customer gets: "Hi Sam, it's Northshore Roofing. Mike from our crew is on the way for your roof repair and should be there in about 20 minutes. See you soon!"
- **18:00 the night before**, each crew member with a cell on file gets: "Northshore Roofing - your jobs tomorrow (Thu Oct 15): 1) 9:00 a.m. - Sam - roof repair - 12 Bay St - https://maps.google.com/?q=…". If their day changes after that in a way that matters for jobs that haven't started (a job added, moved, cancelled, re-assigned, a new address — never a job heading out, starting, finishing or a no-show), they get "Northshore Roofing update - your jobs tomorrow (Thu Oct 15) changed: …", or "…you're no longer on any jobs tomorrow" ("…you have no more jobs today" on the day).
- **A job in the next 48 hours is cancelled or moved away** (from the app, the owner by text, or the customer's own visit page): `Jo Park cancelled Thu 1pm. Offer it to Lee Moss (booked Sat 10am)? They'd get: "Hi Lee, it's Northshore Roofing. A spot opened up on Thu Oct 15, 1:00 p.m., earlier than your chimney flashing on Sat Oct 17, 10:00 a.m. Want it? You can switch here: [their booking link]"`. On Y, Lee gets that text; Lee switches on the visit page (nothing moves on its own). Only gaps the visit page can actually take are offered (see Fill the gap below) — with the default 24-hour change cutoff that means gaps 24–48 hours out.
- **The owner by text:** "what's the weather look like for the jobs this week" (`weather_outlook`), "who's working tomorrow" (`crew_plan`), "rain day, move all of tomorrow to Friday" (`move_day` → a `bulk_reschedule` approval; "Reply Y 14 to move them, N 14 to leave them").
- **House orgs (A1 etc.)** get none of this unless the owner switches it on in Settings → AI front desk → Dispatcher.

### Approval kinds

| Kind | Created by | Summary (owner text, ≤ 500 chars) | Y | N / expiry |
| --- | --- | --- | --- | --- |
| `weather_reschedule` | the daily weather check, ONE per company per local day | every job: who, job, old to new time, forecast reason; jobs with no open time ("left as is"); the exact customer text (with `[their booking link]`) | each job re-checked (still at its old time, not cancelled / en route, new time still open) → `rescheduleBooking` → customer text ("moved" texts may go from 07:00; queued until then if it's late). A job whose text couldn't reach the customer before its old start is left as is ("too late to tell them before Thu 6:30am"). Reply: "Moved 2 jobs: Sam Lee to Fri 11am, Jo Park to Fri 9am. Customers texted." | nothing moves ("OK, nothing moved."). Expires an hour before the first job (max 20h) |
| `bulk_reschedule` | owner tool `move_day` (asked inline: `notified_to` = the owner's phone, so "Y 14" counts straight away) | same shape, "Move 2 jobs from Thu Oct 15 to Mon Oct 19? …" | same as above (bulk wording to customers: "We need to move your … from Thu Oct 15 to Mon Oct 19, 9:00 a.m. Sorry for the change.") | nothing. Expires in 12h |
| `fill_gap` | the gap sweep, one per vacated slot | who cancelled / moved off when, who it's offered to (and their current booking), the exact offer text | re-checks the candidate's booking is unchanged and their visit page can still take the gap → offer text (full CASL consent check — it's an offer) | nothing sent. Expires before the gap passes the change cutoff (max 12h) |

If a summary would pass 500 characters, fewer jobs are included ("(3 more not included - ask me again after.)") and Y only moves the jobs shown. A price note ("Y 12 $700") on these kinds is never acted on (`ok:false`, nothing moved). "Y 12 except Smith" isn't supported (it isn't a valid approval reply; the owner channel asks "did you mean…").

### How it works

- **Location.** `companies.latitude / longitude` (+ `location_source`, `location_checked_at`). Geocoded once (`geocode.ts`): Places API (New) place details with field mask `location` for `google_place_id`, else a text search on `business_address`, else the first town of `service_area` + ", Ontario". A miss is retried after 7 days. Jobs use the company's location (local service areas). The HTTP calls sit behind the `Geocoder` seam.
- **Weather.** `weather.ts`: a `WeatherProvider` interface; `openMeteoProvider` calls the forecast API with `hourly=precipitation_probability,precipitation,wind_speed_10m,temperature_2m`, `timezone=GMT&timeformat=unixtime` (job windows are matched by instant — DST-proof). `OPEN_METEO_API_KEY` set → `customer-api.open-meteo.com` + `apikey`; unset → the free `api.open-meteo.com`. One forecast per company per hour (memory, then `dispatch_weather_cache`, shared across workers).
- **At risk** (`assessWindow`, pure): over the hours the job touches (min 1h): rain = max probability ≥ `rain_probability` (60%) **and** total ≥ `rain_mm` (2 mm); wind ≥ `wind_kmh` (50 km/h); temperature ≤ `min_temp_c` (−25) or ≥ `max_temp_c` (35).
- **Which jobs:** `weather.sensitive` = `"all"` | `"none"` | `[service keys]` (matched on `bookings.service_item_id` → `service_catalog_items.service_key`, or the listed service's label in the job title). Default by trade: the industry pack (roofing, landscaping → all; HVAC/plumbing, property maintenance & snow, marine → none), else words in the business name / CrankLeads business type (paving, painting, decks, fencing, exterior / pressure / window cleaning, gutters, siding, masonry … → all; snow, plumbing, HVAC, electrical, interior … → none). Unknown → none (never move jobs on a guess).
- **Weather check** (`weather-sweep.ts`, sweep every 5 min, at most 8 forecast checks per pass — the rest are picked up next pass; off in production (`NODE_ENV=production`) without `OPEN_METEO_API_KEY`, warned once): from `check_at` (15:00) to 20:00 local, claimed in `dispatch_runs (company, 'weather', local date)` (unique; a failed pass is retried after 30 min). Open jobs (pending/confirmed, nobody en route) in the next 48h that are weather-sensitive and at risk get the first open time (same rules as the owner channel: `scheduling/rules.ts openTimes` over booking windows or hourly online-booking settings, company-wide busy) at least an hour after the job starts, within 14 days, whose own forecast is fine, never a slot already promised to another job in the batch.
- **On our way** (`on-our-way.ts`, every minute): `booking.en_route` activity events from the last 20 minutes. `markEnRoute(ctx, id, { etaMinutes })` now puts the ETA (1–240) on the event; the job-sheet "On my way" button asks for it only when this text will go (`JobSheet.askEta`, from `dispatcherOnOurWayActive`). **No double texts:** if the company has an active `booking.en_route` automation that texts (the `crew-on-the-way` recipe, draft by default), the Dispatcher stays quiet and the recipe texts. One text per booking (`dispatch_messages` key = booking id). Only between 07:00 and 20:00 local (a crew heading out at 06:30 doesn't wake the customer; the event is marked skipped).
- **Crew texts** (`crew-schedule.ts`, every 5 min): crew = `booking_assignments` + task assignees (same as `crew/service.ts`). Tomorrow's list from `crew_texts.time` (18:00) until 21:00; updates for today from 06:00 to 21:00. The first text is keyed `<profile>:<day>`, updates `<profile>:<day>:u<n>`; each stores a fingerprint of the day's non-cancelled jobs (job, time, address, title — done / started / en-route / no-show jobs included with fields that don't change as work happens), so only a meaningful change to a job that hasn't started re-texts; texts list only jobs still to do. The texts already sent for a day are read in one query; only members with jobs or an earlier text that day are looked at. Members with no `phone_e164` are skipped. Sent from the business number (transactional staff texts: no contact, no consent check). "Tomorrow" is the next LOCAL day (`localDayRange`: 23h / 25h across DST).
- **Fill the gap** (`fill-gap.ts`, every 2 min): cancellations (`booking.status_changed` with `metadata_json->>status = cancelled`) and `booking.rescheduled` events from the last 3 hours, filtered server-side to the organizations with the switch on, newest first (200 per type per pass); a move is judged from its event metadata before any booking is read. The vacated slot must start 2–48h from now and the event must really free it (a move to an overlapping time doesn't). **Only what the visit page can take:** the customer switches on their own visit page (`visits/public.ts`), which only shows open times past the change cutoff (`visit_settings.cutoffHours`, default 24; hourly companies also their minimum notice), on its own grid, and only when `allowReschedule` is on — so a gap is offered only when self-serve moves are on, the gap is past that cutoff, the candidate's own visit can still be changed (`visitActions`), and the gap is one of the open times their page would show. Candidate: the soonest booking starting at least an hour after the gap and within 14 days, length within ±max(30 min, 25%) (filtered in the query), a different customer with a textable phone (not opted out), not offered a gap in the last 7 days (sent `gap_offer` rows, or a pending `fill_gap` approval). Claimed per slot in `dispatch_runs (company, 'fill_gap', '<booking>:<start>')`; slots the Dispatcher emptied itself (weather / day moves) are pre-claimed so they're never offered.
- **Sending** (`messages.ts`): every text is a `dispatch_messages` row (unique company + kind + dedupe key) claimed before `deliverMessage` from the company's number. Customer texts wait for `customer_hours` (09:00–20:00 local; "your visit moved" texts from 07:00) — outside them the row is `queued` with `not_before` = the next opening and the `dispatcher:queue` sweep (every minute) claims and sends it (queued → sending, conditional). Before a queued text goes out it is re-checked: the feature is still on (weather moves → weather switch, gap offers → fill gap, crew texts → crew texts; owner-initiated day moves always go), a "moved" text's booking is still open at the announced time, a gap offer's candidate is unchanged and their page can still take the gap — otherwise the row is `skipped` with the reason. "Moved" texts expire at the job's old start. The queue only reads rows of loaded (feature-on, active) companies, so rows of paused companies never block it, and a `sending` row older than 10 minutes (a crashed worker) goes back to the queue. A failed send is retried twice (10 min apart). Crew texts: 06:00–21:00. **Consent:** texts about the customer's own booking (on our way, your visit moved) are transactional — opt-out is always respected, the 6-month implied-consent expiry isn't applied; a gap offer goes through `deliverMessage`'s full consent check (`consentContact`). The STOP footer is automatic. Every customer text names the business, never the platform.

### Owner tools

| Tool | Does |
| --- | --- |
| `weather_outlook` | Next 3 local days: daytime rain chance / mm, wind, temperature, whether it's over the owner's limits, and each open job with `at_risk` (for weather-sensitive jobs). |
| `crew_plan` | A day (default tomorrow) by crew member (with "cell on file"), plus unassigned jobs. |
| `move_day` | `from_date` (today / tomorrow / YYYY-MM-DD) → `to_date`: each open job keeps its time of day if open on the new day, else the next open time that day; jobs that don't fit are listed "left as is". Creates `bulk_reschedule`; the tool returns `tell_owner_exactly` (with the code). |

Prompt notes: the owner agent is told to relay `tell_owner_exactly` word for word and to use `propose_reschedule` for one job; the SMS agent is told customers may reply to these texts, to point them to the booking link in the text (it lets them move), never to say a spot is held, never to move or cancel bookings itself, and to hand off if they're upset.

### Settings

`companies.ai_settings.dispatch`, read only by `staff/dispatcher/settings.ts readDispatchSettings`:

```
dispatch = {
  weather:        { enabled, sensitive: "all" | "none" | [service keys], rain_probability: 60, rain_mm: 2,
                    wind_kmh: 50, min_temp_c: -25, max_temp_c: 35, check_at: "15:00" },
  on_our_way:     { enabled, from: "07:00", until: "20:00" },
  crew_texts:     { enabled, time: "18:00" },        // 06:00–20:59 (crew texts stop at 21:00)
  fill_gap:       { enabled },
  customer_hours: { from: "09:00", until: "20:00" }
}
```

Every `enabled` defaults **on** for CrankLeads orgs and **off** for house orgs. Route: `GET | PATCH /api/organizations/:org/companies/:company/ai-settings/dispatch` (members read; owners/admins PATCH `{ weather?: { enabled, sensitive (null = trade default), rainProbability, rainMm, windKmh, minTempC, maxTempC }, onOurWay?: { enabled }, crewTexts?: { enabled, time }, fillGap?: { enabled } }`, merged into `ai_settings.dispatch` only with the optimistic `updateAiSettings`). UI: `src/components/settings/staff/DispatcherSettingsSection.tsx` — four switches, which jobs weather affects (all / some services / none, or back to the trade default), the limits, the crew text time, how many team members have a cell, and a note when the "On my way" automation is the one texting.

**Crew cells:** `organization_memberships.phone_e164` (E.164, check constraint; service-role writes only). Settings → Members shows each member's cell with **Add / Edit** (`MemberPhoneField`): members edit their own, owners/admins anyone's — except that only an owner can change an owner's number (same rule as roles). Routes: `GET /api/organizations/:org/members/phones` (members), `PUT /api/organizations/:org/members/:profileId/phone { phone: string | null }` (self, or owner/admin — not an owner's number unless you're an owner; 10-digit NANP or +E.164).

### Schema (`20261011120000_staff_dispatcher.sql`)

- `companies`: `latitude`, `longitude`, `location_source`, `location_checked_at` (locked to the service role by the column-grant allowlist).
- `organization_memberships.phone_e164` (+ format check).
- `dispatch_messages` (kind `on_our_way | crew_schedule | crew_update | job_moved | gap_offer`, unique `(company_id, kind, dedupe_key)`, status `queued | sending | sent | skipped | failed | blocked`, `not_before`, `expires_at`, `attempts`, `payload`) — members read, service role writes.
- `dispatch_runs` (kind `weather | fill_gap`, unique `(company_id, kind, run_key)`) — members read, service role writes.
- `dispatch_weather_cache` (one row per company) — service role only.
- No new `activity_events` index: the sweeps filter by `organization_id` + `occurred_at`, which the existing `(organization_id, occurred_at desc)` index serves. A plain CREATE INDEX would lock that big table inside the migration's transaction; if a large database ever needs one, create it by hand with `create index concurrently` (the statement is in the migration's comments).

Table types live in `staff/dispatcher/db-types.ts` until they're merged into `database.types.ts`.

### Env

`GOOGLE_PLACES_API_KEY` (already set for done-for-you; unset → no geocoding → no weather checks for companies without stored coordinates), optional `OPEN_METEO_API_KEY` (commercial Open-Meteo; unset → the free endpoint, which is for non-commercial use — set the key before relying on it in production). No AI model calls (everything is rules), so no `AI_MODEL_DISPATCHER`.

### Sweeps

`dispatcher:on-our-way` (1 min), `dispatcher:queue` (1 min), `dispatcher:fill-gap` (2 min), `dispatcher:crew-texts` (5 min), `dispatcher:weather` (5 min) — through `runStaffSweeps`. The companies are loaded once per tick (cached ~1 minute per worker, `loadDispatchCompaniesCached`) and filtered server-side to feature-on companies: every company of a CrankLeads org, plus house-org companies that switched something on (`ai_settings.dispatch.any_on`, written by `mergeDispatchSettings`); reads page past PostgREST's 1000-row cap. The queue sweep looks at the queue first and loads nothing when nothing is due.

`dispatcherActiveFor(admin, { organizationId, companyId })` (`settings.ts`) says whether any Dispatcher feature is on for a company (for showing the role's prompt notes only where relevant).

### Tests

`src/test/staff-dispatcher.test.ts` (fake DB, real services; Twilio, the weather provider and the geocoder faked): settings defaults (CrankLeads on / house off, trade sensitivity), DST day lengths and local hours for America/Toronto, geocoding fallbacks and retry, Open-Meteo parsing / thresholds / endpoint / hourly cache, the weather check end to end through owner-channel `decideApproval` (one per day, Y moves + texts, idempotent re-run, N, re-checks at Y, late Y queues customer texts until 09:00), on-our-way (ETA on the event, one text, no double with the recipe, opt-out, hours, house org), crew texts across the Nov 1 DST change (25h day, 18:00 EST = 23:00Z, updates only on change, no-phone skip), fill the gap (7-day rule, refilled slot, setting off, re-check at Y), owner tools (`move_day` → Y via `decideApproval`, scoping, `crew_plan`, `weather_outlook`), member cells.

### Not yet

- The commercial Open-Meteo key, Places geocoding and the weather sweep were never run against the live APIs from here.
- "Y 12 except Smith" (partial approval) isn't supported — the owner says N and moves jobs one by one.
- Multi-location businesses use one location for every job (no per-job geocoding).

## Marketer
