import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "./fake-supabase";

const h = vi.hoisted(() => ({
  db: null as FakeDb | null,
  intakeCalls: [] as Array<{ envelope: Record<string, unknown>; options: unknown }>,
  dispatches: [] as Array<{ input: Record<string, unknown>; options: Record<string, unknown> | undefined }>,
  activities: [] as Array<Record<string, unknown>>,
  emails: [] as Array<Record<string, unknown>>,
  leadCounter: 0,
  emailFailures: 0,
}));

vi.mock("@/server/supabase/admin", () => ({ createSupabaseAdminClient: () => h.db?.client }));

// The SAME lead intake a form / Retell call uses — mocked to what it durably produces:
// a raw_leads row linked to a (matched or new) contact.
vi.mock("@/server/services/lead-intake/intake", () => ({
  handleLeadIntake: (_raw: string, envelope: Record<string, unknown>, options: unknown) => {
    h.intakeCalls.push({ envelope, options });
    const leadId = `lead_${++h.leadCounter}`;
    const tables = h.db!.tables;
    tables.raw_leads ??= [];
    tables.raw_leads.push({ lead_id: leadId, contact_id: "contact-1" });
    return Promise.resolve({ ok: true, leadId });
  },
}));

function recordActivity(input: Record<string, unknown>) {
  const row = {
    id: `evt-${h.activities.length + 1}`,
    organization_id: "org-1",
    event_type: input.eventType,
    entity_type: input.entityType,
    entity_id: input.entityId,
    metadata_json: input.metadata,
  };
  h.activities.push(row);
  const tables = h.db!.tables;
  tables.activity_events ??= [];
  tables.activity_events.push(row);
  return row;
}

vi.mock("@/server/services/workflow-engine/dispatch", () => ({
  emitActivityEventAndDispatch: (_ctx: unknown, input: Record<string, unknown>, options?: Record<string, unknown>) => {
    h.dispatches.push({ input, options });
    const activityEvent = recordActivity(input);
    const enqueued = !options?.emitOnly;
    return Promise.resolve({ activityEvent, workflowEventJob: enqueued ? { id: `job-${h.dispatches.length}` } : null });
  },
}));
vi.mock("@/server/services/activity-events", () => ({
  createActivityEvent: (_ctx: unknown, input: Record<string, unknown>) => Promise.resolve(recordActivity(input)),
}));
vi.mock("@/server/services/workflow-engine/messaging", () => ({
  resolveOwnerContacts: () => Promise.resolve({ email: "owner@muskoka.test", phone: null }),
  deliverMessage: (input: Record<string, unknown>) => {
    if (h.emailFailures > 0) {
      h.emailFailures -= 1;
      return Promise.reject(new Error("resend down"));
    }
    h.emails.push(input);
    return Promise.resolve({ status: "sent", body: input.body });
  },
}));

import {
  buildMissedCallLeadEnvelope,
  buildVoicemailOwnerAlert,
  handleMissedCall,
  handleVoicemail,
  isAnonymousCaller,
  playableRecordingUrl,
  readInboundVoiceFields,
} from "@/server/services/twilio/missed-call";

const ORG = "org-1";
const COMPANY = "co-1";
const CATCHER = "+17055550100";
const env = { ...process.env };
afterAll(() => {
  process.env = env;
});

function seed(): FakeDb {
  return createFakeDb({
    voice_numbers: [
      { id: "vn-1", organization_id: ORG, company_id: COMPANY, phone_e164: CATCHER, provider: "twilio", mode: "missed_call_catcher", active: true, brand_label: null },
      // An AI-receptionist number must NOT resolve as a catcher.
      { id: "vn-2", organization_id: ORG, company_id: COMPANY, phone_e164: "+17055550200", provider: "retell", mode: "ai_receptionist", active: true, brand_label: null },
    ],
    companies: [{ id: COMPANY, organization_id: ORG, name: "Muskoka Plumbing", slug: "muskoka-plumbing", owner_email: null, owner_phone_e164: null }],
    missed_calls: [],
    activity_events: [],
    raw_leads: [],
  });
}

