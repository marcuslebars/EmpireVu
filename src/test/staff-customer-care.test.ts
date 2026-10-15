/**
 * Customer care & warranty (docs/ai-staff.md → "Customer care & warranty") against the in-memory
 * fake DB with real services underneath (deliverMessage, sendOwnerSms, insertApproval,
 * notifyOwnerOfApproval, the owner channel's handleOwnerInboundSms / decideApproval, the registry).
 * Only the outside world is faked: Twilio (sendSms), Resend, the calendar lookup (availability).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "@/test/helpers/fake-supabase";

const sendSms = vi.fn((..._a: unknown[]) => Promise.resolve({ sid: `SM${Math.random().toString(36).slice(2, 8)}` }));
const runOwnerCommandAgent = vi.fn((..._a: unknown[]) => Promise.resolve({ reply: "agent reply", actions: [], rounds: 1, confirmationId: null }));
vi.mock("@/server/outbound/sms", () => ({ sendSms: (...a: unknown[]) => sendSms(...a) }));
vi.mock("@/server/outbound/email", () => ({ sendEmail: vi.fn(() => Promise.resolve({ id: "re_1" })) }));
vi.mock("@/server/services/usage", () => ({ recordUsageSafe: vi.fn(), recordAiUsageSafe: vi.fn() }));
vi.mock("@/server/services/push/activity", () => ({ notifyActivityEvent: vi.fn() }));
vi.mock("@/server/services/workflow-engine/dispatch", () => ({ emitActivityEventAndDispatch: vi.fn(() => Promise.resolve({ activityEvent: {}, workflowEventJob: null })) }));
vi.mock("@/server/services/owner-channel/agent", () => ({ runOwnerCommandAgent: (...a: unknown[]) => runOwnerCommandAgent(...a) }));

import { DEFAULT_BOOKING_POLICY } from "@/server/services/booking-windows";
import { replyInstruction } from "@/server/services/front-desk/approval-text";
import { decideApproval, expireApproval } from "@/server/services/owner-channel/approvals";
import { handleOwnerInboundSms } from "@/server/services/owner-channel/entry";
import type { ToolRunState } from "@/server/services/owner-channel/tools";
import type { BusinessFacts } from "@/server/services/sms-agent/facts";
import { newTurnEffects, runTool, type TurnState } from "@/server/services/sms-agent/tools";
import { activeRolesFor, registryProblems, roleApprovalExecutor, roleOwnerTools, staffRoles } from "@/server/services/staff/registry";
import { customerCareRole } from "@/server/services/staff/customer-care";
import { briefingItems } from "@/server/services/staff/customer-care/briefing-items";
import { plannedSendAt } from "@/server/services/staff/customer-care/checkins";
import { checkinTime, careActiveFor, mergeCustomerCareSettings, readCustomerCareSettings } from "@/server/services/staff/customer-care/settings";
import { resetCareCompanyCache, sweepCheckins, sweepJobs, sweepOutbox } from "@/server/services/staff/customer-care/sweeps";
import { checkinText, jobLabelOf, lowRatingLine, visitOfferText } from "@/server/services/staff/customer-care/texts";
import { addMonths, longDate } from "@/server/services/staff/customer-care/time";
import { resetVisitDeps, setVisitDeps } from "@/server/services/staff/customer-care/visits";
import { chooseTerm } from "@/server/services/staff/customer-care/warranty";
import { getCustomerCareView, saveEquipment, saveWarrantyTerm, updateCustomerCareSettings } from "@/server/services/staff/customer-care/view";

const TZ = "America/Toronto";
const ORG = "11111111-1111-4111-8111-111111111111";
const CO = "22222222-2222-4222-8222-222222222222";
const HOUSE_ORG = "33333333-3333-4333-8333-333333333333";
const HOUSE_CO = "44444444-4444-4444-8444-444444444444";
const OWNER = "+17055559999";
const HOUSE_OWNER = "+17055558888";
const PLATFORM = "+16475550000";
const BUSINESS_NUMBER = "+17055550111";
const HOUSE_NUMBER = "+17055550222";
const DANA = "c0000000-0000-4000-8000-000000000001";
const DANA_PHONE = "+17055550123";
const A1_CUSTOMER = "c0000000-0000-4000-8000-000000000002";
const JOB = "b0000000-0000-4000-8000-000000000001";
const A1_JOB = "b0000000-0000-4000-8000-000000000002";
const ITEM = "e0000000-0000-4000-8000-000000000001";
const HOUR = 3_600_000;
const DAY = 86_400_000;

// Mon Oct 12 2026, 10:00 in Toronto (EDT, UTC-4).
const NOW = Date.parse("2026-10-12T14:00:00Z");

let db: FakeDb;
let slots: Array<{ date: string; window: string | null; startsAt: string | null; label: string }>;

function company(over: Record<string, unknown> = {}) {
  return {
    id: CO, organization_id: ORG, name: "Northshore Roofing", brand_from_name: null, timezone: TZ, ai_settings: {}, stage: "active",
    owner_phone_e164: OWNER, owner_phone_verified_at: "2026-10-01T00:00:00Z", owner_email: "mike@northshore.test", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
    ...over,
  };
}

function contact(id: string, companyId: string, org: string, first: string, last: string, phone: string) {
  return { id, organization_id: org, company_id: companyId, first_name: first, last_name: last, phone, phone_last10: phone.slice(-10), email: null, sms_opt_out_at: null, email_opt_out_at: null, sms_consent_at: "2026-09-01T13:00:00Z", consent_source: "implied_inquiry", notes: null, metadata: {} };
}

function booking(id: string, over: Record<string, unknown> = {}) {
  return {
    id, organization_id: ORG, company_id: CO, contact_id: DANA, title: "Roof replacement — Dana Jones", status: "completed", scheduled_for: "2026-10-12T12:00:00Z",
    completed_at: null, duration_minutes: 480, price_cents: 1_200_000, quote_id: null, service_item_id: null, window_key: null, ...over,
  };
}

function seed(): FakeDb {
  return createFakeDb(
    {
      organizations: [
        { id: ORG, platform_brand: "crankleads", name: "Northshore" },
        { id: HOUSE_ORG, platform_brand: "empirevu", name: "A1 Group" },
      ],
      companies: [company(), company({ id: HOUSE_CO, organization_id: HOUSE_ORG, name: "A1 Marine Care", owner_phone_e164: HOUSE_OWNER })],
      contacts: [contact(DANA, CO, ORG, "Dana", "Jones", DANA_PHONE), contact(A1_CUSTOMER, HOUSE_CO, HOUSE_ORG, "Sam", "Boater", "+17055550333")],
      voice_numbers: [
        { organization_id: ORG, company_id: CO, provider: "twilio", active: true, phone_e164: BUSINESS_NUMBER, mode: "missed_call_catcher" },
        { organization_id: HOUSE_ORG, company_id: HOUSE_CO, provider: "twilio", active: true, phone_e164: HOUSE_NUMBER, mode: "missed_call_catcher" },
      ],
      bookings: [booking(JOB), booking(A1_JOB, { organization_id: HOUSE_ORG, company_id: HOUSE_CO, contact_id: A1_CUSTOMER, title: "Shrink wrap — Sam Boater" })],
      // Finished at 09:00 local today.
      activity_events: [
        { id: "ev1", organization_id: ORG, company_id: CO, entity_id: JOB, event_type: "booking.completed", occurred_at: "2026-10-12T13:00:00Z" },
        { id: "ev2", organization_id: HOUSE_ORG, company_id: HOUSE_CO, entity_id: A1_JOB, event_type: "booking.completed", occurred_at: "2026-10-12T13:00:00Z" },
      ],
      service_catalog_items: [{ id: ITEM, organization_id: ORG, company_id: CO, service_key: "roof_replacement", label: "Roof replacement", active: true, sort_order: 1 }],
      review_requests: [],
      care_checkins: [],
      care_cases: [],
      care_case_bookings: [],
      care_messages: [],
      care_checkin_claims: [],
      job_warranties: [],
      warranty_terms: [],
      installed_equipment: [],
      owner_approvals: [],
      owner_command_log: [],
      message_log: [],
      sms_conversations: [],
      platform_sms_opt_outs: [],
    },
    {
      owner_command_log: [["provider_ref"]],
      care_checkins: [["booking_id"]],
      job_warranties: [["booking_id"]],
      care_case_bookings: [["booking_id"]],
      care_messages: [["company_id", "kind", "dedupe_key"]],
      care_checkin_claims: [["company_id", "contact_id", "local_date"]],
      warranty_terms: [["company_id", "service_catalog_item_id"]],
    },
  );
}

const rows = (table: string) => db.tables[table] as Array<Record<string, unknown>>;
const smsTo = (to: string) => sendSms.mock.calls.map((c) => c[0] as { to: string; body: string; from?: string }).filter((m) => m.to === to);
const ownerTexts = () => smsTo(OWNER).map((m) => m.body);
let sid = 0;
const ownerSays = (body: string) => handleOwnerInboundSms(db.client, { from: OWNER, to: PLATFORM, body, media: [], providerRef: `SMx${++sid}`, viaPlatformNumber: true, companyId: null });

const FACTS = {
  organizationId: ORG,
  companyId: CO,
  businessName: "Northshore Roofing",
  ownerFirstName: "Mike",
  timeZone: TZ,
  bookingMode: "windows",
  bookingPolicy: DEFAULT_BOOKING_POLICY,
  onlineBooking: { slotMinutes: 60 },
  priceList: [],
} as unknown as BusinessFacts;

function turn(customerText = "2 - still leaking by the chimney"): TurnState {
  return {
    admin: db.client,
    facts: FACTS,
    settings: { enabled: true, autonomy: "standard", enabledIsDefault: true },
    contact: rows("contacts").find((c) => c.id === DANA),
    conversation: { id: "conv-1", collected: {} },
    services: { now: () => new Date() },
    effects: newTurnEffects(),
    customerText,
    roleTools: customerCareRole.agentTools,
  } as unknown as TurnState;
}

function ownerState(): ToolRunState {
  return { admin: db.client, scope: { organizationId: ORG, companyId: CO, companyName: "Northshore Roofing", timeZone: TZ }, ownerPhone: OWNER, nowMs: Date.now(), confirmation: null, actions: [] };
}

const tool = (name: string) => roleOwnerTools().find((t) => t.tool.name === name)!;

/** A check-in that went out yesterday at 10:00 local. */
function sentCheckin(over: Record<string, unknown> = {}) {
  const row = { id: "ck-1", organization_id: ORG, company_id: CO, contact_id: DANA, booking_id: JOB, status: "sent", send_at: "2026-10-11T14:00:00Z", sent_at: "2026-10-11T14:00:00Z", pushes: 0, job_label: "roof replacement", rating: null, comment: null, answered_at: null, created_at: "2026-10-10T20:00:00Z", ...over };
  rows("care_checkins").push(row);
  return row;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  process.env.PLATFORM_SMS_NUMBER = PLATFORM;
  process.env.CRANKLEADS_APP_BASE_URL = "https://app.crankleads.test";
  sendSms.mockClear();
  runOwnerCommandAgent.mockClear();
  db = seed();
  resetCareCompanyCache();
  slots = [
    { date: "2026-10-14", window: "morning", startsAt: null, label: "Wed Oct 14 in the morning" },
    { date: "2026-10-14", window: "afternoon", startsAt: null, label: "Wed Oct 14 in the afternoon" },
    { date: "2026-10-15", window: "morning", startsAt: null, label: "Thu Oct 15 in the morning" },
  ];
  setVisitDeps({
    loadFacts: async () => FACTS,
    availability: async (_admin, _facts, input) => {
      const list = input.preferredDate ? slots.filter((s) => s.date >= (input.preferredDate as string)) : slots;
      return { ok: true, mode: "windows", slots: list.slice(0, input.limit ?? 3) };
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  resetVisitDeps();
});

// ── Pure parts ───────────────────────────────────────────────────────────────────────

describe("settings and words", () => {
  it("defaults: CrankLeads on (12-month warranty, next day 10am), house orgs off; merge touches only customer_care", () => {
    const on = readCustomerCareSettings({}, { doneForYou: true });
    expect(on).toMatchObject({ enabled: true, checkins: { enabled: true, time: "10:00", delayDays: 1, minJobCents: 0 }, warranty: { months: 12, terms: null }, enabledIsDefault: true });
    expect(readCustomerCareSettings({}, { doneForYou: false }).enabled).toBe(false);
    expect(readCustomerCareSettings({ customer_care: { enabled: true } }, { doneForYou: false }).enabled).toBe(true);
    const merged = mergeCustomerCareSettings({ sms_agent: { enabled: true }, customer_care: { checkins: { time: "11:00" } } }, { enabled: true, checkins: { minJobCents: 50_000, time: "21:00" }, warranty: { months: 24, terms: "<b>Leaks</b> from our work" } });
    expect(merged).toEqual({
      sms_agent: { enabled: true },
      customer_care: { enabled: true, any_on: true, checkins: { time: "11:00", min_job_cents: 50_000 }, warranty: { months: 24, terms: "bLeaks/b from our work" } },
    });
    expect(checkinTime("08:30")).toBeNull();
    expect(checkinTime("19:30")).toBeNull();
    expect(checkinTime("19:00")).toBe("19:00");
  });

  it("job labels, the check-in text, the owner's line, dates", () => {
    expect(jobLabelOf("Roof replacement — Dana Jones")).toBe("roof replacement");
    expect(jobLabelOf("Booking — Dana Jones")).toBeNull();
    expect(jobLabelOf("Dana Jones", { first_name: "Dana", last_name: "Jones" })).toBeNull();
    expect(checkinText("Northshore Roofing", "Dana", "roof")).toBe("Hi Dana, it's Northshore Roofing - how did the roof go? Reply 1-5 (5 = great), or tell us anything we missed.");
    expect(checkinText("Northshore Roofing", null, null)).toBe("Hi, it's Northshore Roofing - how did the job go? Reply 1-5 (5 = great), or tell us anything we missed.");
    expect(lowRatingLine("Dana Jones", "roof", 2, "still leaking by the chimney")).toBe('Dana Jones rated the roof job 2/5: "still leaking by the chimney".');
    expect(visitOfferText("Northshore Roofing", "Dana", "Mike", "roof", "warranty", slots)).toBe(
      "Hi Dana, it's Northshore Roofing. Mike would like to come back and look at the roof - no charge for the visit. Would any of these work: Wed Oct 14 in the morning, Wed Oct 14 in the afternoon or Thu Oct 15 in the morning? Just reply with the one that suits.",
    );
    expect(longDate("2026-05-04")).toBe("May 4, 2026");
    expect(addMonths("2026-05-04", 12)).toBe("2027-05-04");
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(chooseTerm({ months: 12, terms: null }, [])).toEqual({ months: 12, terms: null, source: "default" });
    expect(chooseTerm({ months: 12, terms: "x" }, [{ months: 60, terms_text: null }, { months: 24, terms_text: "y" }])).toEqual({ months: 60, terms: "x", source: "item" });
  });

  it("the check-in time is local and DST-safe (10:00 EDT = 14:00Z; 10:00 EST = 15:00Z)", () => {
    const c = { timeZone: TZ, settings: readCustomerCareSettings({}, { doneForYou: true }) };
    expect(new Date(plannedSendAt(Date.parse("2026-10-12T13:00:00Z"), c)).toISOString()).toBe("2026-10-13T14:00:00.000Z");
    expect(new Date(plannedSendAt(Date.parse("2026-10-31T20:00:00Z"), c)).toISOString()).toBe("2026-11-01T15:00:00.000Z");
  });

  it("reply lines for both kinds", () => {
    expect(replyInstruction("care_followup", 12, { option: "visit" })).toBe("Reply Y 12 for the visit, N 12 to leave it.");
    expect(replyInstruction("care_followup", 13, { option: "call" })).toBe("Reply Y 13 for the call, N 13 to leave it.");
    expect(replyInstruction("warranty_claim", 4, {})).toBe("Reply Y 4 or N 4.");
  });
});

describe("registry and gating", () => {
  it("the role is wired: kinds, three SMS-agent tools, four owner tools, three sweeps, no duplicates", () => {
    expect(staffRoles()).toContain(customerCareRole);
    expect(roleApprovalExecutor("care_followup")).toBe(customerCareRole.approvalExecutors.care_followup);
    expect(roleApprovalExecutor("warranty_claim")).toBe(customerCareRole.approvalExecutors.warranty_claim);
    expect(customerCareRole.agentTools.map((t) => t.name)).toEqual(["record_job_feedback", "check_warranty", "book_care_visit"]);
    expect(customerCareRole.ownerTools.map((t) => t.tool.name)).toEqual(["care_status", "warranty_lookup", "resolve_case", "add_equipment"]);
    expect(customerCareRole.sweeps.map((s) => s.name)).toEqual(["customer_care:jobs", "customer_care:checkins", "customer_care:outbox"]);
    expect(registryProblems([], [])).toEqual([]);
  });

  it("on for CrankLeads with the SMS agent; off with the agent off; A1 off unless switched on", async () => {
    expect(await careActiveFor(db.client, { organizationId: ORG, companyId: CO })).toBe(true);
    expect(await careActiveFor(db.client, { organizationId: HOUSE_ORG, companyId: HOUSE_CO })).toBe(false);
    expect((await activeRolesFor(db.client, { organizationId: HOUSE_ORG, companyId: HOUSE_CO })).map((r) => r.role)).not.toContain("customer_care");
    rows("companies")[0].ai_settings = { sms_agent: { enabled: false } };
    expect(await careActiveFor(db.client, { organizationId: ORG, companyId: CO })).toBe(false);
    rows("companies")[1].ai_settings = { sms_agent: { enabled: true }, customer_care: { enabled: true, any_on: true } };
    expect(await careActiveFor(db.client, { organizationId: HOUSE_ORG, companyId: HOUSE_CO })).toBe(true);
  });
});

// ── Check-ins ───────────────────────────────────────────────────────────────────────

describe("check-ins", () => {
  it("a finished job gets one check-in the next day at 10:00 and a 12-month warranty; A1 gets nothing", async () => {
    expect(await sweepJobs(db.client, NOW)).toBe(1);
    expect(await sweepJobs(db.client, NOW + 5 * 60_000)).toBe(0);
    expect(rows("care_checkins")).toHaveLength(1);
    expect(rows("care_checkins")[0]).toMatchObject({ booking_id: JOB, status: "scheduled", send_at: "2026-10-13T14:00:00.000Z", pushes: 0, job_label: "roof replacement" });
    expect(rows("job_warranties")).toHaveLength(1);
    expect(rows("job_warranties")[0]).toMatchObject({ booking_id: JOB, contact_id: DANA, starts_on: "2026-10-12", ends_on: "2027-10-12", months: 12, source: "default" });
    // Not yet: it's for tomorrow.
    expect(await sweepCheckins(db.client, NOW)).toBe(0);
    const tomorrow = Date.parse("2026-10-13T14:00:00Z");
    vi.setSystemTime(tomorrow);
    expect(await sweepCheckins(db.client, tomorrow)).toBe(1);
    const sent = smsTo(DANA_PHONE);
    expect(sent).toHaveLength(1);
    expect(sent[0].from).toBe(BUSINESS_NUMBER);
    expect(sent[0].body).toContain("Hi Dana, it's Northshore Roofing - how did the roof replacement go? Reply 1-5 (5 = great), or tell us anything we missed.");
    expect(rows("care_checkins")[0]).toMatchObject({ status: "sent" });
    expect(rows("message_log").find((m) => m.to_addr === DANA_PHONE)).toMatchObject({ sent_by: "customer_care" });
    // Exactly once.
    expect(await sweepCheckins(db.client, tomorrow + 5 * 60_000)).toBe(0);
    expect(smsTo(DANA_PHONE)).toHaveLength(1);
    expect(smsTo("+17055550333")).toHaveLength(0);
  });

  it("a per-service override sets the warranty; 0 months → no warranty row", async () => {
    rows("bookings")[0].service_item_id = ITEM;
    rows("warranty_terms").push({ id: "wt1", organization_id: ORG, company_id: CO, service_catalog_item_id: ITEM, months: 60, terms_text: "Leaks from our work" });
    await sweepJobs(db.client, NOW);
    expect(rows("job_warranties")[0]).toMatchObject({ months: 60, ends_on: "2031-10-12", terms_text: "Leaks from our work", source: "item" });
    db = seed();
    resetCareCompanyCache();
    rows("companies")[0].ai_settings = { customer_care: { warranty: { months: 0 } } };
    await sweepJobs(db.client, NOW);
    expect(rows("job_warranties")).toHaveLength(0);
    expect(rows("care_checkins")).toHaveLength(1);
  });

  it("a review request due the same day moves the check-in a day; the review request itself is untouched", async () => {
    const review = { id: "rr1", organization_id: ORG, company_id: CO, contact_id: DANA, booking_id: JOB, source: "job_done", status: "scheduled", scheduled_for: "2026-10-13T15:00:00Z", sent_at: null };
    rows("review_requests").push({ ...review });
    await sweepJobs(db.client, NOW);
    expect(rows("care_checkins")[0]).toMatchObject({ send_at: "2026-10-14T14:00:00.000Z", pushes: 1 });
    expect(rows("review_requests")).toEqual([review]);
  });

  it("skips: under the minimum job size, no cell, the customer texted in the last 24 h", async () => {
    rows("companies")[0].ai_settings = { customer_care: { checkins: { min_job_cents: 2_000_000 } } };
    await sweepJobs(db.client, NOW);
    expect(rows("care_checkins")[0]).toMatchObject({ status: "skipped", reason: "under the minimum job size" });
    expect(rows("job_warranties")).toHaveLength(1);

    db = seed();
    resetCareCompanyCache();
    await sweepJobs(db.client, NOW);
    const tomorrow = Date.parse("2026-10-13T14:00:00Z");
    vi.setSystemTime(tomorrow);
    rows("message_log").push({ id: "in1", organization_id: ORG, company_id: CO, contact_id: DANA, direction: "inbound", channel: "sms", body: "thanks guys", created_at: "2026-10-13T12:00:00Z" });
    await sweepCheckins(db.client, tomorrow);
    expect(rows("care_checkins")[0]).toMatchObject({ status: "skipped", reason: "the customer texted in the last 24 hours" });
    expect(smsTo(DANA_PHONE)).toHaveLength(0);
  });

  it("never at night: due at 10:00 but a worker that was down until 21:30 waits for the morning", async () => {
    await sweepJobs(db.client, NOW);
    const night = Date.parse("2026-10-14T01:30:00Z"); // Tue 21:30 local
    vi.setSystemTime(night);
    expect(await sweepCheckins(db.client, night)).toBe(0);
    expect(rows("care_checkins")[0].status).toBe("scheduled");
    const morning = Date.parse("2026-10-14T13:05:00Z");
    vi.setSystemTime(morning);
    expect(await sweepCheckins(db.client, morning)).toBe(1);
  });

  it("a callback / warranty visit gets no check-in and no new warranty", async () => {
    rows("care_case_bookings").push({ id: "ccb", organization_id: ORG, company_id: CO, case_id: "case-x", booking_id: JOB, kind: "callback" });
    expect(await sweepJobs(db.client, NOW)).toBe(0);
    expect(rows("care_checkins")).toHaveLength(0);
    expect(rows("job_warranties")).toHaveLength(0);
  });
});

// ── Replies ─────────────────────────────────────────────────────────────────────────

describe("record_job_feedback", () => {
  it("5/5: thanks only — no case, no owner text, no review ask, review requests untouched", async () => {
    sentCheckin();
    rows("review_requests").push({ id: "rr1", organization_id: ORG, company_id: CO, contact_id: DANA, status: "scheduled", scheduled_for: "2026-10-12T18:00:00Z" });
    const before = JSON.stringify(rows("review_requests"));
    const state = turn("5!! great job");
    const { result } = await runTool(state, "record_job_feedback", { rating: 5, comment: "great job" });
    expect(result).toMatchObject({ ok: true, recorded: true });
    expect(String(result.tell_customer)).toContain("Don't ask for a review");
    expect(rows("care_checkins")[0]).toMatchObject({ rating: 5, comment: "great job" });
    expect(rows("care_cases")).toHaveLength(0);
    expect(ownerTexts()).toHaveLength(0);
    expect(JSON.stringify(rows("review_requests"))).toBe(before);
  });

  it("no check-in sent → not a check-in answer", async () => {
    const { result } = await runTool(turn(), "record_job_feedback", { rating: 2 });
    expect(result).toMatchObject({ ok: false });
    expect(rows("care_cases")).toHaveLength(0);
  });

  it("2/5: a case and ONE owner text with both codes; a second unhappy text adds to the same case", async () => {
    sentCheckin();
    const state = turn();
    const { result } = await runTool(state, "record_job_feedback", { rating: 2, comment: "still leaking by the chimney" });
    expect(result).toMatchObject({ ok: true, owner_told: true });
    expect(String(result.tell_customer)).toContain("Mike will follow up");
    expect(rows("care_cases")).toHaveLength(1);
    expect(rows("care_cases")[0]).toMatchObject({ kind: "complaint", status: "open", rating: 2, opened_via: "checkin", owner_alert_status: "sent" });
    const approvals = rows("owner_approvals");
    expect(approvals.map((a) => [a.kind, (a.payload as Record<string, unknown>).option, a.short_code, a.notified_to])).toEqual([
      ["care_followup", "visit", 1, OWNER],
      ["care_followup", "call", 2, OWNER],
    ]);
    expect(ownerTexts()).toEqual([
      'CrankLeads: Dana Jones rated the roof replacement job 2/5: "still leaking by the chimney". Y 1 books a callback visit (I\'ll text them times). Y 2 texts them "Mike will call you today." N 1 to leave it.',
    ]);
    expect(state.effects.approvals.map((a) => a.kind)).toEqual(["care_followup", "care_followup"]);
    await runTool(turn("and the gutter is loose"), "record_job_feedback", { comment: "the gutter is loose", unhappy: true });
    expect(rows("care_cases")).toHaveLength(1);
    expect(String(rows("care_cases")[0].notes)).toContain("the gutter is loose");
    expect(ownerTexts()).toHaveLength(1);
  });

  it("at night the owner text waits for 08:00 (and Y can't land on it before then)", async () => {
    const night = Date.parse("2026-10-13T02:00:00Z"); // 22:00 local
    vi.setSystemTime(night);
    sentCheckin({ sent_at: "2026-10-12T14:00:00Z" });
    await runTool(turn(), "record_job_feedback", { rating: 1 });
    expect(ownerTexts()).toHaveLength(0);
    expect(rows("owner_approvals").every((a) => a.notified_to === null)).toBe(true);
    await ownerSays("Y 1");
    expect(rows("owner_approvals").every((a) => a.status === "pending")).toBe(true);
    const morning = Date.parse("2026-10-13T12:05:00Z"); // 08:05 local
    vi.setSystemTime(morning);
    sendSms.mockClear();
    resetCareCompanyCache();
    await sweepOutbox(db.client, morning);
    expect(ownerTexts()).toHaveLength(1);
    expect(ownerTexts()[0]).toContain("rated the roof replacement job 1/5");
    expect(rows("owner_approvals").every((a) => a.notified_to === OWNER)).toBe(true);
  });
});

// ── care_followup end to end ─────────────────────────────────────────────────────────

async function unhappy(): Promise<void> {
  sentCheckin();
  await runTool(turn(), "record_job_feedback", { rating: 2, comment: "still leaking by the chimney" });
  sendSms.mockClear();
}

describe("care_followup through the owner channel", () => {
  it("Y 1 (visit): Dana is texted three open times; her pick is booked as a callback that's never invoiced", async () => {
    await unhappy();
    await ownerSays("Y 1");
    expect(ownerTexts()).toEqual([
      "CrankLeads: Texted Dana Jones times for a callback visit: Wed Oct 14 in the morning; Wed Oct 14 in the afternoon; Thu Oct 15 in the morning. I'll book the one they pick.",
    ]);
    const offer = smsTo(DANA_PHONE);
    expect(offer).toHaveLength(1);
    expect(offer[0].from).toBe(BUSINESS_NUMBER);
    expect(offer[0].body).toContain(
      "Hi Dana, it's Northshore Roofing. Mike would like to come back and take a look at the roof replacement. Would any of these work: Wed Oct 14 in the morning, Wed Oct 14 in the afternoon or Thu Oct 15 in the morning? Just reply with the one that suits.",
    );
    const [visit, call] = rows("owner_approvals");
    expect(visit.status).toBe("executed");
    expect(call.status).toBe("superseded");
    expect(rows("care_cases")[0]).toMatchObject({ followup: "visit", visit_kind: "callback", visit_stage: "offered" });

    // Idempotent: a second answer does nothing more.
    sendSms.mockClear();
    const again = await decideApproval(db.client, String(visit.id), { approved: true, ownerNote: null, decidedVia: "app", decidedBy: "x" });
    expect(again.outcome).toBe("already");
    expect(smsTo(DANA_PHONE)).toHaveLength(0);

    // Dana picks Thursday morning.
    const state = turn("thursday morning works");
    const { result } = await runTool(state, "book_care_visit", { date: "2026-10-15", window: "morning" });
    expect(result).toMatchObject({ ok: true, booked: "Thu Oct 15 in the morning" });
    const visitBooking = rows("bookings").find((b) => b.source === "customer_care")!;
    expect(visitBooking).toMatchObject({ title: "Callback: Roof replacement (Dana Jones)", status: "pending", contact_id: DANA, scheduled_for: "2026-10-15T13:00:00.000Z", window_key: "morning", duration_minutes: 180 });
    expect(rows("care_case_bookings")).toEqual([expect.objectContaining({ booking_id: visitBooking.id, kind: "callback", case_id: rows("care_cases")[0].id })]);
    expect(rows("care_cases")[0]).toMatchObject({ status: "scheduled", visit_stage: "booked" });
    expect(ownerTexts()).toEqual(["CrankLeads: Booked Dana Jones's callback visit for Thu Oct 15 in the morning (no charge - it won't be invoiced). It's pending on your calendar."]);
    // A repeat of the same tool call doesn't book twice.
    const { result: repeat } = await runTool(turn(), "book_care_visit", { date: "2026-10-15", window: "morning" });
    expect(repeat).toMatchObject({ ok: true, already_booked: true });
    expect(rows("bookings").filter((b) => b.source === "customer_care")).toHaveLength(1);
  });

  it("a time that just went: the case stays offered with fresh alternatives", async () => {
    await unhappy();
    await ownerSays("Y 1");
    slots = slots.filter((s) => s.date !== "2026-10-15");
    const { result } = await runTool(turn(), "book_care_visit", { date: "2026-10-15", window: "morning" });
    expect(result).toMatchObject({ ok: false, reason: "not_open" });
    expect(rows("care_cases")[0].visit_stage).toBe("offered");
    expect(rows("bookings").filter((b) => b.source === "customer_care")).toHaveLength(0);
  });

  it("Y 2 (call): Dana gets \"Mike will call you today\"; the assistant steps back; the visit row is withdrawn", async () => {
    await unhappy();
    await ownerSays("Y 2");
    expect(smsTo(DANA_PHONE).map((m) => m.body)).toEqual([expect.stringContaining("Hi Dana, it's Northshore Roofing. Mike will call you today about the roof replacement.")]);
    expect(ownerTexts()).toEqual(["CrankLeads: Texted Dana Jones that you'll call today. Their number: 705-555-0123."]);
    expect(rows("owner_approvals").map((a) => a.status)).toEqual(["superseded", "executed"]);
    expect(rows("sms_conversations")[0]).toMatchObject({ state: "owner" });
    expect(rows("care_cases")[0]).toMatchObject({ followup: "call", visit_stage: "owner_calls", status: "open" });
  });

  it("N 1: nothing to Dana, the case stays open; expiry tells the owner", async () => {
    await unhappy();
    await ownerSays("N 1");
    expect(smsTo(DANA_PHONE)).toHaveLength(0);
    expect(ownerTexts()[0]).toContain("OK - nothing sent to Dana Jones. The case stays open");
    expect(rows("owner_approvals").map((a) => a.status)).toEqual(["rejected", "superseded"]);

    db = seed();
    resetCareCompanyCache();
    await unhappy();
    const later = NOW + 3 * DAY;
    vi.setSystemTime(later);
    const visit = rows("owner_approvals")[0];
    await expireApproval(db.client, visit as never, later);
    expect(smsTo(DANA_PHONE)).toHaveLength(0);
    expect(ownerTexts()[0]).toContain("No answer on #1, so nothing was sent to Dana Jones");
    expect(rows("owner_approvals")[1].status).toBe("superseded");
    expect(rows("care_cases")[0]).toMatchObject({ status: "open", followup: "expired" });
  });

  it("Y at 22:00: the times go at 9am (outbox), not at night", async () => {
    await unhappy();
    const night = Date.parse("2026-10-13T02:00:00Z");
    vi.setSystemTime(night);
    await ownerSays("Y 1");
    expect(smsTo(DANA_PHONE)).toHaveLength(0);
    expect(ownerTexts()[0]).toContain("It's late, so I'll text Dana Jones times for a callback visit at 9am tomorrow");
    const nine = Date.parse("2026-10-13T13:01:00Z");
    vi.setSystemTime(nine);
    resetCareCompanyCache();
    await sweepOutbox(db.client, nine);
    expect(smsTo(DANA_PHONE)).toHaveLength(1);
    expect(rows("care_messages")[0]).toMatchObject({ kind: "visit_offer", status: "sent" });
  });

  it("no open times: Dana is told Mike will call to set a time", async () => {
    slots = [];
    await unhappy();
    await ownerSays("Y 1");
    expect(smsTo(DANA_PHONE)[0].body).toContain("Mike will call you to set up a time to come back and look at the roof replacement.");
    expect(ownerTexts()[0]).toContain("No open times on your calendar, so I told Dana Jones you'll call to set a time");
  });
});

// ── Warranty ────────────────────────────────────────────────────────────────────────

function warranty(over: Record<string, unknown> = {}) {
  rows("job_warranties").push({ id: "jw1", organization_id: ORG, company_id: CO, contact_id: DANA, booking_id: JOB, job_label: "roof replacement", starts_on: "2026-05-04", ends_on: "2027-05-04", months: 12, terms_text: null, source: "default", ...over });
}

describe("check_warranty and warranty_claim", () => {
  it("under warranty: facts for the agent, the owner asked; Y texts no-charge visit times", async () => {
    warranty();
    const state = turn("the roof is leaking again");
    const { result } = await runTool(state, "check_warranty", { problem: "the roof leaks", job_hint: "roof" });
    expect(result).toMatchObject({ ok: true, owner_asked: true });
    expect(String(result.tell_customer)).toContain("Don't say it's covered");
    expect((result.past_jobs as unknown[])[0]).toMatchObject({ job: "roof replacement", still_under_warranty: true });
    expect(ownerTexts()).toEqual([
      'CrankLeads: #1 Dana Jones says "the roof leaks" (job May 4, 2026; 12-month workmanship warranty to May 4, 2027). Y books a no-charge warranty visit (I\'ll text them times), N and I\'ll tell them you\'ll call. Reply Y 1 or N 1.',
    ]);
    expect(rows("care_cases")[0]).toMatchObject({ kind: "warranty", opened_via: "sms_agent", warranty_id: "jw1" });
    // One open claim per customer.
    const { result: again } = await runTool(turn(), "check_warranty", { problem: "still leaking" });
    expect(again).toMatchObject({ already_asked: true });
    expect(rows("owner_approvals")).toHaveLength(1);

    sendSms.mockClear();
    await ownerSays("Y 1");
    expect(smsTo(DANA_PHONE)[0].body).toContain("Mike would like to come back and look at the roof replacement - no charge for the visit.");
    expect(ownerTexts()[0]).toContain("Texted Dana Jones times for a no-charge warranty visit");
    await runTool(turn(), "book_care_visit", { date: "2026-10-14", window: "afternoon" });
    expect(rows("bookings").find((b) => b.source === "customer_care")).toMatchObject({ title: "Warranty visit: Roof replacement (Dana Jones)" });
    expect(rows("care_case_bookings")[0]).toMatchObject({ kind: "warranty" });
  });

  it("N: Dana is told Mike will call; expiry does the same and tells the owner", async () => {
    warranty();
    await runTool(turn(), "check_warranty", { problem: "roof leaks" });
    sendSms.mockClear();
    await ownerSays("N 1");
    expect(smsTo(DANA_PHONE)[0].body).toContain("Hi Dana, it's Northshore Roofing. Mike will give you a call about the roof replacement.");
    expect(ownerTexts()[0]).toBe("CrankLeads: OK - I told Dana Jones you'll give them a call. Their number: 705-555-0123.");
    expect(rows("sms_conversations")[0]).toMatchObject({ state: "owner" });

    db = seed();
    resetCareCompanyCache();
    warranty();
    await runTool(turn(), "check_warranty", { problem: "roof leaks" });
    sendSms.mockClear();
    const later = NOW + 3 * DAY;
    vi.setSystemTime(later);
    await expireApproval(db.client, rows("owner_approvals")[0] as never, later);
    expect(smsTo(DANA_PHONE)).toHaveLength(1);
    expect(ownerTexts()[0]).toContain("No answer on #1, so I told Dana Jones you'll give them a call");
  });

  it("nothing under warranty → hand off (no case, no approval); manufacturer warranty on equipment counts", async () => {
    warranty({ ends_on: "2026-09-01" });
    const { result } = await runTool(turn(), "check_warranty", { problem: "roof leaks" });
    expect(result).toMatchObject({ under_warranty: false });
    expect(String(result.tell_customer)).toContain("hand_off_to_owner");
    expect(rows("care_cases")).toHaveLength(0);
    rows("installed_equipment").push({ id: "eq1", organization_id: ORG, company_id: CO, contact_id: DANA, booking_id: null, make: "Lennox", model: "EL296", serial: "5819", installed_on: "2025-11-02", manufacturer_warranty_ends: "2035-11-02", active: true });
    await runTool(turn(), "check_warranty", { problem: "the lennox furnace won't start" });
    expect(String(rows("owner_approvals")[0].summary)).toContain("(Lennox EL296 installed Nov 2, 2025; manufacturer warranty to Nov 2, 2035)");
  });

  it("A1: the tools are off (the old hand-off rule stands)", async () => {
    const state = { ...turn(), facts: { ...FACTS, organizationId: HOUSE_ORG, companyId: HOUSE_CO }, contact: rows("contacts")[1] } as unknown as TurnState;
    const { result } = await runTool(state, "check_warranty", { problem: "leak" });
    expect(result).toMatchObject({ ok: false });
    expect(rows("care_cases")).toHaveLength(0);
  });
});

// ── Owner tools, briefing, settings ─────────────────────────────────────────────────

describe("owner tools", () => {
  it("care_status, warranty_lookup, add_equipment, resolve_case", async () => {
    await unhappy();
    warranty();
    const status = await tool("care_status").run(ownerState(), {});
    expect(status).toMatchObject({ ok: true, open_count: 1, checkins_last_30_days: 1, average_rating_last_30_days: "2/5 (1 ratings)" });
    expect((status.open_cases as Array<Record<string, unknown>>)[0]).toMatchObject({ customer: '"Dana Jones"', kind: "unhappy", rating: "2/5", status: "waiting on you" });

    const added = await tool("add_equipment").run(ownerState(), { customer: "Dana Jones", make: "Lennox", model: "EL296", manufacturer_warranty_ends: "2035-11-02" });
    expect(added).toEqual({ ok: true, tell_owner: "Saved: Lennox EL296 for Dana Jones, manufacturer warranty to Nov 2, 2035." });
    const lookup = await tool("warranty_lookup").run(ownerState(), { customer: "705-555-0123" });
    expect(lookup).toMatchObject({ ok: true, customer: '"Dana Jones"' });
    expect((lookup.jobs as unknown[])[0]).toMatchObject({ job: "roof replacement", warranty: "12 months to May 4, 2027", active: true });
    expect((lookup.equipment as unknown[])[0]).toMatchObject({ equipment: '"Lennox EL296"', active: true });

    const resolved = await tool("resolve_case").run(ownerState(), { customer: "Dana", note: "fixed the flashing" });
    expect(resolved).toEqual({ ok: true, tell_owner: "Marked Dana Jones's case resolved." });
    expect(rows("care_cases")[0]).toMatchObject({ status: "resolved" });
    expect(rows("owner_approvals").map((a) => a.status)).toEqual(["superseded", "superseded"]);
  });

  it("A1's owner gets nothing from them", async () => {
    const state = { ...ownerState(), scope: { organizationId: HOUSE_ORG, companyId: HOUSE_CO, companyName: "A1 Marine Care", timeZone: TZ } };
    expect(await tool("care_status").run(state, {})).toHaveProperty("error");
  });
});

describe("briefing items", () => {
  it("unhappy customers waiting, and today's care visits; [] when off; never throws", async () => {
    expect(await briefingItems(db.client, { organizationId: ORG, companyId: CO }, "2026-10-12")).toEqual([]);
    await unhappy();
    expect(await briefingItems(db.client, { organizationId: ORG, companyId: CO }, "2026-10-12")).toEqual(["1 unhappy customer waiting (Dana Jones 2/5)"]);
    await ownerSays("Y 1");
    await runTool(turn(), "book_care_visit", { date: "2026-10-14", window: "morning" });
    expect(await briefingItems(db.client, { organizationId: ORG, companyId: CO }, "2026-10-14")).toEqual(["Callback visit for Dana today"]);
    expect(await briefingItems(db.client, { organizationId: HOUSE_ORG, companyId: HOUSE_CO }, "2026-10-14")).toEqual([]);
    db.failNext("companies", "select");
    expect(await briefingItems(db.client, { organizationId: ORG, companyId: CO }, "2026-10-14")).toEqual([]);
  });
});

describe("settings view and actions", () => {
  it("members don't see cases; owners save terms and equipment; the PATCH merges only customer_care", async () => {
    await unhappy();
    const member = await getCustomerCareView(db.client, { organizationId: ORG, companyId: CO }, { manager: false });
    expect(member?.cases).toBeNull();
    expect(member?.stats).toMatchObject({ checkinsSent30: 1, openCases: 1, averageRating: 2 });
    expect(await saveWarrantyTerm(db.client, { organizationId: ORG, companyId: CO }, { catalogItemId: ITEM, months: 24 })).toEqual({ ok: true });
    expect(await saveWarrantyTerm(db.client, { organizationId: ORG, companyId: CO }, { catalogItemId: "e0000000-0000-4000-8000-000000000009", months: 24 })).toHaveProperty("error");
    expect(await saveEquipment(db.client, { organizationId: ORG, companyId: CO }, { customer: "Dana", make: "Navien" })).toEqual({ ok: true });
    expect(await saveEquipment(db.client, { organizationId: ORG, companyId: CO }, { customer: "Nobody", make: "Navien" })).toHaveProperty("error");
    const view = await updateCustomerCareSettings(db.client, { organizationId: ORG, companyId: CO }, { checkins: { time: "11:00" } });
    expect(view?.cases).toHaveLength(1);
    expect(view?.catalog[0]).toMatchObject({ months: 24 });
    expect(view?.equipment[0]).toMatchObject({ name: "Navien", customer: "Dana Jones" });
    expect(rows("companies")[0].ai_settings).toEqual({ customer_care: { checkins: { time: "11:00" }, any_on: false } });
  });
});

describe("hours", () => {
  it("a check-in is never planned before 09:00 when the job finished late (next day, setting time)", () => {
    const c = { timeZone: TZ, settings: readCustomerCareSettings({ customer_care: { checkins: { time: "09:30", delay_days: 2 } } }, { doneForYou: true }) };
    expect(new Date(plannedSendAt(Date.parse("2026-10-13T03:30:00Z"), c)).toISOString()).toBe("2026-10-14T13:30:00.000Z");
    expect(HOUR).toBe(3_600_000);
  });
});

// ── Review fixes ────────────────────────────────────────────────────────────────────

describe("review fixes", () => {
  const HOURLY = { ...FACTS, bookingMode: "hourly", bookingPolicy: null, onlineBooking: { slotMinutes: 60 } } as unknown as BusinessFacts;
  const hourlyTurn = () => ({ ...turn("2pm works"), facts: HOURLY }) as unknown as TurnState;

  async function hourlyOffer() {
    slots = [
      { date: "2026-10-14", window: null, startsAt: "2026-10-14T13:00:00.000Z", label: "Wed Oct 14, 9:00 a.m." },
      { date: "2026-10-14", window: null, startsAt: "2026-10-14T18:00:00.000Z", label: "Wed Oct 14, 2:00 p.m." },
    ];
    setVisitDeps({
      loadFacts: async () => HOURLY,
      availability: async (_a, _f, input) => ({ ok: true, mode: "hourly", slots: slots.filter((s) => !input.preferredDate || s.date >= (input.preferredDate as string)).slice(0, input.limit ?? 3) }),
    });
    await unhappy();
    await ownerSays("Y 1");
  }

  it("hourly: the customer picks 2pm (the 2nd time listed) → books 14:00, not the first time that day", async () => {
    await hourlyOffer();
    const { result } = await runTool(hourlyTurn(), "book_care_visit", { pick: 2 });
    expect(result).toMatchObject({ ok: true, booked: "Wed Oct 14, 2:00 p.m." });
    expect(rows("bookings").find((b) => b.source === "customer_care")).toMatchObject({ scheduled_for: "2026-10-14T18:00:00.000Z", window_key: null, duration_minutes: 60 });
  });

  it("hourly: a bare date with two times that day asks which one; a local starts_at is read in the company's zone", async () => {
    await hourlyOffer();
    const { result } = await runTool(hourlyTurn(), "book_care_visit", { date: "2026-10-14" });
    expect(result).toMatchObject({ ok: false, reason: "which_one", offered: [{ pick: 1, time: "Wed Oct 14, 9:00 a.m." }, { pick: 2, time: "Wed Oct 14, 2:00 p.m." }] });
    expect(rows("bookings").filter((b) => b.source === "customer_care")).toHaveLength(0);
    const { result: ok } = await runTool(hourlyTurn(), "book_care_visit", { starts_at: "2026-10-14T14:00" });
    expect(ok).toMatchObject({ ok: true, booked: "Wed Oct 14, 2:00 p.m." });
    expect(rows("bookings").find((b) => b.source === "customer_care")?.scheduled_for).toBe("2026-10-14T18:00:00.000Z");
  });

  it("a done visit resolves its case; a cancelled visit reopens it and tells the owner; a booked claim doesn't block a new one", async () => {
    warranty();
    await runTool(turn(), "check_warranty", { problem: "the roof leaks" });
    await ownerSays("Y 1");
    await runTool(turn(), "book_care_visit", { pick: 1 });
    const visit = rows("bookings").find((b) => b.source === "customer_care")!;
    expect(rows("care_cases")[0].status).toBe("scheduled");
    // While booked, a new problem can be claimed.
    rows("job_warranties").push({ id: "jw2", organization_id: ORG, company_id: CO, contact_id: DANA, booking_id: "b-gutter", job_label: "gutter install", starts_on: "2026-08-01", ends_on: "2027-08-01", months: 12, source: "default" });
    const { result } = await runTool(turn(), "check_warranty", { problem: "the gutter is loose" });
    expect(result).toMatchObject({ owner_asked: true });

    // Cancelled → open again, owner told once.
    visit.status = "cancelled";
    rows("activity_events").push({ id: "ev3", organization_id: ORG, company_id: CO, entity_id: visit.id, event_type: "booking.cancelled", occurred_at: new Date(NOW).toISOString() });
    sendSms.mockClear();
    await sweepJobs(db.client, NOW);
    await sweepJobs(db.client, NOW + 60_000);
    expect(rows("care_cases")[0]).toMatchObject({ status: "open", visit_stage: "owner_calls" });
    expect(ownerTexts()).toEqual([expect.stringContaining("Dana Jones's warranty visit (Wed, Oct 14, 9:00 a.m.) was cancelled, so their case is open again.")]);

    // Re-booked and done → resolved.
    rows("care_cases")[0].status = "scheduled";
    visit.status = "completed";
    rows("activity_events").push({ id: "ev4", organization_id: ORG, company_id: CO, entity_id: visit.id, event_type: "booking.completed", occurred_at: new Date(NOW).toISOString() });
    await sweepJobs(db.client, NOW + 120_000);
    expect(rows("care_cases")[0]).toMatchObject({ status: "resolved" });
    expect(rows("care_checkins").filter((c) => c.booking_id === visit.id)).toHaveLength(0);
  });

  it("review within 24 h either way moves the check-in once; still clashing → it goes anyway", async () => {
    rows("review_requests").push(
      { id: "rr1", organization_id: ORG, company_id: CO, contact_id: DANA, status: "scheduled", scheduled_for: "2026-10-13T08:00:00Z", sent_at: null },
      { id: "rr2", organization_id: ORG, company_id: CO, contact_id: DANA, status: "scheduled", scheduled_for: "2026-10-14T20:00:00Z", sent_at: null },
    );
    await sweepJobs(db.client, NOW);
    expect(rows("care_checkins")[0]).toMatchObject({ send_at: "2026-10-14T14:00:00.000Z", pushes: 1 });
    const due = Date.parse("2026-10-14T14:00:00Z");
    vi.setSystemTime(due);
    expect(await sweepCheckins(db.client, due)).toBe(1);
  });

  it("one check-in per customer per day, even for two jobs", async () => {
    const second = booking("b0000000-0000-4000-8000-000000000003", { title: "Gutter install — Dana Jones" });
    rows("bookings").push(second);
    rows("activity_events").push({ id: "ev5", organization_id: ORG, company_id: CO, entity_id: second.id, event_type: "booking.completed", occurred_at: "2026-10-12T13:30:00Z" });
    await sweepJobs(db.client, NOW);
    expect(rows("care_checkins").filter((c) => c.status === "scheduled")).toHaveLength(2);
    // Simulate a worker that already sent the first one's claim but not its row.
    const due = Date.parse("2026-10-13T14:00:00Z");
    vi.setSystemTime(due);
    rows("care_checkin_claims").push({ id: "cl", organization_id: ORG, company_id: CO, contact_id: DANA, local_date: "2026-10-13" });
    await sweepCheckins(db.client, due);
    expect(smsTo(DANA_PHONE)).toHaveLength(0);
    expect(rows("care_checkins").map((c) => c.reason)).toEqual(["already checked in with them today", "already checked in with them today"]);
  });

  it("an offer unanswered for 14 days goes to the owner; a stuck booking claim is released", async () => {
    await unhappy();
    await ownerSays("Y 1");
    rows("care_cases")[0].visit_stage = "booking";
    rows("care_cases")[0].updated_at = new Date(NOW - 20 * 60_000).toISOString();
    resetCareCompanyCache();
    await sweepOutbox(db.client, NOW);
    expect(rows("care_cases")[0].visit_stage).toBe("offered");
    const later = NOW + 15 * DAY;
    vi.setSystemTime(later);
    const { result } = await runTool(turn(), "book_care_visit", { pick: 1 });
    expect(result).toMatchObject({ ok: false });
    sendSms.mockClear();
    resetCareCompanyCache();
    await sweepOutbox(db.client, later);
    expect(rows("care_cases")[0].visit_stage).toBe("owner_calls");
    expect(ownerTexts()).toEqual([expect.stringContaining("Dana Jones never picked a time for the callback visit")]);
  });

  it("check_warranty never falls back to an unrelated job", async () => {
    warranty();
    const { result } = await runTool(turn(), "check_warranty", { problem: "the deck boards are lifting" });
    expect(result).toMatchObject({ no_matching_job: true, under_warranty: false });
    expect(rows("owner_approvals")).toHaveLength(0);
  });

  it("chooseTerm: an item without an override counts with the default", () => {
    expect(chooseTerm({ months: 24, terms: null }, [{ months: 12, terms_text: "x" }], 2)).toEqual({ months: 24, terms: null, source: "default" });
    expect(chooseTerm({ months: 24, terms: null }, [{ months: 12, terms_text: "x" }], 1)).toEqual({ months: 12, terms: "x", source: "item" });
  });

  it("the role switched off after asking: Y texts nobody, the owner is told", async () => {
    warranty();
    await runTool(turn(), "check_warranty", { problem: "the roof leaks" });
    rows("companies")[0].ai_settings = { customer_care: { enabled: false } };
    sendSms.mockClear();
    await ownerSays("Y 1");
    expect(smsTo(DANA_PHONE)).toHaveLength(0);
    expect(ownerTexts()[0]).toContain("Customer care is off for Northshore Roofing now, so I didn't text Dana Jones.");
  });

  it("the owner is handling Dana's texts: Y doesn't offer times, the owner is told to call", async () => {
    warranty();
    await runTool(turn(), "check_warranty", { problem: "the roof leaks" });
    rows("sms_conversations").push({ id: "conv-1", organization_id: ORG, company_id: CO, contact_id: DANA, state: "owner", owner_takeover_at: new Date(NOW - HOUR).toISOString(), collected: {} });
    sendSms.mockClear();
    await ownerSays("Y 1");
    expect(smsTo(DANA_PHONE)).toHaveLength(0);
    expect(ownerTexts()[0]).toContain("You're handling Dana Jones's texts right now, so I didn't text them times.");
  });

  it("the alert: STOPped owner → no retries; several businesses → the name first", async () => {
    rows("platform_sms_opt_outs").push({ phone_e164: OWNER, opted_out_at: "2026-10-01T00:00:00Z", opted_in_at: null });
    sentCheckin();
    await runTool(turn(), "record_job_feedback", { rating: 2 });
    expect(rows("care_cases")[0].owner_alert_status).toBe("none");

    db = seed();
    resetCareCompanyCache();
    rows("companies")[1].owner_phone_e164 = OWNER;
    sentCheckin();
    await runTool(turn(), "record_job_feedback", { rating: 2, comment: "leaking" });
    expect(ownerTexts()[0]).toMatch(/^CrankLeads: Northshore Roofing: Dana Jones rated/);
  });
});
