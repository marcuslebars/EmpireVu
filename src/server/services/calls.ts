import type { Json, Tables } from "@/server/db/database.types";
import { assertContactInOrganization, type TenantServiceContext } from "@/server/services/shared";

/**
 * Read model for a contact's Marina calls — recording playback + transcript, shown on the
 * contact page. Reads `retell_calls` directly (it carries a `retell_calls_org_members_select`
 * RLS policy, so the caller only sees their org's rows) and the server also filters by
 * organization_id, matching the other read paths.
 */

export interface CallTranscriptSegment {
  role: string; // "agent" | "user" (or whatever Retell labelled the speaker)
  content: string;
}

export interface ContactCall {
  id: string;
  callId: string;
  direction: string | null;
  startedAt: string | null;
  durationSeconds: number | null;
  summary: string | null;
  sentiment: string | null;
  inVoicemail: boolean;
  recordingUrl: string | null;
  transcript: string | null;
  segments: CallTranscriptSegment[];
}

function asRecord(value: Json | null | undefined): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * Retell's `transcript_object` is an array of turns — usually `{ role, content }`, sometimes
 * `{ speaker, text }`. Normalize defensively to `{ role, content }`, dropping empty turns.
 * Pure + unit-tested.
 */
export function normalizeTranscriptSegments(transcriptObject: Json | null | undefined): CallTranscriptSegment[] {
  if (!Array.isArray(transcriptObject)) return [];
  const segments: CallTranscriptSegment[] = [];
  for (const raw of transcriptObject) {
    const turn = asRecord(raw as Json);
    const role = typeof turn.role === "string" ? turn.role : typeof turn.speaker === "string" ? turn.speaker : "";
    const contentValue = turn.content ?? turn.text ?? turn.message;
    const content = typeof contentValue === "string" ? contentValue.trim() : "";
    if (content) segments.push({ role, content });
  }
  return segments;
}

/** New rows carry recording_url in the column; older rows keep it inside raw_payload. */
export function recordingUrlFromRow(
  row: Pick<Tables<"retell_calls">, "recording_url" | "raw_payload">,
): string | null {
  if (row.recording_url) return row.recording_url;
  const payload = asRecord(row.raw_payload);
  const direct = payload.recording_url;
  if (typeof direct === "string" && direct) return direct;
  const call = asRecord(payload.call as Json);
  const nested = call.recording_url;
  return typeof nested === "string" && nested ? nested : null;
}

export async function listContactCalls(
  context: TenantServiceContext,
  contactId: string,
): Promise<ContactCall[]> {
  await assertContactInOrganization(context, contactId);

  const { data, error } = await context.supabase
    .from("retell_calls")
    .select("*")
    .eq("organization_id", context.organizationId)
    .eq("contact_id", contactId)
    .order("received_at", { ascending: false })
    .limit(200);
  if (error) {
    throw error;
  }

  const rows = (data ?? []) as Tables<"retell_calls">[];
  return rows.map((row) => ({
    id: row.id,
    callId: row.call_id,
    direction: row.direction,
    startedAt: row.start_timestamp ?? row.received_at ?? row.created_at,
    durationSeconds: row.duration_ms != null ? Math.round(row.duration_ms / 1000) : null,
    summary: row.call_summary,
    sentiment: row.user_sentiment,
    inVoicemail: row.in_voicemail ?? false,
    recordingUrl: recordingUrlFromRow(row),
    transcript: row.transcript,
    segments: normalizeTranscriptSegments(row.transcript_object),
  }));
}
