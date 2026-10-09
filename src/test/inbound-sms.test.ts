import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "@/test/helpers/fake-supabase";

// The router's control flow is what's under test. Writes to contacts/activity/usage go through
// mocked services; the raw reads/writes run against an in-memory fake Supabase.
const createContact = vi.fn((..._a: unknown[]) => Promise.resolve({ id: "c-new", company_id: "co-1", phone: "+17055550123", sms_opt_out_at: null }));
const createActivityEvent = vi.fn((..._a: unknown[]) => Promise.resolve({ id: "evt-1" }));
const emitActivityEventAndDispatch = vi.fn((..._a: unknown[]) => Promise.resolve({ activityEvent: { id: "evt-2" }, workflowEventJob: null }));
const recordUsageSafe = vi.fn((..._a: unknown[]) => Promise.resolve());
const deliverMessage = vi.fn((..._a: unknown[]) => Promise.resolve({ status: "sent", body: "" }));
const sendSms = vi.fn((..._a: unknown[]) => Promise.resolve({ sid: "SMout" }));
const runSmsAgentForInbound = vi.fn((..._a: unknown[]) => Promise.resolve({ replied: false }));
const handleOwnerInboundSms = vi.fn((..._a: unknown[]) => Promise.resolve({ handled: true }));

let db: FakeDb;

vi.mock("@/server/supabase/admin", () => ({ createSupabaseAdminClient: () => db.client }));
vi.mock("@/server/services/contacts", () => ({ createContact: (...a: unknown[]) => createContact(...a) }));
vi.mock("@/server/services/activity-events", () => ({ createActivityEvent: (...a: unknown[]) => createActivityEvent(...a) }));
vi.mock("@/server/services/workflow-engine/dispatch", () => ({
  emitActivityEventAndDispatch: (...a: unknown[]) => emitActivityEventAndDispatch(...a),
}));
vi.mock("@/server/services/usage", () => ({ recordUsageSafe: (...a: unknown[]) => recordUsageSafe(...a), recordAiUsageSafe: vi.fn() }));
vi.mock("@/server/services/workflow-engine/messaging", () => ({
  STOP_FOOTER: "Reply STOP to opt out",
  deliverMessage: (...a: unknown[]) => deliverMessage(...a),
}));
vi.mock("@/server/outbound/sms", () => ({ sendSms: (...a: unknown[]) => sendSms(...a) }));
vi.mock("@/server/services/sms-agent/entry", () => ({ runSmsAgentForInbound: (...a: unknown[]) => runSmsAgentForInbound(...a) }));
vi.mock("@/server/services/owner-channel/entry", () => ({ handleOwnerInboundSms: (...a: unknown[]) => handleOwnerInboundSms(...a) }));

import { classifySmsKeyword, handleInboundSms, readInboundSmsFields } from "@/server/services/twilio/inbound-sms";

const PLATFORM = "+16475550000";
const COMPANY_NUMBER = "+17055551000";
const OWNER = "+17055559999";
const CUSTOMER = "+17055550123";

function seed(extra: Record<string, Array<Record<string, unknown>>> = {}) {
  db = createFakeDb(
    {
      voice_numbers: [{ organization_id: "org-1", company_id: "co-1", phone_e164: COMPANY_NUMBER, provider: "twilio", active: true }],
      companies: [{ id: "co-1", organization_id: "org-1", name: "Northshore Lawn", brand_from_name: null, owner_phone_e164: OWNER, owner_phone_verified_at: "2026-10-01T00:00:00Z", timezone: "America/Toronto" }],
      organizations: [{ id: "org-1", platform_brand: "crankleads" }],
      contacts: [],
      message_log: [],
      owner_command_log: [],
      platform_sms_opt_outs: [],
      ...extra,
    },
    { owner_command_log: [["provider_ref"]], platform_sms_opt_outs: [["phone_e164"]] },
  );
}

const payload = (over: Record<string, string> = {}) => ({ From: CUSTOMER, To: COMPANY_NUMBER, Body: "Hello there", MessageSid: "SM123", ...over });

beforeEach(() => {
  process.env.TWILIO_FROM_NUMBER = PLATFORM;
  for (const fn of [createContact, createActivityEvent, emitActivityEventAndDispatch, recordUsageSafe, deliverMessage, sendSms, runSmsAgentForInbound, handleOwnerInboundSms]) fn.mockClear();
  seed();
});

