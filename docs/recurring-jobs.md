# Recurring jobs

Repeat work on a schedule — a weekly clean, a monthly service, a yearly inspection.

## Setup (once)

Run `supabase/migrations/20261004180000_recurring_jobs.sql` in the SQL editor
(rollback: `supabase/rollback/20261004180000_recurring_jobs.down.sql`). It needs the
crew-dispatch migration (`20261004170000`) first. Visits beyond the first ~60 days are
added by the existing **[worker]** scheduler pass (hourly; no new service or env). The
same sweep also runs in `job:quote-maintenance` if that cron is deployed.

## How it works

- A **series** (`recurring_jobs`) holds the customer, job, location, length, the rule
  (every N weeks on chosen weekdays / every N months on the start date's day / every N
  years), start date + local time, an optional end (date or number of visits), the
  usual crew, a saved checklist, and a price per visit.
- Each **visit** is an ordinary booking (`recurring_job_id` + `occurrence_date`, unique),
  so the calendar, My Jobs, reminders, crew alerts, double-booking checks and
  job-done → invoice all work unchanged. Visits are created as `confirmed`, with the crew
  assigned and the checklist copied in.
- **How far ahead**: ~60 days, and always at least the next visit (so a yearly job is
  on the calendar). Saving a series lays them out immediately; the daily sweep
  (`services/recurring/sweep.ts`, service role, each series pinned to its own org; run hourly by the worker) tops
  them up. Generation is idempotent.
- **No "booked" texts per visit**: generated visits don't fire `booking.created`.
  `booking.upcoming` reminders still go out before each visit if that automation is on.
- **Editing / pausing / ending** removes upcoming visits nobody has touched and re-lays
  them. Kept as they are: visits moved by hand (`recurrence_exception`), started, on the
  way, done or cancelled. Ended series can't be resumed.
- **Invoicing**: when a visit is invoiced (by hand or by "When a job is marked done"),
  the series' price lines are used; a series with no price gives a $0 draft + a task.
- Times are wall-clock in the brand's time zone, so 9:00 stays 9:00 across DST.

## Known limits

- No "2nd Tuesday of the month" style rules yet (monthly repeats on a date).
- Editing a series doesn't change past or already-moved visits.