const call = (over: Record<string, string> = {}) => ({
  CallSid: "CA1",
  From: "+17055550123",
  To: CATCHER,
  ForwardedFrom: "+17055559999",
  CallStatus: "ringing",
  ...over,
});

const db = (): FakeDb => h.db!;
const NOW = Date.parse("2026-10-02T14:00:00.000Z");

beforeEach(() => {
  h.db = seed();
  h.intakeCalls.length = 0;
  h.dispatches.length = 0;
  h.activities.length = 0;
  h.emails.length = 0;
  h.leadCounter = 0;
  h.emailFailures = 0;
  process.env.APP_BASE_URL = "https://app.crankleads.test";
  delete process.env.MISSED_CALL_TEXTBACK_WINDOW_MINUTES;
  delete process.env.MISSED_CALL_TRANSCRIBE;
});

describe("payload helpers", () => {
  it("reads the original caller from From and the business line from ForwardedFrom", () => {
    expect(readInboundVoiceFields(call())).toMatchObject({ callSid: "CA1", from: "+17055550123", to: CATCHER, forwardedFrom: "+17055559999" });
  });

  it("treats withheld caller ids as anonymous", () => {
    for (const from of [null, "anonymous", "Restricted", "+266696687", "+2562533", "12"]) {
      expect(isAnonymousCaller(from)).toBe(true);
    }
    expect(isAnonymousCaller("+17055550123")).toBe(false);
  });

  it("builds a phone-lead envelope pinned to nothing but the caller's phone", () => {
    expect(buildMissedCallLeadEnvelope(readInboundVoiceFields(call()), { companySlug: "muskoka-plumbing" }, "2026-10-02T14:00:00.000Z")).toEqual({
      schemaVersion: 1,
      source: "missed_call_catcher",
      sourceSite: "muskoka-plumbing",
      formType: "phone-lead",
      receivedAt: "2026-10-02T14:00:00.000Z",
      contact: { phone: "+17055550123" },
      message:
        "Missed call from +17055550123 (forwarded from +17055559999). Caught by the missed-call catcher — an automatic text-back goes out if the missed-call text-back automation is on.",
      meta: { site: "missed-call-catcher" },
    });
  });

  it("makes Twilio recording urls browser-playable", () => {
    expect(playableRecordingUrl("https://api.twilio.com/x/Recordings/RE1")).toBe("https://api.twilio.com/x/Recordings/RE1.mp3");
    expect(playableRecordingUrl("https://x/RE1.mp3")).toBe("https://x/RE1.mp3");
    expect(playableRecordingUrl(null)).toBeNull();
  });
});

