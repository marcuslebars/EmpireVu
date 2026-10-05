import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, fakeTenantContext, type FakeDb } from "./fake-supabase";

// The sender and click resolver use the service-role client and deliverMessage; point
// both at in-memory fakes.
let adminDb: FakeDb;
const delivered: Array<{ channel: string; to: string; body: string; subject: string | null; consentAt: string | null }> = [];
let deliverStatus: "sent" | "failed" | "blocked" = "sent";

vi.mock("@/server/supabase/admin", () => ({
  createSupabaseAdminClient: () => ({
    from: (t: string) => (adminDb.client.from as (t: string) => unknown)(t),
    rpc: (name: string, args: { p_token: string }) => {
      if (name !== "record_review_click") throw new Error(`unexpected rpc ${name}`);
      const row = adminDb.tables.review_requests.find((r) => r.token === args.p_token);
      if (!row) return Promise.resolve({ data: [], error: null });
      if (row.status === "sent") {
        row.click_count = Number(row.click_count ?? 0) + 1;
        row.clicked_at ??= "2026-10-06T15:00:00Z";
      }
      const c = adminDb.tables.companies.find((x) => x.id === row.company_id)!;
      return Promise.resolve({ data: [{ review_url: c.brand_review_url ?? null, fallback_url: c.quote_public_base_url ?? null }], error: null });
    },
  }),
}));
vi.mock("@/server/services/workflow-engine/messaging", () => ({
  deliverMessage: vi.fn(async (input: { channel: string; to: string; body: string; subject?: string | null; consentContact: { sms_consent_at: string | null } }) => {
    delivered.push({ channel: input.channel, to: input.to, body: input.body, subject: input.subject ?? null, consentAt: input.consentContact?.sms_consent_at ?? null });
    return deliverStatus === "sent" ? { status: "sent", body: input.body } : { status: deliverStatus, reason: deliverStatus === "blocked" ? "opted_out" : "twilio down", body: input.body };
  }),
}));
vi.mock("@/server/outbound/email", () => ({ isEmailSendConfigured: () => true }));

const { DEFAULT_REVIEW_SETTINGS, nextSendTime, normalizeReviewUrl, parseReviewSettings, planSend, renderReviewTemplate, reviewSettingsSchema, scheduleFor } = await import(
  "@/server/services/reviews/rules"
);
const { askForReview, cancelReviewRequest, listReviewRequests, ReviewConflictError, scheduleReviewForCompletedBooking, scheduleReviewForPaidInvoice, updateReviewSettings, getReviewSettings } =
  await import("@/server/services/reviews/service");
const { sweepReviewRequests } = await import("@/server/services/reviews/send");
const { isPreviewBot, resolveReviewClick } = await import("@/server/services/reviews/click");

const TZ = "America/Toronto";
const ORG = "org-1";
const CO = "11111111-1111-4111-8111-111111111111";
const PAT = "c-pat";

