import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "./fake-supabase";

// After an AI-answered catcher call: the Retell webhook ingest (tenant ONLY from signed
// metadata), the owner alert (urgent path), ONE follow-up text instead of the generic
// text-back, and the SMS conversation seed. Twilio/Resend are mocked at deliverMessage.
const h = vi.hoisted(() => ({
  db: null as FakeDb | null,
  sent: [] as Array<Record<string, unknown>>,
  sendStatus: "sent" as "sent" | "failed" | "blocked",
  intake: [] as Array<{ envelope: Record<string, unknown>; options: Record<string, unknown> }>,
  dispatches: [] as Array<{ eventType: unknown; emitOnly: boolean }>,
}));

vi.mock("@/server/supabase/admin", () => ({ createSupabaseAdminClient: () => h.db?.client }));
vi.mock("@/server/services/workflow-engine/messaging", () => ({
  deliverMessage: async (input: Record<string, unknown>) => {
    h.sent.push(input);
    return { status: h.sendStatus, body: String(input.body) };
  },
  resolveOwnerContacts: async (_ctx: unknown, company: { owner_email: string | null; owner_phone_e164: string | null } | null) => ({
    email: company?.owner_email ?? null,
    phone: company?.owner_phone_e164 ?? null,
  }),
}));
vi.mock("@/server/services/lead-intake/intake", () => ({
  handleLeadIntake: (_raw: string, envelope: Record<string, unknown>, options: Record<string, unknown>) => {
    h.intake.push({ envelope, options });
    h.db!.tables.raw_leads ??= [];
    h.db!.tables.raw_leads.push({ lead_id: "lead_1", contact_id: CONTACT });
    return Promise.resolve({ ok: true, leadId: "lead_1" });
  },
}));
vi.mock("@/server/services/workflow-engine/dispatch", () => ({
  emitActivityEventAndDispatch: (_ctx: unknown, input: Record<string, unknown>, options?: Record<string, unknown>) => {
    h.dispatches.push({ eventType: input.eventType, emitOnly: Boolean(options?.emitOnly) });
    return Promise.resolve({ activityEvent: { id: "ev" }, workflowEventJob: null });
  },
}));

import { ingestRetellCall, type RetellCallFields } from "@/server/services/retell/lead-adapter";
import { buildAnswerMetadata, signAnswerToken } from "@/server/services/voice/ai-answer";
import { buildFollowUpText, handleAnsweredCall, readAnswerDetails, runUrgentAlert } from "@/server/services/voice/post-call";

const ORG = "11111111-1111-4111-8111-111111111111";
const COMPANY = "22222222-2222-4222-8222-222222222222";
const OTHER_ORG = "33333333-3333-4333-8333-333333333333";
const OTHER_COMPANY = "44444444-4444-4444-8444-444444444444";
const CONTACT = "55555555-5555-4555-8555-555555555555";
const SECRET = "fn-secret";
const CALLER = "+17055550123";
const OWNER = "+17055550111";

const env = { ...process.env };
afterAll(() => {
  process.env = env;
});

function seed(row: Record<string, unknown> = {}, contact: Record<string, unknown> = {}): FakeDb {
  return createFakeDb({
    companies: [
      {
        id: COMPANY,
        organization_id: ORG,
        name: "Northshore Plumbing",
        slug: "northshore",
        owner_phone_e164: OWNER,
        owner_email: "dana@northshore.test",
        quote_public_base_url: "https://quotes.northshore.test",
        online_booking_settings: {},
      },
      { id: OTHER_COMPANY, organization_id: OTHER_ORG, name: "Other Co", slug: "other", owner_phone_e164: "+14165550000", owner_email: "x@other.test" },
    ],
    contacts: [{ id: CONTACT, organization_id: ORG, phone: CALLER, first_name: "Jamie", sms_opt_out_at: null, ...contact }],
    missed_calls: [
      {
        id: "mc-1",
        call_sid: "CA0001",
        organization_id: ORG,
        company_id: COMPANY,
        from_number: CALLER,
        text_back_status: "ai_pending",
        ai_handoff_at: "2026-10-09T15:00:00.000Z",
        owner_alerted_at: null,
        ai_followup_at: null,
        ai_urgent_alerted_at: null,
        contact_id: null,
        lead_id: null,
        ...row,
      },
    ],
    message_log: [],
    sms_conversations: [],
    retell_calls: [],
    activity_events: [],
  });
}

const tenant = { organizationId: ORG, companyId: COMPANY, callSid: "CA0001", agentKind: "message" as const };

