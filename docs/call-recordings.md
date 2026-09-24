# Call recordings & transcripts

Owners can play back the recording of a Marina ↔ lead call and read its transcript from
inside EmpireVu — on the contact page, under the **Calls** tab.

## Data

`retell_calls` already stored the transcript (`transcript` text + `transcript_object` turns).
The recording URL is now captured too:

- **Migration** `supabase/migrations/20260924120000_call_recording_url.sql` adds
  `retell_calls.recording_url text` (nullable, additive).
- **Ingestion** ([`retell/lead-adapter.ts`](../src/server/services/retell/lead-adapter.ts))
  reads `recording_url` off the Retell post-call payload and writes it on upsert.
- **Older rows** ingested before the column keep the URL inside `raw_payload`, so the read
  path (`recordingUrlFromRow`) coalesces `recording_url` → `raw_payload.recording_url` →
  `raw_payload.call.recording_url`. No backfill needed.

## Read path

- **Service** [`calls.ts`](../src/server/services/calls.ts): `listContactCalls(context,
  contactId)` selects `retell_calls` for the org + contact (the table's
  `retell_calls_org_members_select` RLS scopes it; the query also filters `organization_id`),
  newest first, and maps each row to `{ id, direction, startedAt, durationSeconds, summary,
  sentiment, inVoicemail, recordingUrl, transcript, segments }`. `normalizeTranscriptSegments`
  turns Retell's `transcript_object` into `{ role, content }` turns (both pure + unit-tested).
- **Route** `GET /api/organizations/:orgId/contacts/:contactId/calls`.
- **UI** [`CallRecordings.tsx`](../src/components/contact/CallRecordings.tsx): per-call card
  with an `<audio controls>` player and a collapsible transcript, in the contact's **Calls**
  tab.

No new env vars. The recording URL is served by Retell; EmpireVu stores and links to it.