describe("rules", () => {
  it("defaults anything missing or invalid", () => {
    expect(parseReviewSettings(null)).toEqual(DEFAULT_REVIEW_SETTINGS);
    const s = parseReviewSettings({ enabled: true, delayHours: 999, channel: "pigeon", smsTemplate: "no link here", cooldownDays: 30 });
    expect(s.enabled).toBe(true);
    expect(s.delayHours).toBe(DEFAULT_REVIEW_SETTINGS.delayHours);
    expect(s.channel).toBe("sms_or_email");
    expect(s.smsTemplate).toBe(DEFAULT_REVIEW_SETTINGS.smsTemplate);
    expect(s.cooldownDays).toBe(30);
  });

  it("requires {{link}} in templates", () => {
    expect(reviewSettingsSchema.shape.smsTemplate.safeParse("Thanks!").success).toBe(false);
    expect(reviewSettingsSchema.shape.smsTemplate.safeParse("Thanks! {{ link }}").success).toBe(true);
  });

  it("accepts only https review links", () => {
    expect(normalizeReviewUrl("https://g.page/r/abc/review")).toBe("https://g.page/r/abc/review");
    expect(normalizeReviewUrl("  ")).toBeNull();
    expect(() => normalizeReviewUrl("g.page/r/abc")).toThrow(/https/);
    expect(() => normalizeReviewUrl("http://example.com")).toThrow(/https/);
  });

  it("keeps automatic asks inside 9am–8pm local", () => {
    const at = (iso: string) => new Date(nextSendTime(Date.parse(iso), TZ)).toISOString();
    expect(at("2026-10-06T15:00:00Z")).toBe("2026-10-06T15:00:00.000Z"); // 11am EDT
    expect(at("2026-10-06T11:30:00Z")).toBe("2026-10-06T13:00:00.000Z"); // 7:30am → 9am
    expect(at("2026-10-07T00:30:00Z")).toBe("2026-10-07T13:00:00.000Z"); // 8:30pm → next 9am
    expect(at("2026-11-01T03:00:00Z")).toBe("2026-11-01T14:00:00.000Z"); // fall-back night → 9am EST
    // Done at 6pm, 2h delay → 8pm is outside → next morning.
    expect(new Date(scheduleFor(Date.parse("2026-10-06T22:00:00Z"), { delayHours: 2 }, TZ)).toISOString()).toBe("2026-10-07T13:00:00.000Z");
  });

  it("renders templates, with a friendly fallback name", () => {
    expect(renderReviewTemplate("Hi {{first_name}} from {{ company }}: {{link}}", { firstName: null, company: "A1", link: "https://x/r/1" })).toBe("Hi there from A1: https://x/r/1");
  });

  describe("planSend", () => {
    const base = {
      settings: { ...DEFAULT_REVIEW_SETTINGS, enabled: true },
      reviewUrl: "https://g.page/r/abc/review",
      contact: { phone: "+14165550100", email: "pat@example.com", smsOptOut: false, emailOptOut: false },
      stillValid: true,
      askedRecently: false,
      emailConfigured: true,
      nowMs: Date.parse("2026-10-06T15:00:00Z"),
      timeZone: TZ,
    };
    const auto = { source: "job_done" as const };

    it("texts first, falls back to email", () => {
      expect(planSend(auto, base)).toEqual({ action: "send", channel: "sms", to: "+14165550100" });
      expect(planSend(auto, { ...base, contact: { ...base.contact, smsOptOut: true } })).toEqual({ action: "send", channel: "email", to: "pat@example.com" });
      expect(planSend(auto, { ...base, contact: { ...base.contact, phone: null } })).toMatchObject({ channel: "email" });
    });

    it("respects a texts-only or email-only brand", () => {
      const smsOnly = { ...base, settings: { ...base.settings, channel: "sms" as const }, contact: { ...base.contact, phone: null } };
      expect(planSend(auto, smsOnly)).toEqual({ action: "skip", reason: "No mobile number on file." });
      expect(planSend(auto, { ...base, settings: { ...base.settings, channel: "email" as const } })).toMatchObject({ channel: "email" });
    });

    it("skips, cancels and defers for the right reasons", () => {
      expect(planSend(auto, { ...base, settings: { ...base.settings, enabled: false } })).toMatchObject({ action: "cancel" });
      expect(planSend(auto, { ...base, reviewUrl: null })).toMatchObject({ action: "skip", reason: expect.stringMatching(/review link/) });
      expect(planSend(auto, { ...base, stillValid: false })).toEqual({ action: "skip", reason: "The job is no longer marked done." });
      expect(planSend({ source: "invoice_paid" }, { ...base, stillValid: false })).toEqual({ action: "skip", reason: "The invoice is no longer marked paid." });
      expect(planSend(auto, { ...base, askedRecently: true })).toMatchObject({ action: "skip", reason: expect.stringMatching(/90 days/) });
      expect(planSend(auto, { ...base, contact: { phone: null, email: null, smsOptOut: false, emailOptOut: false } })).toMatchObject({ action: "skip", reason: "No mobile number or email on file." });
      expect(planSend(auto, { ...base, nowMs: Date.parse("2026-10-07T02:00:00Z") })).toEqual({ action: "defer", until: Date.parse("2026-10-07T13:00:00Z") });
    });

    it("lets staff ask by hand any time, even with automatic asks off", () => {
      const manual = { source: "manual" as const, channel: "email" as const };
      const late = { ...base, settings: { ...base.settings, enabled: false }, nowMs: Date.parse("2026-10-07T02:00:00Z") };
      expect(planSend(manual, late)).toEqual({ action: "send", channel: "email", to: "pat@example.com" });
      expect(planSend({ source: "manual" }, { ...late, askedRecently: true })).toMatchObject({ action: "send" });
    });
  });
});