function fields(custom: Record<string, unknown>, over: Partial<RetellCallFields> = {}): RetellCallFields {
  return {
    callId: "call_abc",
    agentId: "agent_message",
    direction: "inbound",
    fromNumber: CALLER,
    toNumber: "+17055550100",
    transcript: "…",
    transcriptObject: null,
    recordingUrl: null,
    callSummary: "Jamie has a leaking kitchen tap in Barrie and wants a callback this afternoon.",
    userSentiment: null,
    callSuccessful: true,
    inVoicemail: false,
    callAnalysis: null,
    customAnalysisData: custom,
    event: "call_analyzed",
    metadata: null,
    durationMs: 95_000,
    startTimestamp: null,
    endTimestamp: null,
    callCostCents: null,
    costBreakdown: null,
    name: (custom.caller_name as string) ?? null,
    email: null,
    boatMakeModel: null,
    boatLengthFt: null,
    boatType: null,
    engineType: null,
    engineCount: null,
    boatLocation: null,
    onTrailer: null,
    servicesRequested: [],
    urgent: custom.is_urgent === true,
    ...over,
  };
}

const deps = { send: async (input: Record<string, unknown>) => { h.sent.push(input); return { status: h.sendStatus, body: String(input.body) }; }, now: () => new Date("2026-10-09T15:05:00Z") };

beforeEach(() => {
  h.db = seed();
  h.sent = [];
  h.sendStatus = "sent";
  h.intake = [];
  h.dispatches = [];
  process.env.RETELL_FUNCTION_SECRET = SECRET;
  delete process.env.VOICE_AI_TOKEN_SECRET;
  process.env.RETELL_INTAKE_ENABLED = "1";
  process.env.RETELL_API_KEY = "key_test";
});

const db = () => h.db!;
const toCaller = () => h.sent.filter((m) => m.to === CALLER);
const toOwner = () => h.sent.filter((m) => m.to === OWNER || m.to === "dana@northshore.test");

