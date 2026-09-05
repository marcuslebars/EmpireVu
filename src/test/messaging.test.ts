import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendSms = vi.fn();
const sendEmail = vi.fn();
const emitActivityEventAndDispatch = vi.fn(() => Promise.resolve({ activityEvent: {}, workflowEventJob: null }));
vi.mock("@/server/outbound/sms", () => ({ sendSms: (...a: unknown[]) => sendSms(...a) }));
vi.mock("@/server/outbound/email", () => ({ sendEmail: (...a: unknown[]) => sendEmail(...a) }));
vi.mock("@/server/services/usage", () => ({ recordUsageSafe: () => Promise.resolve() }));
vi.mock("@/server/services/workflow-engine/dispatch", () => ({
  emitActivityEventAndDispatch: (...a: unknown[]) => emitActivityEventAndDispatch(...a),
}));

import {
  checkConsent,
  deliverMessage,
  resolveOwnerContacts,
  STOP_FOOTER,
  type ConsentContact,
} from "@/server/services/workflow-engine/messaging";

const NOW = Date.parse("2026-09-15T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();

function consent(over: Partial<ConsentContact>): ConsentContact {
  return { sms_opt_out_at: null, email_opt_out_at: null, sms_consent_at: daysAgo(10), consent_source: "implied_inquiry", ...over };
}

// A fake context whose message_log.from() records inserts and answers the "first SMS?" query.
function fakeContext(opts: { priorSms?: boolean; ownerEmail?: string | null } = {}) {
  const messageLogInserts: Array<Record<string, unknown>> = [];
  const supabase = {
    from(table: string) {
      if (table === "message_log") {
        const api = {
          insert(row: Record<string, unknown>) {
            messageLogInserts.push(row);
            return Promise.resolve({ error: null });
          },
          select() {
            return api;
          },
          eq() {
            return api;
          },
          limit() {
            return Promise.resolve({ data: opts.priorSms ? [{ id: "m1" }] : [], error: null });
          },
        };
        return api;
      }
      if (table === "organization_memberships") {
        const api = {
          select: () => api,
          eq: () => api,
          limit: () => api,
          maybeSingle: () => Promise.resolve({ data: { profile_id: "owner-1" }, error: null }),
        };
        return api;
      }
      if (table === "profiles") {
        const api = {
          select: () => api,
          eq: () => api,
          maybeSingle: () => Promise.resolve({ data: { email: opts.ownerEmail ?? "owner@org.test" }, error: null }),
        };
        return api;
      }
      const api = { select: () => api, eq: () => api, limit: () => Promise.resolve({ data: [], error: null }), maybeSingle: () => Promise.resolve({ data: null, error: null }) };
      return api;
    },
  };
  return { context: { organizationId: "org-1", actorProfileId: null, supabase } as never, messageLogInserts };
}

beforeEach(() => {
  sendSms.mockReset().mockResolvedValue({ sid: "SM123" });
  sendEmail.mockReset().mockResolvedValue({ id: "re_123" });
  emitActivityEventAndDispatch.mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("checkConsent", () => {
  it("refuses an opted-out contact", () => {
    expect(checkConsent(consent({ sms_opt_out_at: daysAgo(1) }), "sms", NOW)).toEqual({ ok: false, reason: "opted_out" });
    expect(checkConsent(consent({ email_opt_out_at: daysAgo(1) }), "email", NOW)).toEqual({ ok: false, reason: "opted_out" });
  });
  it("refuses when there is no recorded consent", () => {
    expect(checkConsent(consent({ sms_consent_at: null, consent_source: null }), "sms", NOW)).toEqual({ ok: false, reason: "no_consent" });
  });
  it("refuses implied consent older than 6 months", () => {
    expect(checkConsent(consent({ sms_consent_at: daysAgo(200) }), "sms", NOW)).toEqual({ ok: false, reason: "consent_expired" });
  });
  it("allows fresh implied consent, and express consent never expires", () => {
    expect(checkConsent(consent({ sms_consent_at: daysAgo(10) }), "sms", NOW)).toEqual({ ok: true });
    expect(checkConsent(consent({ sms_consent_at: daysAgo(400), consent_source: "express" }), "sms", NOW)).toEqual({ ok: true });
  });
});

describe("resolveOwnerContacts", () => {
  it("prefers the company's owner fields", async () => {
    const { context } = fakeContext();
    const owner = await resolveOwnerContacts(context, { owner_email: "co@brand.test", owner_phone_e164: "+17055551212" });
    expect(owner).toEqual({ email: "co@brand.test", phone: "+17055551212" });
  });
  it("falls back to OWNER_EMAIL, then the org owner profile", async () => {
    vi.stubEnv("OWNER_EMAIL", "env-owner@org.test");
    const { context } = fakeContext();
    expect((await resolveOwnerContacts(context, null)).email).toBe("env-owner@org.test");

    vi.unstubAllEnvs();
    const fresh = fakeContext({ ownerEmail: "profile-owner@org.test" });
    expect((await resolveOwnerContacts(fresh.context, null)).email).toBe("profile-owner@org.test");
  });
});

describe("deliverMessage", () => {
  it("blocks (and logs) an opted-out contact without sending", async () => {
    const { context, messageLogInserts } = fakeContext();
    const result = await deliverMessage({
      context, channel: "sms", to: "+17055550188", body: "hi", companyId: "co-1", contactId: "c-1",
      consentContact: consent({ sms_opt_out_at: daysAgo(1) }),
    });
    expect(result.status).toBe("blocked");
    expect(sendSms).not.toHaveBeenCalled();
    expect(messageLogInserts[0]).toMatchObject({ status: "blocked", error: "opted_out", channel: "sms" });
  });

  it("sends, logs 'sent', and emits an emit-only activity event (loop-safe)", async () => {
    const { context, messageLogInserts } = fakeContext();
    const result = await deliverMessage({
      context, channel: "sms", to: "+17055550188", body: "Hi Jane", companyId: "co-1", contactId: "c-1",
      consentContact: consent({}),
    });
    expect(result.status).toBe("sent");
    expect(sendSms).toHaveBeenCalledTimes(1);
    expect(messageLogInserts.at(-1)).toMatchObject({ status: "sent", provider_ref: "SM123", channel: "sms" });
    // Loop prevention: the contact.sms_sent event is emitted with emitOnly.
    expect(emitActivityEventAndDispatch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: "contact.sms_sent" }),
      { emitOnly: true },
    );
  });

  it("appends the STOP footer to the first SMS to a contact", async () => {
    const { context } = fakeContext({ priorSms: false });
    await deliverMessage({ context, channel: "sms", to: "+1", body: "First hello", companyId: "co-1", contactId: "c-1", consentContact: consent({}) });
    expect(sendSms.mock.calls[0][0].body).toContain(STOP_FOOTER);
  });

  it("does NOT append the footer once the contact has prior SMS", async () => {
    const { context } = fakeContext({ priorSms: true });
    await deliverMessage({ context, channel: "sms", to: "+1", body: "Second hello", companyId: "co-1", contactId: "c-1", consentContact: consent({}) });
    expect(sendSms.mock.calls[0][0].body).not.toContain(STOP_FOOTER);
  });

  it("logs 'failed' when the provider throws", async () => {
    sendSms.mockRejectedValue(new Error("Twilio 400"));
    const { context, messageLogInserts } = fakeContext();
    const result = await deliverMessage({ context, channel: "sms", to: "+1", body: "hi", companyId: "co-1", contactId: "c-1", consentContact: consent({}) });
    expect(result.status).toBe("failed");
    expect(messageLogInserts.at(-1)).toMatchObject({ status: "failed", error: "Twilio 400" });
  });

  it("blocks with no_recipient when the address is missing", async () => {
    const { context, messageLogInserts } = fakeContext();
    const result = await deliverMessage({ context, channel: "sms", to: null, body: "hi", companyId: "co-1", contactId: "c-1", consentContact: null });
    expect(result.status).toBe("blocked");
    expect(sendSms).not.toHaveBeenCalled();
    expect(messageLogInserts[0]).toMatchObject({ status: "blocked", error: "no_recipient" });
  });
});
