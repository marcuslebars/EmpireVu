# Crew & job dispatch

Put crew on a job, give them a checklist, and let them run the job from their phone.

## Setup (once)

1. Run `supabase/migrations/20261004170000_crew_dispatch.sql` in the SQL editor
   (rollback: `supabase/rollback/20261004170000_crew_dispatch.down.sql`).
2. Invite crew in Settings → Members (role **member**). They sign in on their phone's
   browser and open **My Jobs**.
3. Optional: Settings → **Job checklists** — save one per type of job.
4. Optional: Automations → Recipes → **"On my way" text to the customer** (draft).

## How it works

- **Crew** = `booking_assignments` (any number per job) plus anyone assigned one of the
  job's tasks (the older, implicit crew). The calendar, conflict alerts and My Jobs all
  use both.
- **Assigning** (calendar booking panel or the job sheet) emails the people just added
  and pushes to the mobile app if they have it. Adding yourself doesn't notify you.
  `booking.crew_changed` re-runs the double-booking check.
- **My Jobs** (`/jobs`): today, tomorrow and the next two weeks, plus earlier jobs that
  were never finished. Owners/admins can switch to *Everyone* to dispatch; jobs with no
  crew are flagged.
- **Job sheet** (`/jobs/:id`): customer (tap to call/text), location with directions,
  notes, crew, checklist, photos, and the field steps:
  - *On my way* → `bookings.en_route_at`, fires `booking.en_route` (once per job)
  - *Start job* → `bookings.started_at`
  - *Mark done* → refuses (409) while checklist items are open unless confirmed, then
    sets `completed_at/by` and runs the normal completion path (review request,
    job-done → invoice, etc.).
- **Checklists**: `booking_checklist_items` per job; `checklist_templates` per company
  (owners/admins edit). Applying a template skips items already on the job. Max 50.
- **Photos** reuse the mobile app's private `job-photos` bucket; the web resizes to
  2048px JPEG (which also strips GPS/EXIF) before uploading to a signed URL.

## Known limits

- Members can see every job (RLS is org-wide, as with bookings); My Jobs is a focus
  view, not a permission boundary.
- No offline mode on the web (the native app has an offline photo queue).
- The native app doesn't show checklists yet.