describe("classifySmsKeyword", () => {
  it("recognizes STOP-family keywords", () => {
    for (const w of ["STOP", "stop", " Stop ", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]) expect(classifySmsKeyword(w)).toBe("stop");
  });
  it("START/UNSTOP are opt-ins; YES/Y are only 'yes' (an opt-in only while opted out)", () => {
    for (const w of ["START", "unstop"]) expect(classifySmsKeyword(w)).toBe("start");
    for (const w of ["yes", "Y", "Yes!"]) expect(classifySmsKeyword(w)).toBe("yes");
  });
  it("HELP/INFO", () => {
    expect(classifySmsKeyword("help")).toBe("help");
    expect(classifySmsKeyword("INFO")).toBe("help");
  });
  it("returns null for ordinary messages (including ones that merely contain a keyword)", () => {
    expect(classifySmsKeyword("Can you stop by tomorrow?")).toBeNull();
    expect(classifySmsKeyword("yes please, and thanks")).toBeNull();
    expect(classifySmsKeyword("")).toBeNull();
  });
});

describe("readInboundSmsFields", () => {
  it("falls back to SmsSid when MessageSid is absent", () => {
    expect(readInboundSmsFields({ From: "+1", To: "+2", Body: "hi", SmsSid: "SM9" }).messageSid).toBe("SM9");
  });
  it("reads MMS media (https only, capped by NumMedia)", () => {
    const f = readInboundSmsFields({
      From: "+1", To: "+2", Body: "", MessageSid: "SM1", NumMedia: "2",
      MediaUrl0: "https://api.twilio.com/m/0", MediaContentType0: "image/jpeg",
      MediaUrl1: "http://insecure/1", MediaContentType1: "image/png",
      MediaUrl2: "https://ignored/2",
    });
    expect(f.media).toEqual([{ url: "https://api.twilio.com/m/0", contentType: "image/jpeg" }]);
  });
});