describe("handleMissedCall", () => {
  it("resolves the tenant by the CALLED number, runs the shared lead intake, and enqueues call.missed on the contact", async () => {
    const result = await handleMissedCall(call(), NOW);

    expect(result).toEqual({ status: "emitted", contactId: "contact-1", leadId: "lead_1" });
    expect(h.intakeCalls).toHaveLength(1);
    expect(h.intakeCalls[0].options).toEqual({ target: { organizationId: ORG, companyId: COMPANY } });

    expect(h.dispatches).toHaveLength(1);
    const { input, options } = h.dispatches[0];
    expect(input).toMatchObject({
      companyId: COMPANY,
      entityType: "contact",
      entityId: "contact-1",
      eventType: "call.missed",
      metadata: { callId: "CA1", source: "missed_call_catcher", contactId: "contact-1", textBackSuppressed: false },
    });
    expect(options).toEqual({}); // a real dispatch → workflow_event_jobs → text-back recipe

    const row = db().tables.missed_calls[0];
    expect(row).toMatchObject({
      organization_id: ORG,
      company_id: COMPANY,
      call_sid: "CA1",
      from_number: "+17055550123",
      to_number: CATCHER,
      forwarded_from: "+17055559999",
      caller_phone_last10: "7055550123",
      contact_id: "contact-1",
      lead_id: "lead_1",
      text_back_status: "emitted",
    });
  });

  it("marks textBackActive only when an active call.missed workflow texts the contact", async () => {
    await handleMissedCall(call({ CallSid: "CA1" }), NOW);
    expect(h.dispatches[0].input).toMatchObject({ metadata: { textBackActive: false } });

    db().tables.workflows = [
      {
        organization_id: ORG, company_id: COMPANY, trigger_event: "call.missed", status: "active",
        definition: { actions: [{ type: "send_sms", to: "contact", body: "Hi" }] },
      },
    ];
    await handleMissedCall(call({ CallSid: "CA9", From: "+17055550777" }), NOW);
    expect(h.dispatches[1].input).toMatchObject({ metadata: { textBackActive: true } });
  });

  it("emits call.missed exactly once per CallSid (job retry / redelivery)", async () => {
    await handleMissedCall(call(), NOW);
    const second = await handleMissedCall(call(), NOW);

    expect(second.status).toBe("duplicate");
    expect(h.dispatches).toHaveLength(1);
    expect(h.intakeCalls).toHaveLength(1);
    expect(db().tables.missed_calls).toHaveLength(1);
  });

  it("a retry after a partial run (lead linked, emit failed) does not re-run intake and emits once", async () => {
    // Simulate: first attempt created the row + lead, then died before emitting.
    db().tables.missed_calls.push({
      id: "mc-1", organization_id: ORG, company_id: COMPANY, call_sid: "CA1", caller_phone_last10: "7055550123",
      contact_id: "contact-1", lead_id: "lead_x", text_back_status: "pending", created_at: new Date(NOW).toISOString(),
    });
    const result = await handleMissedCall(call(), NOW);
    expect(result).toMatchObject({ status: "emitted", leadId: "lead_x" });
    expect(h.intakeCalls).toHaveLength(0);
    expect(h.dispatches).toHaveLength(1);
  });

  it("throttles: the same caller inside the window gets no second text-back or lead", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW); // the first row's created_at (the DB's now())
    await handleMissedCall(call({ CallSid: "CA1" }), NOW);
    vi.useRealTimers();
    const second = await handleMissedCall(call({ CallSid: "CA2" }), NOW + 3 * 60_000);

    expect(second).toEqual({ status: "suppressed", contactId: "contact-1", leadId: "lead_1" });
    expect(h.intakeCalls).toHaveLength(1);
    expect(h.dispatches).toHaveLength(2);
    // Recorded on the timeline, but emit-only → no workflow → no second SMS.
    expect(h.dispatches[1].options).toEqual({ emitOnly: true });
    expect(h.dispatches[1].input).toMatchObject({ eventType: "call.missed", metadata: { callId: "CA2", textBackSuppressed: true } });
    expect(db().tables.missed_calls.find((r) => r.call_sid === "CA2")?.text_back_status).toBe("suppressed");
  });

  it("texts back again once the window has passed (window configurable)", async () => {
    process.env.MISSED_CALL_TEXTBACK_WINDOW_MINUTES = "5";
    // An earlier, emitted call from the same caller 6 minutes ago.
    db().tables.missed_calls.push({
      id: "mc-old", organization_id: ORG, company_id: COMPANY, call_sid: "CA0", caller_phone_last10: "7055550123",
      contact_id: "contact-1", lead_id: "lead_old", text_back_status: "emitted", created_at: new Date(NOW - 6 * 60_000).toISOString(),
    });
    const result = await handleMissedCall(call(), NOW);
    expect(result.status).toBe("emitted");
    expect(h.dispatches[0].options).toEqual({});
  });

  it("a withheld caller id: timeline/push on the company, no lead, no text-back", async () => {
    const result = await handleMissedCall(call({ From: "anonymous" }), NOW);
    expect(result.status).toBe("anonymous");
    expect(h.intakeCalls).toHaveLength(0);
    expect(h.dispatches).toHaveLength(0);
    expect(h.activities).toHaveLength(1);
    expect(h.activities[0]).toMatchObject({ event_type: "call.missed", entity_type: "company", entity_id: COMPANY });
  });

  it("an unknown called number (or an AI-receptionist number) throws so the job dead-letters for ops", async () => {
    await expect(handleMissedCall(call({ To: "+16475550000" }), NOW)).rejects.toThrow(/No active missed-call catcher number/);
    await expect(handleMissedCall(call({ To: "+17055550200" }), NOW)).rejects.toThrow(/No active missed-call catcher number/);
    expect(db().tables.missed_calls).toHaveLength(0);
  });
});

