/**
 * CASL consent extension (docs/ai-staff.md → "Marketer"): a purchase relationship (completed job
 * or paid invoice) gives implied consent for 2 years from the latest purchase; an inquiry stays
 * at 6 months; express consent never expires; an opt-out always wins. Callers that don't pass a
 * purchase date (reviews, recipes, the SMS agent) behave exactly as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendSms = vi.fn((..._a: unknown[]) => Promise.resolve({ sid: "SM1" }));
vi.mock("@/server/outbound/sms", () => ({ sendSms: (...a: unknown[]) => sendSms(...a) }));
vi.mock("@/server/outbound/email", () => ({ sendEmail: vi.fn(() => Promise.resolve({ id: "re_1" })) }));
vi.mock("@/server/services/usage", () => ({ recordUsageSafe: vi.fn(), recordAiUsageSafe: vi.fn() }));
vi.mock("@/server/services/workflow-engine/dispatch", () => ({
  emitActivityEventAndDispatch: vi.fn(() => Promise.resolve({ activityEvent: {}, workflowEventJob: null })),
}));

import { checkConsent, deliverMessage, PURCHASE_CONSENT_MS, type ConsentContact } from "@/server/services/workflow-engine/messaging";
import { createFakeDb } from "@/test/helpers/fake-supabase";

const NOW = Date.parse("2026-10-13T15:00:00Z");
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
const base: ConsentContact = { sms_opt_out_at: null, email_opt_out_at: null, sms_consent_at: null, consent_source: null };
const c = (over: Partial<ConsentContact>): ConsentContact => ({ ...base, ...over });

describe("checkConsent — purchase relationship (2 years)", () => {
  it("a purchase within 2 years is implied consent, even with no inquiry on file", () => {
    expect(checkConsent(c({ last_purchase_at: daysAgo(400) }), "sms", NOW)).toEqual({ ok: true });
    expect(checkConsent(c({ last_purchase_at: daysAgo(729) }), "sms", NOW)).toEqual({ ok: true });
  });

  it("a purchase within 2 years wins over an inquiry older than 6 months", () => {
    expect(checkConsent(c({ sms_consent_at: daysAgo(500), consent_source: "inbound_sms", last_purchase_at: daysAgo(300) }), "sms", NOW)).toEqual({ ok: true });
  });

  it("a purchase older than 2 years has expired (with or without an old inquiry)", () => {
    expect(checkConsent(c({ last_purchase_at: daysAgo(731) }), "sms", NOW)).toEqual({ ok: false, reason: "consent_expired" });
    expect(checkConsent(c({ sms_consent_at: daysAgo(900), last_purchase_at: daysAgo(800) }), "sms", NOW)).toEqual({ ok: false, reason: "consent_expired" });
  });

  it("the boundary is exactly 2 years from the latest purchase", () => {
    expect(checkConsent(c({ last_purchase_at: new Date(NOW - PURCHASE_CONSENT_MS).toISOString() }), "sms", NOW)).toEqual({ ok: true });
    expect(checkConsent(c({ last_purchase_at: new Date(NOW - PURCHASE_CONSENT_MS - 1000).toISOString() }), "sms", NOW)).toEqual({ ok: false, reason: "consent_expired" });
  });

  it("an old purchase doesn't cancel a fresh inquiry (6 months still applies)", () => {
    expect(checkConsent(c({ sms_consent_at: daysAgo(20), last_purchase_at: daysAgo(1000) }), "sms", NOW)).toEqual({ ok: true });
  });

  it("an opt-out always wins over a purchase and over express consent", () => {
    expect(checkConsent(c({ sms_opt_out_at: daysAgo(1), last_purchase_at: daysAgo(10) }), "sms", NOW)).toEqual({ ok: false, reason: "opted_out" });
    expect(checkConsent(c({ sms_opt_out_at: daysAgo(1), consent_source: "express" }), "sms", NOW)).toEqual({ ok: false, reason: "opted_out" });
    expect(checkConsent(c({ email_opt_out_at: daysAgo(1), last_purchase_at: daysAgo(10) }), "email", NOW)).toEqual({ ok: false, reason: "opted_out" });
  });

  it("express consent never expires; garbage purchase dates are ignored", () => {
    expect(checkConsent(c({ consent_source: "express", last_purchase_at: daysAgo(3000) }), "sms", NOW)).toEqual({ ok: true });
    expect(checkConsent(c({ last_purchase_at: "not a date" }), "sms", NOW)).toEqual({ ok: false, reason: "no_consent" });
  });
});

describe("checkConsent — unchanged for callers without a purchase date", () => {
  it("inquiry: 6 months, then expired; nothing on file → no_consent", () => {
    expect(checkConsent(c({ sms_consent_at: daysAgo(170) }), "sms", NOW)).toEqual({ ok: true });
    expect(checkConsent(c({ sms_consent_at: daysAgo(200) }), "sms", NOW)).toEqual({ ok: false, reason: "consent_expired" });
    expect(checkConsent(c({}), "sms", NOW)).toEqual({ ok: false, reason: "no_consent" });
    expect(checkConsent(c({ last_purchase_at: null }), "sms", NOW)).toEqual({ ok: false, reason: "no_consent" });
  });

  it("the reviews path (relationship folded into sms_consent_at) keeps its 6-month rule", () => {
    // reviews/send.ts passes the later of the inquiry and the job/payment date as sms_consent_at.
    expect(checkConsent(c({ sms_consent_at: daysAgo(30), consent_source: "inbound_sms" }), "sms", NOW)).toEqual({ ok: true });
    expect(checkConsent(c({ sms_consent_at: daysAgo(400), consent_source: "inbound_sms" }), "sms", NOW)).toEqual({ ok: false, reason: "consent_expired" });
  });
});

describe("deliverMessage uses the extended rule only when the caller passes the purchase date", () => {
  beforeEach(() => {
    sendSms.mockClear();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const send = (db: ReturnType<typeof createFakeDb>, consent: ConsentContact) =>
    deliverMessage({
      context: { organizationId: "org-1", actorProfileId: null, supabase: db.client },
      channel: "sms",
      to: "+17055550123",
      body: "Hi Jamie, it's Northshore.",
      companyId: "co-1",
      contactId: "c-1",
      consentContact: consent,
    });

  it("a past customer from 14 months ago: blocked without the purchase date (as before), sent with it", async () => {
    const db = createFakeDb({ message_log: [], voice_numbers: [] });
    const old = c({ sms_consent_at: daysAgo(420), consent_source: "inbound_sms" });
    expect((await send(db, old)).status).toBe("blocked");
    expect(sendSms).not.toHaveBeenCalled();
    const out = await send(db, { ...old, last_purchase_at: daysAgo(420) });
    expect(out.status).toBe("sent");
    expect(out.body).toContain("Reply STOP to opt out");
  });
});