describe("handleInboundSms — customer on a company number", () => {
  it("matches an existing contact, stores the text, emits, and runs the SMS agent", async () => {
    seed({ contacts: [{ id: "c-1", organization_id: "org-1", company_id: "co-1", phone_last10: "7055550123", phone: CUSTOMER, sms_opt_out_at: null }] });
    await handleInboundSms(payload());

    expect(createContact).not.toHaveBeenCalled();
    expect(db.tables.message_log[0]).toMatchObject({ direction: "inbound", provider: "twilio", provider_ref: "SM123", contact_id: "c-1", media: null });
    expect(recordUsageSafe).toHaveBeenCalledWith(expect.objectContaining({ kind: "sms_received" }));
    expect(emitActivityEventAndDispatch).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: "contact.sms_received" }));
    expect(runSmsAgentForInbound).toHaveBeenCalledWith(
      db.client,
      expect.objectContaining({ organizationId: "org-1", companyId: "co-1", contactId: "c-1", body: "Hello there", messageLogId: db.tables.message_log[0].id }),
    );
  });

  it("stores MMS media on message_log and hands it to the agent", async () => {
    await handleInboundSms(payload({ Body: "here's the yard", NumMedia: "1", MediaUrl0: "https://api.twilio.com/x.jpg", MediaContentType0: "image/jpeg" }));
    expect(db.tables.message_log[0].media).toEqual([{ url: "https://api.twilio.com/x.jpg", contentType: "image/jpeg" }]);
    expect(runSmsAgentForInbound).toHaveBeenCalledWith(db.client, expect.objectContaining({ media: [{ url: "https://api.twilio.com/x.jpg", contentType: "image/jpeg" }] }));
  });

  it("creates a contact with consent_source='inbound_sms' when none matches", async () => {
    await handleInboundSms(payload());
    expect(createContact).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ companyId: "co-1", phone: CUSTOMER, consentSource: "inbound_sms" }),
      expect.objectContaining({ dispatchWorkflow: false }),
    );
  });

  it("an agent failure never fails the job", async () => {
    runSmsAgentForInbound.mockRejectedValueOnce(new Error("boom"));
    await expect(handleInboundSms(payload())).resolves.toBeUndefined();
    expect(db.tables.message_log).toHaveLength(1);
  });

  it("STOP sets opt-out and does NOT emit or run the agent", async () => {
    seed({ contacts: [{ id: "c-1", organization_id: "org-1", company_id: "co-1", phone_last10: "7055550123", sms_opt_out_at: null }] });
    await handleInboundSms(payload({ Body: "STOP" }));
    expect(db.tables.contacts[0].sms_opt_out_at).toBeTruthy();
    expect(createActivityEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: "contact.sms_opted_out" }));
    expect(emitActivityEventAndDispatch).not.toHaveBeenCalled();
    expect(runSmsAgentForInbound).not.toHaveBeenCalled();
  });

  it("START clears opt-out and sets consent", async () => {
    seed({ contacts: [{ id: "c-1", organization_id: "org-1", company_id: "co-1", phone_last10: "7055550123", sms_opt_out_at: "2026-10-01T00:00:00Z" }] });
    await handleInboundSms(payload({ Body: "START" }));
    expect(db.tables.contacts[0].sms_opt_out_at).toBeNull();
    expect(db.tables.contacts[0].sms_consent_at).toBeTruthy();
    expect(createActivityEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: "contact.sms_opted_in" }));
    expect(emitActivityEventAndDispatch).not.toHaveBeenCalled();
  });

  it("YES from an opted-in customer is an answer, not an opt-in (the old bug)", async () => {
    seed({ contacts: [{ id: "c-1", organization_id: "org-1", company_id: "co-1", phone_last10: "7055550123", sms_opt_out_at: null }] });
    await handleInboundSms(payload({ Body: "Yes" }));
    expect(createActivityEvent).not.toHaveBeenCalled();
    expect(emitActivityEventAndDispatch).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: "contact.sms_received" }));
    expect(runSmsAgentForInbound).toHaveBeenCalledWith(db.client, expect.objectContaining({ body: "Yes" }));
  });

  it("YES from an opted-out customer re-opts them in", async () => {
    seed({ contacts: [{ id: "c-1", organization_id: "org-1", company_id: "co-1", phone_last10: "7055550123", sms_opt_out_at: "2026-10-01T00:00:00Z" }] });
    await handleInboundSms(payload({ Body: "Y" }));
    expect(db.tables.contacts[0].sms_opt_out_at).toBeNull();
    expect(runSmsAgentForInbound).not.toHaveBeenCalled();
  });

  it("HELP replies with the business name + STOP line, at most once a day", async () => {
    seed({ contacts: [{ id: "c-1", organization_id: "org-1", company_id: "co-1", phone_last10: "7055550123", phone: CUSTOMER, sms_opt_out_at: null }] });
    const seen = new Set<string>();
    db.onRpc((name, args) => {
      if (name !== "consume_rate_limit") return { data: null, error: null };
      const key = String(args.p_key);
      const ok = !seen.has(key);
      seen.add(key);
      return { data: ok, error: null };
    });
    await handleInboundSms(payload({ Body: "HELP" }));
    await handleInboundSms(payload({ Body: "help", MessageSid: "SM124" }));
    expect(deliverMessage).toHaveBeenCalledTimes(1);
    const sent = deliverMessage.mock.calls[0][0] as { body: string; to: string; consentContact: unknown };
    expect(sent.body).toContain("Northshore Lawn");
    expect(sent.body).toContain("Reply STOP to opt out");
    expect(sent.to).toBe(CUSTOMER);
    expect(sent.consentContact).toBeNull();
    expect(runSmsAgentForInbound).not.toHaveBeenCalled();
  });

  it("is idempotent — a MessageSid already logged is a no-op", async () => {
    seed({ message_log: [{ id: "m0", provider: "twilio", provider_ref: "SM123" }] });
    await handleInboundSms(payload());
    expect(db.tables.message_log).toHaveLength(1);
    expect(emitActivityEventAndDispatch).not.toHaveBeenCalled();
    expect(recordUsageSafe).not.toHaveBeenCalled();
    expect(runSmsAgentForInbound).not.toHaveBeenCalled();
  });

  it("throws when a non-platform number isn't mapped to a tenant", async () => {
    seed({ voice_numbers: [] });
    await expect(handleInboundSms(payload())).rejects.toThrow(/voice_numbers/);
  });
});