function seed(settings: Record<string, unknown> = { enabled: true }): FakeDb {
  return createFakeDb({
    companies: [
      {
        id: CO,
        organization_id: ORG,
        name: "A1 Marine Care",
        brand_from_name: null,
        brand_reply_email: "hello@a1.ca",
        brand_review_url: "https://g.page/r/a1/review",
        quote_public_base_url: "https://quotes.a1marinecare.ca",
        timezone: TZ,
        review_settings: settings,
      },
    ],
    contacts: [
      { id: PAT, organization_id: ORG, company_id: CO, first_name: "Pat", last_name: "Smith", phone: "+14165550100", email: "pat@example.com", sms_opt_out_at: null, email_opt_out_at: null, sms_consent_at: null, consent_source: null },
    ],
    bookings: [{ id: "b1", organization_id: ORG, company_id: CO, contact_id: PAT, title: "Shrink wrap", status: "completed", completed_at: "2026-10-06T14:00:00Z" }],
    invoices: [{ id: "i1", organization_id: ORG, company_id: CO, contact_id: PAT, status: "paid", paid_at: "2026-10-06T16:00:00Z" }],
    review_requests: [],
    workflows: [],
  });
}

describe("scheduling", () => {
  beforeEach(() => {
    delivered.length = 0;
    deliverStatus = "sent";
  });

  it("queues one ask when a job is done, inside sending hours", async () => {
    const db = seed({ enabled: true, delayHours: 2 });
    const ctx = fakeTenantContext(db, ORG, "u1");
    const out = await scheduleReviewForCompletedBooking(ctx, { id: "b1", company_id: CO, contact_id: PAT, completed_at: "2026-10-06T14:00:00Z" });
    expect(out).toMatchObject({ queued: true, scheduledFor: "2026-10-06T16:00:00.000Z" });
    const [row] = db.tables.review_requests;
    expect(row).toMatchObject({ organization_id: ORG, company_id: CO, contact_id: PAT, booking_id: "b1", source: "job_done", status: "scheduled" });
    expect(String(row.token)).toMatch(/^[a-f0-9]{32}$/);
    // A second job for the same customer the same day doesn't queue a second text.
    expect(await scheduleReviewForCompletedBooking(ctx, { id: "b2", company_id: CO, contact_id: PAT })).toEqual({ queued: false, reason: "an ask is already queued for this customer" });
  });

  it("does nothing when off, on the other trigger, or without a customer", async () => {
    const off = seed({ enabled: false });
    expect(await scheduleReviewForCompletedBooking(fakeTenantContext(off, ORG), { id: "b1", company_id: CO, contact_id: PAT })).toMatchObject({ queued: false });
    const onPaid = seed({ enabled: true, trigger: "invoice_paid" });
    expect(await scheduleReviewForCompletedBooking(fakeTenantContext(onPaid, ORG), { id: "b1", company_id: CO, contact_id: PAT })).toMatchObject({ queued: false });
    expect(await scheduleReviewForPaidInvoice(onPaid.client, { id: "i1", organization_id: ORG, company_id: CO, contact_id: PAT, paid_at: "2026-10-06T16:00:00Z" })).toMatchObject({ queued: true });
    expect(await scheduleReviewForCompletedBooking(fakeTenantContext(seed(), ORG), { id: "b1", company_id: CO, contact_id: null })).toMatchObject({ queued: false });
  });

  it("never throws into the job-done path", async () => {
    const db = seed();
    db.failNext("companies", { message: "db down" });
    await expect(scheduleReviewForCompletedBooking(fakeTenantContext(db, ORG), { id: "b1", company_id: CO, contact_id: PAT })).resolves.toEqual({ queued: false, reason: "error" });
  });
});

