-- Call recordings: capture the Retell recording URL on retell_calls so owners can play
-- back the Marina <-> lead call from inside EmpireVu (alongside the already-stored
-- transcript / transcript_object). Additive, nullable. Retell puts `recording_url` on the
-- post-call payload; it is now written to this column on ingest. Rows ingested before this
-- migration still carry it inside raw_payload, so the read path coalesces
-- `recording_url` with `raw_payload->>'recording_url'` — no backfill required.
alter table public.retell_calls add column if not exists recording_url text;