describe("handleInboundSms — the owner on their own company number", () => {
  it("goes to the owner channel: no contact, no message_log customer row, no customer relay", async () => {
    await handleInboundSms(payload({ From: OWNER, Body: "Y" }));
    expect(handleOwnerInboundSms).toHaveBeenCalledWith(
      db.client,
      expect.objectContaining({ from: OWNER, body: "Y", companyId: "co-1", viaPlatformNumber: false, providerRef: "SM123" }),
    );
    expect(createContact).not.toHaveBeenCalled();
    expect(db.tables.message_log).toHaveLength(0);
    expect(emitActivityEventAndDispatch).not.toHaveBeenCalled();
    expect(runSmsAgentForInbound).not.toHaveBeenCalled();
  });

  it("matches the owner on the last 10 digits", async () => {
    await handleInboundSms(payload({ From: "17055559999", Body: "what's on tomorrow" }));
    expect(handleOwnerInboundSms).toHaveBeenCalledTimes(1);
  });
});

describe("handleInboundSms — the platform number", () => {
  it("an owner texting the platform number → owner channel (no voice_numbers row needed)", async () => {
    await handleInboundSms(payload({ From: OWNER, To: PLATFORM, Body: "N 2" }));
    expect(handleOwnerInboundSms).toHaveBeenCalledWith(
      db.client,
      expect.objectContaining({ from: OWNER, viaPlatformNumber: true, companyId: null, body: "N 2" }),
    );
    expect(db.tables.message_log).toHaveLength(0);
  });

  it("an unknown sender is logged and gets one short reply, then silence", async () => {
    const seen = new Set<string>();
    db.onRpc((_name, args) => {
      const key = String(args.p_key);
      const ok = !seen.has(key);
      seen.add(key);
      return { data: ok, error: null };
    });
    await handleInboundSms(payload({ To: PLATFORM, Body: "hi is this the plumber?" }));
    await handleInboundSms(payload({ To: PLATFORM, Body: "hello??", MessageSid: "SM999" }));
    expect(handleOwnerInboundSms).not.toHaveBeenCalled();
    expect(db.tables.owner_command_log.map((r) => r.intent)).toEqual(["unknown_sender", "unknown_sender"]);
    expect(sendSms).toHaveBeenCalledTimes(1);
    expect((sendSms.mock.calls[0][0] as { body: string }).body).toMatch(/account owners/);
    expect(createContact).not.toHaveBeenCalled();
  });

  it("STOP records a platform opt-out (and START clears it); later platform texts are suppressed", async () => {
    await handleInboundSms(payload({ From: OWNER, To: PLATFORM, Body: "STOP" }));
    expect(db.tables.platform_sms_opt_outs[0]).toMatchObject({ phone_e164: OWNER });
    expect(db.tables.platform_sms_opt_outs[0].opted_out_at).toBeTruthy();
    expect(handleOwnerInboundSms).not.toHaveBeenCalled();

    // HELP while opted out: an owner gets help via sendOwnerSms, which respects the opt-out.
    await handleInboundSms(payload({ From: OWNER, To: PLATFORM, Body: "HELP", MessageSid: "SM2" }));
    expect(deliverMessage).not.toHaveBeenCalled();

    // "Yes" while opted out = opt back in.
    await handleInboundSms(payload({ From: OWNER, To: PLATFORM, Body: "yes", MessageSid: "SM3" }));
    expect(db.tables.platform_sms_opt_outs[0].opted_out_at).toBeNull();
    expect(handleOwnerInboundSms).not.toHaveBeenCalled();
  });

  it("HELP from an owner gets the short help text from the platform number", async () => {
    await handleInboundSms(payload({ From: OWNER, To: PLATFORM, Body: "HELP" }));
    expect(deliverMessage).toHaveBeenCalledTimes(1);
    const sent = deliverMessage.mock.calls[0][0] as { body: string; smsFrom: string; to: string };
    expect(sent.smsFrom).toBe("platform");
    expect(sent.to).toBe(OWNER);
    expect(sent.body).toMatch(/^CrankLeads: /);
    expect(sent.body).toMatch(/STOP/);
    expect(sent.body).not.toMatch(/EmpireVu/);
  });

  it("is idempotent on MessageSid", async () => {
    await handleInboundSms(payload({ To: PLATFORM, Body: "STOP" }));
    await handleInboundSms(payload({ To: PLATFORM, Body: "STOP" }));
    expect(db.tables.owner_command_log).toHaveLength(1);
  });
});