describe("sending (worker sweep)", () => {
  beforeEach(() => {
    delivered.length = 0;
    deliverStatus = "sent";
  });

  async function queued(settings: Record<string, unknown> = { enabled: true, delayHours: 0 }) {
    adminDb = seed(settings);
    await scheduleReviewForCompletedBooking(fakeTenantContext(adminDb, ORG), { id: "b1", company_id: CO, contact_id: PAT, completed_at: "2026-10-06T14:00:00Z" });
    return adminDb.tables.review_requests[0];
  }

  it("texts the tracked brand link once, with the job as the consent date", async () => {
    const row = await queued();
    const r = await sweepReviewRequests(new Date("2026-10-06T15:00:00Z"));
    expect(r).toMatchObject({ due: 1, sent: 1 });
    expect(delivered).toHaveLength(1);
    expect(delivered[0].channel).toBe("sms");
    expect(delivered[0].body).toBe(`Hi Pat, thanks for choosing A1 Marine Care! If you have a minute, would you leave us a quick review? https://quotes.a1marinecare.ca/r/${row.token}`);
    expect(delivered[0].body).not.toMatch(/empirevu/i);
    expect(delivered[0].consentAt).toBe("2026-10-06T14:00:00Z");
    expect(row).toMatchObject({ status: "sent", channel: "sms", sent_to: "+14165550100", sent_at: "2026-10-06T15:00:00.000Z" });
    // Running again sends nothing.
    expect(await sweepReviewRequests(new Date("2026-10-06T15:10:00Z"))).toMatchObject({ due: 0 });
    expect(delivered).toHaveLength(1);
  });

  it("waits for morning instead of texting at night", async () => {
    const row = await queued();
    row.scheduled_for = "2026-10-07T01:00:00Z";
    const r = await sweepReviewRequests(new Date("2026-10-07T01:05:00Z"));
    expect(r.deferred).toBe(1);
    expect(row).toMatchObject({ status: "scheduled", scheduled_for: "2026-10-07T13:00:00.000Z" });
    expect(delivered).toHaveLength(0);
  });

  it("skips a customer asked inside the cooldown, and a job re-opened since", async () => {
    const row = await queued();
    adminDb.tables.review_requests.push({ id: "old", organization_id: ORG, company_id: CO, contact_id: PAT, status: "sent", sent_at: "2026-09-01T15:00:00Z", token: "f".repeat(32) });
    await sweepReviewRequests(new Date("2026-10-06T15:00:00Z"));
    expect(row).toMatchObject({ status: "skipped", reason: "Already asked within the last 90 days." });

    const row2 = await queued();
    adminDb.tables.bookings[0].status = "confirmed";
    await sweepReviewRequests(new Date("2026-10-06T15:00:00Z"));
    expect(row2).toMatchObject({ status: "skipped", reason: "The job is no longer marked done." });
    expect(delivered).toHaveLength(0);
  });

  it("cancels asks queued before the brand turned them off", async () => {
    const row = await queued();
    adminDb.tables.companies[0].review_settings = { enabled: false };
    await sweepReviewRequests(new Date("2026-10-06T15:00:00Z"));
    expect(row.status).toBe("cancelled");
  });

  it("records blocked and failed sends, and never retries one stuck mid-send", async () => {
    const row = await queued();
    deliverStatus = "blocked";
    await sweepReviewRequests(new Date("2026-10-06T15:00:00Z"));
    expect(row).toMatchObject({ status: "skipped", reason: "Not sent: the customer has opted out." });

    const row2 = await queued();
    row2.status = "sending";
    row2.updated_at = "2026-10-06T14:00:00Z";
    await sweepReviewRequests(new Date("2026-10-06T15:00:00Z"));
    expect(row2.status).toBe("failed");
    expect(delivered).toHaveLength(1); // only the blocked attempt reached deliverMessage
  });
});

