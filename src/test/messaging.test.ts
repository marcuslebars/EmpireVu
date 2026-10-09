import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendSms = vi.fn();
const sendEmail = vi.fn();
const emitActivityEventAndDispatch = vi.fn((..._args: unknown[]) =>
  Promise.resolve({ activityEvent: {}, workflowEventJob: null }),
);
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
import { createFakeDb } from "./helpers/fake-supabase";

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
  // org-1 = a tenant (not the house org); org-a1 = the house org (LEAD_INTAKE_ORG_SLUG default
  // a1-group); org-int = an internal-plan org.
  function db(memberships: Array<{ profile_id: string; role: string }> = []) {
    return createFakeDb({
      organizations: [
        { id: "org-1", plan: "operate", slug: "maple-plumbing" },
        { id: "org-a1", plan: "front_desk", slug: "a1-group" },
        { id: "org-int", plan: "internal", slug: "crankleads-house" },
      ],
      organization_memberships: memberships.flatMap((m) => [
        { organization_id: "org-1", ...m },
        { organization_id: "org-a1", ...m },
      ]),
      profiles: [
        { id: "p-owner", email: "owner@maple.test" },
        { id: "p-admin", email: "admin@maple.test" },
        { id: "p-member", email: "member@maple.test" },
      ],
    });
  }
  const ctx = (fake: ReturnType<typeof db>, organizationId: string) =>
    ({ organizationId, actorProfileId: null, supabase: fake.client }) as never;

  it("prefers the company's owner fields", async () => {
    const { context } = fakeContext();
    const owner = await resolveOwnerContacts(context, { owner_email: "co@brand.test", owner_phone_e164: "+17055551212" });
    expect(owner).toEqual({ email: "co@brand.test", phone: "+17055551212" });
  });

  it("never routes a TENANT org's owner mail to the platform OWNER_EMAIL", async () => {
    vi.stubEnv("OWNER_EMAIL", "platform@crankleads.test");
    const fake = db([{ profile_id: "p-admin", role: "admin" }, { profile_id: "p-owner", role: "owner" }, { profile_id: "p-member", role: "member" }]);
    expect((await resolveOwnerContacts(ctx(fake, "org-1"), null)).email).toBe("owner@maple.test"); // owner before admin
    const adminOnly = db([{ profile_id: "p-admin", role: "admin" }, { profile_id: "p-member", role: "member" }]);
    expect((await resolveOwnerContacts(ctx(adminOnly, "org-1"), null)).email).toBe("admin@maple.test");
    const nobody = db([{ profile_id: "p-member", role: "member" }]);
    expect((await resolveOwnerContacts(ctx(nobody, "org-1"), null)).email).toBeNull();
  });

  it("keeps the house org (A1 / internal plan) on OWNER_EMAIL first, as before", async () => {
    vi.stubEnv("OWNER_EMAIL", "env-owner@a1.test");
    const fake = db([{ profile_id: "p-owner", role: "owner" }]);
    expect((await resolveOwnerContacts(ctx(fake, "org-a1"), null)).email).toBe("env-owner@a1.test");
    expect((await resolveOwnerContacts(ctx(fake, "org-int"), null)).email).toBe("env-owner@a1.test");
    // Without OWNER_EMAIL the house org falls back to its owner profile.
    vi.stubEnv("OWNER_EMAIL", "");
    expect((await resolveOwnerContacts(ctx(fake, "org-a1"), null)).email).toBe("owner@maple.test");
  });

  it("skips OWNER_EMAIL entirely when the caller disallows the platform fallback", async () => {
    vi.stubEnv("OWNER_EMAIL", "env-owner@a1.test");
    const fake = db([{ profile_id: "p-owner", role: "owner" }]);
    expect((await resolveOwnerContacts(ctx(fake, "org-a1"), null, { allowPlatformFallback: false })).email).toBe("owner@maple.test");
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

describe("deliverMessage: platform-number opt-out", () => {
  const optedOut = (phone: string, at: string | null) => ({ phone_e164: phone, opted_out_at: at, opted_in_at: null, source_ref: "SM1" });
  const ctxFor = (db: ReturnType<typeof createFakeDb>) => ({ organizationId: "org-1", actorProfileId: null, supabase: db.client }) as never;

  it("a platform text (setup reminder / weekly report / forwarding) to a phone that texted STOP to the platform number is blocked and logged", async () => {
    const db = createFakeDb({ platform_sms_opt_outs: [optedOut("+17055550142", daysAgo(1))] });
    const result = await deliverMessage({
      context: ctxFor(db), channel: "sms", to: "(705) 555-0142", body: "CrankLeads: your week", companyId: "co-1", contactId: null, consentContact: null, smsFrom: "platform",
    });
    expect(result).toMatchObject({ status: "blocked", reason: "platform_opted_out" });
    expect(sendSms).not.toHaveBeenCalled();
    expect(db.tables.message_log?.[0]).toMatchObject({ status: "blocked", error: "platform_opted_out" });
  });

  it("does not block the company number (the opt-out is the platform number's) or a phone that opted back in", async () => {
    const db = createFakeDb({ platform_sms_opt_outs: [optedOut("+17055550142", daysAgo(1)), optedOut("+17055550143", null)] });
    const company = await deliverMessage({ context: ctxFor(db), channel: "sms", to: "+17055550142", body: "New lead", companyId: "co-1", contactId: null, consentContact: null });
    expect(company.status).toBe("sent");
    const back = await deliverMessage({ context: ctxFor(db), channel: "sms", to: "+17055550143", body: "hi", companyId: "co-1", contactId: null, consentContact: null, smsFrom: "platform" });
    expect(back.status).toBe("sent");
    expect(sendSms).toHaveBeenCalledTimes(2);
  });
});