describe("handleVoicemail", () => {
  const recording = (over: Record<string, string> = {}) => ({
    CallSid: "CA1",
    RecordingSid: "RE1",
    RecordingUrl: "https://api.twilio.com/2010-04-01/Accounts/AC1/Recordings/RE1",
    RecordingDuration: "14",
    RecordingStatus: "completed",
    ...over,
  });

  it("throws (→ retry) when the call itself hasn't been processed yet", async () => {
    await expect(handleVoicemail(recording())).rejects.toThrow(/No missed_calls row/);
  });

  it("stores the recording, adds a call.voicemail activity on the contact and emails the owner — once", async () => {
    await handleMissedCall(call(), NOW);
    h.activities.length = 0;

    await handleVoicemail(recording());
    await handleVoicemail(recording()); // the action + status callback race → no double

    const row = db().tables.missed_calls[0];
    expect(row).toMatchObject({
      recording_sid: "RE1",
      recording_url: "https://api.twilio.com/2010-04-01/Accounts/AC1/Recordings/RE1.mp3",
      recording_duration_seconds: 14,
    });
    expect(row.voicemail_at).toBeTruthy();
    expect(row.owner_alerted_at).toBeTruthy();

    expect(h.activities).toHaveLength(1);
    expect(h.activities[0]).toMatchObject({
      event_type: "call.voicemail",
      entity_type: "contact",
      entity_id: "contact-1",
      metadata_json: { callId: "CA1", recordingUrl: row.recording_url, durationSeconds: 14 },
    });

    expect(h.emails).toHaveLength(1);
    expect(h.emails[0]).toMatchObject({ channel: "email", to: "owner@muskoka.test", consentContact: null, companyId: COMPANY });
    expect(String(h.emails[0].subject)).toBe("Voicemail from +17055550123 — Muskoka Plumbing");
    const body = String(h.emails[0].body);
    // Links to the app's contact page — never the raw (bearer) Twilio recording URL.
    expect(body).toContain("Listen and call back: https://app.crankleads.test/crm/contact-1");
    expect(body).not.toContain("api.twilio.com");
    // No SMS in message_log → it must not claim a text went out.
    expect(body).toContain("No automatic text went out");
  });

  it("says the caller was texted back only when an SMS was actually sent", async () => {
    await handleMissedCall(call(), NOW);
    db().tables.message_log = [
      {
        organization_id: ORG, contact_id: "contact-1", channel: "sms", direction: "outbound", status: "sent",
        created_at: new Date(Date.now() + 1000).toISOString(),
      },
    ];
    await handleVoicemail(recording());
    expect(String(h.emails[0].body)).toContain("We already texted them back automatically.");
  });

  it("a 0–1s recording (hang-up) is stored but doesn't alert", async () => {
    await handleMissedCall(call(), NOW);
    h.activities.length = 0;
    await handleVoicemail(recording({ RecordingDuration: "1" }));
    expect(h.activities).toHaveLength(0);
    expect(h.emails).toHaveLength(0);
  });

  it("with transcription on, the owner email waits for — and includes — the transcript (and a fallback is queued)", async () => {
    process.env.MISSED_CALL_TRANSCRIBE = "true";
    await handleMissedCall(call(), NOW);
    await handleVoicemail(recording());
    expect(h.emails).toHaveLength(0);
    const fallback = db().tables.inbound_webhook_jobs.find((j) => j.external_id === "alert:RE1");
    expect(fallback).toMatchObject({ provider: "twilio_voicemail", status: "pending", payload: { CallSid: "CA1", AlertFallback: "true" } });
    expect(Date.parse(String(fallback?.run_at))).toBeGreaterThan(Date.now() + 5 * 60_000);

    await handleVoicemail({ CallSid: "CA1", TranscriptionSid: "TR1", TranscriptionStatus: "completed", TranscriptionText: "Hi, my furnace is out." });
    expect(db().tables.missed_calls[0]).toMatchObject({ transcription_sid: "TR1", transcription_text: "Hi, my furnace is out." });
    expect(h.activities.some((a) => a.event_type === "call.voicemail_transcribed")).toBe(true);
    expect(h.emails).toHaveLength(1);
    expect(String(h.emails[0].body)).toContain('"Hi, my furnace is out."');

    // The fallback job then runs: already alerted → nothing more.
    await handleVoicemail(fallback?.payload);
    expect(h.emails).toHaveLength(1);
  });

  it("transcript never arrives → the fallback job sends the alert (once)", async () => {
    process.env.MISSED_CALL_TRANSCRIBE = "true";
    await handleMissedCall(call(), NOW);
    await handleVoicemail(recording());
    await handleVoicemail({ CallSid: "CA1", AlertFallback: "true" });
    await handleVoicemail({ CallSid: "CA1", AlertFallback: "true" });
    expect(h.emails).toHaveLength(1);
    expect(String(h.emails[0].body)).toContain("No transcript");
  });

  it("a transcription that arrives before its recording throws (retryable) instead of losing the alert", async () => {
    process.env.MISSED_CALL_TRANSCRIBE = "true";
    await handleMissedCall(call(), NOW);
    await expect(
      handleVoicemail({ CallSid: "CA1", TranscriptionSid: "TR1", TranscriptionStatus: "completed", TranscriptionText: "Hello" }),
    ).rejects.toThrow(/before its recording/);
    expect(h.emails).toHaveLength(0);
  });

  it("a recording longer than Twilio's 120s transcription limit alerts immediately even with transcription on", async () => {
    process.env.MISSED_CALL_TRANSCRIBE = "true";
    await handleMissedCall(call(), NOW);
    await handleVoicemail(recording({ RecordingDuration: "150" }));
    expect(h.emails).toHaveLength(1);
    expect((db().tables.inbound_webhook_jobs ?? []).some((j) => j.external_id === "alert:RE1")).toBe(false);
  });

  it("a failing owner alert never fails the job, and releases the claim so the fallback can resend", async () => {
    await handleMissedCall(call(), NOW);
    h.emailFailures = 1;
    await expect(handleVoicemail(recording())).resolves.toBeUndefined();
    const row = db().tables.missed_calls[0];
    expect(row.recording_sid).toBe("RE1");
    expect(row.owner_alerted_at).toBeNull();

    await handleVoicemail({ CallSid: "CA1", AlertFallback: "true" });
    expect(h.emails).toHaveLength(1);
  });
});

describe("buildVoicemailOwnerAlert", () => {
  it("names the caller, links to the app, and explains a withheld number", () => {
    const alert = buildVoicemailOwnerAlert({
      companyName: null,
      callerNumber: null,
      appUrl: "https://app.crankleads.test/",
      durationSeconds: 9,
      transcript: null,
      textBackStatus: "anonymous",
      textedBack: false,
    });
    expect(alert.subject).toBe("Voicemail from a private number");
    expect(alert.body).toContain("New voicemail from a private number (9s).");
    expect(alert.body).toContain("Listen and call back: https://app.crankleads.test/");
    expect(alert.body).toContain("caller ID was withheld");
  });
});