describe("staff actions", () => {
  beforeEach(() => {
    delivered.length = 0;
    deliverStatus = "sent";
  });

  it("asks now by hand, replacing a queued automatic ask", async () => {
    adminDb = seed({ enabled: true, delayHours: 24 });
    const ctx = fakeTenantContext(adminDb, ORG, "u1");
    await scheduleReviewForCompletedBooking(ctx, { id: "b1", company_id: CO, contact_id: PAT });
    const out = await askForReview(ctx, PAT, { channel: "email" });
    expect(out).toMatchObject({ status: "sent", channel: "email", to: "pat@example.com" });
    expect(delivered[0]).toMatchObject({ channel: "email", subject: "How did we do?" });
    expect(adminDb.tables.review_requests.map((r) => [r.source, r.status])).toEqual([
      ["job_done", "cancelled"],
      ["manual", "sent"],
    ]);
  });

  it("warns before asking the same customer twice, unless forced", async () => {
    adminDb = seed({ enabled: true });
    const ctx = fakeTenantContext(adminDb, ORG, "u1");
    await askForReview(ctx, PAT, {});
    await expect(askForReview(ctx, PAT, {})).rejects.toBeInstanceOf(ReviewConflictError);
    await expect(askForReview(ctx, PAT, { force: true })).resolves.toMatchObject({ status: "sent" });
  });

  it("needs a review link", async () => {
    adminDb = seed({ enabled: false });
    adminDb.tables.companies[0].brand_review_url = null;
    await expect(askForReview(fakeTenantContext(adminDb, ORG), PAT, {})).rejects.toThrow(/review link/);
  });

  it("cancels only a queued ask", async () => {
    adminDb = seed({ enabled: true });
    const ctx = fakeTenantContext(adminDb, ORG);
    await scheduleReviewForCompletedBooking(ctx, { id: "b1", company_id: CO, contact_id: PAT });
    const id = String(adminDb.tables.review_requests[0].id);
    await cancelReviewRequest(ctx, id);
    expect(adminDb.tables.review_requests[0].status).toBe("cancelled");
    await expect(cancelReviewRequest(ctx, id)).rejects.toThrow(/isn't waiting/);
  });

  it("saves settings, refusing to switch on without a link", async () => {
    const db = seed({});
    db.tables.companies[0].brand_review_url = null;
    const ctx = fakeTenantContext(db, ORG);
    await expect(updateReviewSettings(ctx, CO, { settings: { enabled: true } })).rejects.toThrow(/review link/);
    await expect(updateReviewSettings(ctx, CO, { reviewUrl: "nope" })).rejects.toThrow(/https/);
    const view = await updateReviewSettings(ctx, CO, { reviewUrl: "https://g.page/r/new/review", settings: { enabled: true, delayHours: 24 } });
    expect(view).toMatchObject({ reviewUrl: "https://g.page/r/new/review", linkBase: "https://quotes.a1marinecare.ca/r/" });
    expect(view.settings).toMatchObject({ enabled: true, delayHours: 24, channel: "sms_or_email" });
  });

  it("flags review automations that would ask twice", async () => {
    const db = seed({});
    db.tables.workflows.push(
      { id: "w1", organization_id: ORG, company_id: CO, name: "Review request", slug: "review-request", status: "active" },
      { id: "w2", organization_id: ORG, company_id: CO, name: "Thank-you", slug: "invoice-paid-thank-you", status: "draft" },
    );
    const view = await getReviewSettings(fakeTenantContext(db, ORG), CO);
    expect(view.overlappingAutomations).toEqual([{ id: "w1", name: "Review request", slug: "review-request" }]);
  });

  it("lists asks with click stats", async () => {
    adminDb = seed({ enabled: true, delayHours: 0 });
    const ctx = fakeTenantContext(adminDb, ORG);
    await scheduleReviewForCompletedBooking(ctx, { id: "b1", company_id: CO, contact_id: PAT, completed_at: "2026-10-04T14:00:00Z" });
    adminDb.tables.review_requests[0].created_at = new Date().toISOString();
    expect(await sweepReviewRequests(new Date("2026-10-04T15:00:00Z"))).toMatchObject({ sent: 1 });
    const token = String(adminDb.tables.review_requests[0].token);
    expect(await resolveReviewClick(token, "Mozilla/5.0 (iPhone)", "GET")).toBe("https://g.page/r/a1/review");
    const list = await listReviewRequests(ctx, { days: 90 });
    expect(list.stats).toMatchObject({ sent: 1, clicked: 1, clickRate: 1 });
    expect(list.requests[0]).toMatchObject({ customerName: "Pat Smith", jobTitle: "Shrink wrap", clickCount: 1 });
  });
});

describe("the /r/ link", () => {
  it("doesn't count link previews, and ignores bad tokens", async () => {
    adminDb = seed({ enabled: true });
    adminDb.tables.review_requests.push({ id: "r1", organization_id: ORG, company_id: CO, contact_id: PAT, status: "sent", token: "a".repeat(32), click_count: 0 });
    expect(isPreviewBot("facebookexternalhit/1.1 Facebot Twitterbot/1.0")).toBe(true);
    expect(isPreviewBot(null)).toBe(true);
    expect(await resolveReviewClick("a".repeat(32), "WhatsApp/2.23", "GET")).toBe("https://g.page/r/a1/review");
    expect(adminDb.tables.review_requests[0].click_count).toBe(0);
    expect(await resolveReviewClick("a".repeat(32), "Mozilla/5.0", "HEAD")).toBe("https://g.page/r/a1/review");
    expect(adminDb.tables.review_requests[0].click_count).toBe(0);
    expect(await resolveReviewClick("a".repeat(32), "Mozilla/5.0", "GET")).toBe("https://g.page/r/a1/review");
    expect(adminDb.tables.review_requests[0].click_count).toBe(1);
    expect(await resolveReviewClick("not-a-token", "Mozilla/5.0", "GET")).toBeNull();
    expect(await resolveReviewClick("b".repeat(32), "Mozilla/5.0", "GET")).toBeNull();
  });
});