describe("handleAnsweredCall", () => {
  const callback = { caller_name: "Jamie Lee", job_description: "leaking kitchen tap", service_address: "Barrie", urgency: "normal", callback_requested: true, callback_time: "this afternoon" };

  it("ONE follow-up text from the company number, an owner summary, and the conversation seeded", async () => {
    const outcome = await handleAnsweredCall(db().client as never, { tenant, fields: fields(callback), leadId: "lead_1", contactId: CONTACT }, deps as never);
    expect(outcome).toMatchObject({ status: "handled", followUp: "sent", ownerAlerted: true, conversationSeeded: true });
    expect(db().tables.missed_calls[0]).toMatchObject({ text_back_status: "ai_handled", contact_id: CONTACT, lead_id: "lead_1" });

    expect(toCaller()).toHaveLength(1);
    // sent_by "voice_agent": the inbox labels it Assistant and the texting AI reads it as its own words.
    expect(toCaller()[0]).toMatchObject({ channel: "sms", companyId: COMPANY, contactId: CONTACT, sentBy: "voice_agent" });
    expect(String(toCaller()[0].body)).toBe(
      "Hi Jamie, thanks for calling Northshore Plumbing. We got your message about leaking kitchen tap — someone will call you back this afternoon. Reply here if anything changes.",
    );
    expect(String(toCaller()[0].body)).not.toMatch(/sorry we missed/i);

    const ownerSms = toOwner().filter((m) => m.channel === "sms");
    expect(ownerSms).toHaveLength(1);
    expect(String(ownerSms[0].body)).toContain("Your AI assistant took a call for Northshore Plumbing: Jamie Lee · 705-555-0123.");
    expect(String(ownerSms[0].body)).toContain("Wants a callback this afternoon.");
    expect(String(ownerSms[0].body)).toContain("We texted them to follow up.");
    expect(toOwner().filter((m) => m.channel === "email")).toHaveLength(0); // not urgent, SMS went

    const convo = db().tables.sms_conversations[0];
    expect(convo).toMatchObject({ organization_id: ORG, company_id: COMPANY, contact_id: CONTACT, state: "ai" });
    expect(convo.collected).toMatchObject({ name: "Jamie Lee", job: "leaking kitchen tap", address: "Barrie", callback_requested: true, source: "phone_call", last_call_id: "call_abc" });
    expect(String(convo.summary)).toContain("Phone call 2026-10-09 (AI answered)");
  });

  it("a retry (webhook redelivery) sends nothing twice", async () => {
    await handleAnsweredCall(db().client as never, { tenant, fields: fields(callback), leadId: "lead_1", contactId: CONTACT }, deps as never);
    const before = h.sent.length;
    const again = await handleAnsweredCall(db().client as never, { tenant, fields: fields(callback), leadId: "lead_1", contactId: CONTACT }, deps as never);
    expect(h.sent.length).toBe(before);
    expect(again.followUp).toBe("already_done");
    expect(db().tables.sms_conversations).toHaveLength(1);
  });

  it("urgent → owner SMS + email flagged, caller told it's flagged", async () => {
    const urgent = { caller_name: "Sam", job_description: "burst pipe flooding basement", service_address: "12 Bay St, Orillia", urgency: "emergency", is_urgent: true };
    await handleAnsweredCall(db().client as never, { tenant, fields: fields(urgent), leadId: "lead_1", contactId: CONTACT }, deps as never);
    const sms = toOwner().find((m) => m.channel === "sms")!;
    expect(String(sms.body)).toMatch(/^🚨 EMERGENCY call for Northshore Plumbing: Sam · 705-555-0123\. burst pipe flooding basement — 12 Bay St, Orillia\./);
    expect(String(sms.body)).toContain("Call them back now.");
    const email = toOwner().find((m) => m.channel === "email")!;
    expect(String(email.subject)).toMatch(/^🚨 Urgent/);
    expect(String(toCaller()[0].body)).toContain("flagged this as urgent");
  });

  it("booking-link callers get the link", async () => {
    await handleAnsweredCall(
      db().client as never,
      { tenant, fields: fields({ caller_name: "Ana", job_description: "furnace tune-up", booking_link_requested: true }), leadId: "lead_1", contactId: CONTACT },
      deps as never,
    );
    expect(String(toCaller()[0].body)).toBe(
      `Hi Ana, thanks for calling Northshore Plumbing! Here's our booking link to pick a time: https://quotes.northshore.test/book/${COMPANY} — or just reply here with any questions.`,
    );
  });

  it("opted-out caller / 'don't text me' → no follow-up text (owner still alerted)", async () => {
    h.db = seed({}, { sms_opt_out_at: "2026-01-01T00:00:00Z" });
    const optedOut = await handleAnsweredCall(db().client as never, { tenant, fields: fields(callback), leadId: "lead_1", contactId: CONTACT }, deps as never);
    expect(optedOut.followUp).toBe("skipped");
    expect(toCaller()).toHaveLength(0);
    expect(toOwner().length).toBeGreaterThan(0);

    h.db = seed();
    h.sent = [];
    const noText = await handleAnsweredCall(db().client as never, { tenant, fields: fields({ ...callback, do_not_text: true }), leadId: "lead_1", contactId: CONTACT }, deps as never);
    expect(noText.followUp).toBe("skipped");
    expect(toCaller()).toHaveLength(0);
  });

  it("the call was already released to the generic text-back (watchdog / failed leg) → no second text", async () => {
    h.db = seed({ text_back_status: "emitted" });
    const outcome = await handleAnsweredCall(db().client as never, { tenant, fields: fields(callback), leadId: "lead_1", contactId: CONTACT }, deps as never);
    expect(outcome).toMatchObject({ status: "released_earlier", followUp: "not_ours" });
    expect(toCaller()).toHaveLength(0);
    expect(db().tables.missed_calls[0].text_back_status).toBe("emitted");
  });

  it("the receptionist already texted them during the call (quote link) → no extra follow-up", async () => {
    db().tables.message_log.push({ id: "m1", organization_id: ORG, contact_id: CONTACT, channel: "sms", direction: "outbound", created_at: "2026-10-09T15:02:00.000Z" });
    const outcome = await handleAnsweredCall(db().client as never, { tenant, fields: fields(callback), leadId: "lead_1", contactId: CONTACT }, deps as never);
    expect(outcome.followUp).toBe("skipped");
    expect(toCaller()).toHaveLength(0);
  });

  it("merges into an existing conversation without clobbering what the texting AI collected", async () => {
    db().tables.sms_conversations.push({ id: "conv-1", organization_id: ORG, company_id: COMPANY, contact_id: CONTACT, state: "owner", collected: { name: "Jamie L.", photos: 2 }, summary: "Texted about a tap." });
    await handleAnsweredCall(db().client as never, { tenant, fields: fields(callback), leadId: "lead_1", contactId: CONTACT }, deps as never);
    const convo = db().tables.sms_conversations[0];
    expect(convo.state).toBe("owner");
    expect(convo.collected).toMatchObject({ name: "Jamie L.", photos: 2, job: "leaking kitchen tap", last_call_id: "call_abc" });
    expect(String(convo.summary)).toMatch(/^Texted about a tap\.\nPhone call/);
  });
});

