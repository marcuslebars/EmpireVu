import { describe, expect, it } from "vitest";

import {
  listContactCalls,
  normalizeTranscriptSegments,
  recordingUrlFromRow,
} from "@/server/services/calls";
import type { TenantServiceContext } from "@/server/services/shared";

// ── Transcript normalization ─────────────────────────────────────────────────

describe("normalizeTranscriptSegments", () => {
  it("maps {role, content} turns and drops empty ones", () => {
    expect(
      normalizeTranscriptSegments([
        { role: "agent", content: "Hi, this is Marina." },
        { role: "user", content: "  " }, // whitespace only → dropped
        { role: "user", content: "I need a quote." },
      ]),
    ).toEqual([
      { role: "agent", content: "Hi, this is Marina." },
      { role: "user", content: "I need a quote." },
    ]);
  });

  it("falls back to {speaker, text} shape", () => {
    expect(normalizeTranscriptSegments([{ speaker: "agent", text: "Hello" }])).toEqual([
      { role: "agent", content: "Hello" },
    ]);
  });

  it("returns [] for a non-array / null transcript object", () => {
    expect(normalizeTranscriptSegments(null)).toEqual([]);
    expect(normalizeTranscriptSegments({} as never)).toEqual([]);
  });
});

// ── Recording URL fallback ───────────────────────────────────────────────────

describe("recordingUrlFromRow", () => {
  it("prefers the column", () => {
    expect(recordingUrlFromRow({ recording_url: "https://rec/col.mp3", raw_payload: {} })).toBe("https://rec/col.mp3");
  });
  it("falls back to raw_payload.recording_url (older rows)", () => {
    expect(recordingUrlFromRow({ recording_url: null, raw_payload: { recording_url: "https://rec/raw.mp3" } })).toBe(
      "https://rec/raw.mp3",
    );
  });
  it("falls back to raw_payload.call.recording_url (full-payload rows)", () => {
    expect(
      recordingUrlFromRow({ recording_url: null, raw_payload: { call: { recording_url: "https://rec/nested.mp3" } } }),
    ).toBe("https://rec/nested.mp3");
  });
  it("returns null when there is no recording anywhere", () => {
    expect(recordingUrlFromRow({ recording_url: null, raw_payload: {} })).toBeNull();
  });
});

// ── Service mapping (mocked supabase) ────────────────────────────────────────

function makeContext(retellRows: Array<Record<string, unknown>>): TenantServiceContext {
  function chain(result: unknown) {
    const p: Record<string, unknown> = {};
    for (const method of ["select", "eq", "order", "limit"]) p[method] = () => p;
    p.maybeSingle = () => Promise.resolve(result);
    p.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej);
    return p;
  }
  const supabase = {
    from(table: string) {
      if (table === "contacts") return chain({ data: { id: "c-1" }, error: null });
      if (table === "missed_calls") return chain({ data: [], error: null });
      return chain({ data: retellRows, error: null });
    },
  };
  return { organizationId: "org-1", actorProfileId: null, supabase: supabase as unknown as TenantServiceContext["supabase"] };
}

describe("listContactCalls", () => {
  it("maps retell rows to the ContactCall shape, incl. duration + recording fallback + segments", async () => {
    const context = makeContext([
      {
        id: "call-1",
        call_id: "retell_1",
        direction: "inbound",
        start_timestamp: "2026-09-24T14:00:00.000Z",
        received_at: "2026-09-24T14:00:05.000Z",
        created_at: "2026-09-24T14:00:06.000Z",
        duration_ms: 65_000,
        call_summary: "Booked a detail for Saturday.",
        user_sentiment: "positive",
        in_voicemail: false,
        recording_url: null,
        raw_payload: { recording_url: "https://rec/raw.mp3" },
        transcript: "Agent: Hi\nUser: Hello",
        transcript_object: [{ role: "agent", content: "Hi" }],
      },
    ]);

    const calls = await listContactCalls(context, "c-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      id: "call-1",
      callId: "retell_1",
      direction: "inbound",
      startedAt: "2026-09-24T14:00:00.000Z", // prefers start_timestamp
      durationSeconds: 65,
      summary: "Booked a detail for Saturday.",
      sentiment: "positive",
      inVoicemail: false,
      recordingUrl: "https://rec/raw.mp3", // fell back to raw_payload
      transcript: "Agent: Hi\nUser: Hello",
      segments: [{ role: "agent", content: "Hi" }],
    });
  });
});