describe("follow-up copy", () => {
  it("never names the platform and falls back to a 'couldn't finish' text for a hang-up", () => {
    const text = buildFollowUpText({
      companyName: "Northshore Plumbing",
      details: readAnswerDetails({ customAnalysisData: {}, callSummary: null, urgent: false, name: null, servicesRequested: [] }),
      bookingUrl: "https://b.test/book/x",
      tookMessage: false,
    });
    expect(text).toBe("Hi there, it's Northshore Plumbing — sorry we couldn't finish your call. Book here: https://b.test/book/x or reply and we'll call you back.");
    expect(text).not.toMatch(/EmpireVu|CrankLeads/);
  });
});

describe("runUrgentAlert (mid-call alert_owner tool)", () => {
  it("alerts the owner right away, once per call", async () => {
    const first = await runUrgentAlert(db().client as never, { tenant, args: { what: "gas smell in the basement", address: "Orillia" }, fromNumber: CALLER }, deps as never);
    expect(first.ok).toBe(true);
    expect(String(toOwner().find((m) => m.channel === "sms")!.body)).toBe(
      "🚨 URGENT call right now for Northshore Plumbing: 705-555-0123 — gas smell in the basement at Orillia. Call them back now.",
    );
    const count = h.sent.length;
    const second = await runUrgentAlert(db().client as never, { tenant, args: { what: "gas" }, fromNumber: CALLER }, deps as never);
    expect(second.ok).toBe(true);
    expect(h.sent.length).toBe(count);
  });

  it("a failed send releases the claim and says so honestly", async () => {
    h.sendStatus = "failed";
    const result = await runUrgentAlert(db().client as never, { tenant, args: { what: "flood" }, fromNumber: CALLER }, deps as never);
    expect(result.ok).toBe(false);
    expect(result.say).toMatch(/9-1-1/);
    expect(db().tables.missed_calls[0].ai_urgent_alerted_at).toBeNull();
  });
});

describe("ingestRetellCall for an AI-answered catcher call", () => {
  const claims = { organizationId: ORG, companyId: COMPANY, callSid: "CA0001" };
  const payload = (metadata: Record<string, unknown>) => ({
    event: "call_analyzed",
    call: {
      call_id: "call_abc",
      agent_id: "agent_message",
      direction: "inbound",
      from_number: CALLER,
      to_number: "+17055550100",
      duration_ms: 95_000,
      metadata,
      call_analysis: {
        call_summary: "Jamie has a leaking tap.",
        call_successful: true,
        custom_analysis_data: { caller_name: "Jamie Lee", job_description: "leaking tap", callback_requested: true },
      },
    },
  });

  it("verified metadata → lead filed for THAT tenant, call.* recorded emit-only (no generic text-back), follow-up + owner alert", async () => {
    const result = await ingestRetellCall(payload({ ...buildAnswerMetadata(claims, "message", SECRET) }));
    expect(result).toMatchObject({ handled: "inbound", leadId: "lead_1" });
    expect(h.intake[0].options).toMatchObject({ target: { organizationId: ORG, companyId: COMPANY } });
    expect(db().tables.retell_calls[0]).toMatchObject({ call_id: "call_abc", organization_id: ORG, company_id: COMPANY });
    // Minutes metered against the company.
    expect(db().tables.usage_events[0]).toMatchObject({ organization_id: ORG, company_id: COMPANY, kind: "voice_minutes", provider_ref: "call_abc" });
    expect(h.dispatches).toEqual([{ eventType: "call.completed", emitOnly: true }]);
    expect(toCaller()).toHaveLength(1);
    expect(toOwner().length).toBeGreaterThan(0);
    expect(db().tables.missed_calls[0].text_back_status).toBe("ai_handled");
  });

  it("metadata naming another tenant with a forged token → no lead, no texts, stored without a tenant", async () => {
    const forged = { source: "catcher_ai", organization_id: OTHER_ORG, company_id: OTHER_COMPANY, twilio_call_sid: "CA0001", agent_kind: "message", token: signAnswerToken(claims, SECRET) };
    const result = await ingestRetellCall(payload(forged));
    expect(result.handled).toBe("skipped");
    expect(h.intake).toHaveLength(0);
    expect(h.sent).toHaveLength(0);
    expect(db().tables.retell_calls[0]).toMatchObject({ call_id: "call_abc", organization_id: null, company_id: null });
  });

  it("a token signed with the wrong secret is refused the same way", async () => {
    const result = await ingestRetellCall(payload({ ...buildAnswerMetadata(claims, "message", "not-our-secret") }));
    expect(result.handled).toBe("skipped");
    expect(h.sent).toHaveLength(0);
  });
});
