/**
 * The AI Office manager (docs/ai-staff.md → "Office manager"): the owner's morning briefing.
 * Settings defaults (on for done-for-you, off for house orgs like A1), the composer (parts, quiet
 * day, the 4-segment cap), DST for America/Toronto, the sweep against the fake DB (once per day
 * with two workers, retry after a failed send, house org off), the Bookkeeper's 8am alert folded
 * in, weather only when the Dispatcher's check is on, the email copy, briefing_now and the route.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "@/test/helpers/fake-supabase";

const h = vi.hoisted(() => ({ db: null as FakeDb | null, userId: "u-owner" }));
const sendSms = vi.fn((..._a: unknown[]) => Promise.resolve({ sid: `SM${Math.random().toString(36).slice(2, 8)}` }));
const sendEmail = vi.fn((..._a: unknown[]) => Promise.resolve({ id: "re_1" }));
vi.mock("@/server/outbound/sms", () => ({ sendSms: (...a: unknown[]) => sendSms(...a) }));
vi.mock("@/server/outbound/email", () => ({ sendEmail: (...a: unknown[]) => sendEmail(...a) }));
vi.mock("@/server/services/usage", () => ({ recordUsageSafe: vi.fn(), recordAiUsageSafe: vi.fn() }));
vi.mock("@/server/services/workflow-engine/dispatch", () => ({
  emitActivityEventAndDispatch: vi.fn(() => Promise.resolve({ activityEvent: {}, workflowEventJob: null })),
}));
vi.mock("@/server/supabase/admin", () => ({ createSupabaseAdminClient: () => h.db!.client }));
vi.mock("@/server/supabase/server", () => ({
  createSupabaseServerClient: () => {
    const client = h.db!.client as unknown as Record<string, unknown>;
    return { ...client, from: (t: string) => (client.from as (t: string) => unknown)(t), auth: { getUser: async () => ({ data: { user: { id: h.userId } }, error: null }) } };
  },
}));

import { GET, PATCH } from "@/app/api/organizations/[organizationId]/companies/[companyId]/ai-settings/office-manager/route";
import { decideApproval } from "@/server/services/owner-channel/approvals";
import { runDailyMoneyAlerts } from "@/server/services/staff/bookkeeper/daily-alert";
import type { Forecast, WeatherProvider } from "@/server/services/staff/dispatcher/weather";
import { clearWeatherMemoryCache } from "@/server/services/staff/dispatcher/weather";
import { officeManagerRole } from "@/server/services/staff/office-manager";
import { runMorningBriefings } from "@/server/services/staff/office-manager/briefing";
import { clock, composeBriefing, gsmPlain, MAX_BRIEFING_SEPTETS, sentence, septets, waitingLine, type BriefingInput } from "@/server/services/staff/office-manager/compose";
import { isNewLead, sinceWindow, type BriefingDeps } from "@/server/services/staff/office-manager/gather";
import { MAX_STAFF_ITEMS, pickFairly, staffBriefingItems } from "@/server/services/staff/office-manager/staff-items";
import { bookingForPo } from "@/server/services/staff/tax-clerk/receipts";
import {
  briefingDue,
  briefingTakesMoneyAlert,
  daysLabel,
  isBriefingTime,
  mergeOfficeManagerSettings,
  officeManagerActiveFor,
  readOfficeManagerSettings,
} from "@/server/services/staff/office-manager/settings";
import { activeRolesFor, registryProblems } from "@/server/services/staff/registry";
import { AGENT_TOOLS } from "@/server/services/sms-agent/tools";
import { OWNER_TOOLS } from "@/server/services/owner-channel/tools";

const ORG = "11111111-1111-1111-1111-111111111111";
const CO = "22222222-2222-2222-2222-222222222222";
const JAMIE = "33333333-3333-3333-3333-333333333333";
const PAT = "34343434-3434-3434-3434-343434343434";
const A1_ORG = "44444444-4444-4444-4444-444444444444";
const A1_CO = "55555555-5555-5555-5555-555555555555";
const OWNER = "+17055550142";
const A1_OWNER = "+17055550999";
const PLATFORM = "+17055550100";

// Tue Oct 13 2026 07:00 in Toronto (EDT, UTC-4).
const TUE_7AM = "2026-10-13T11:00:00Z";
const YESTERDAY = "2026-10-12T16:00:00Z"; // Mon noon local

const at = (iso: string) => vi.setSystemTime(new Date(iso));
const smsTo = (phone: string) => sendSms.mock.calls.map((c) => c[0] as { to: string; body: string; from?: string }).filter((m) => m.to === phone);
const rows = (table: string) => h.db!.tables[table] as Array<Record<string, unknown>>;

function booking(id: string, startIso: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, organization_id: ORG, company_id: CO, contact_id: JAMIE, title: "Roof repair", scheduled_for: startIso, duration_minutes: 120, window_key: null,
    location: "12 Bay St, Midland, ON", status: "confirmed", en_route_at: null, started_at: null, manage_token: `m-${id}`, service_item_id: null, ...over,
  };
}

function seed(extra: Record<string, Array<Record<string, unknown>>> = {}) {
  sendSms.mockClear();
  sendEmail.mockClear();
  const base: Record<string, Array<Record<string, unknown>>> = {
    organizations: [
      { id: ORG, platform_brand: "crankleads" },
      { id: A1_ORG, platform_brand: "empirevu" },
    ],
    companies: [
      {
        id: CO, organization_id: ORG, name: "Northshore Roofing", brand_from_name: null, timezone: "America/Toronto", owner_phone_e164: OWNER, owner_email: null,
        owner_phone_verified_at: "2026-10-01T00:00:00Z", ai_settings: {}, stage: "active", quote_public_base_url: null, invoice_settings: null, industry_pack: null,
        latitude: null, longitude: null, updated_at: "2026-10-01T00:00:00Z",
      },
      {
        id: A1_CO, organization_id: A1_ORG, name: "A1 Marine Care", brand_from_name: null, timezone: "America/Toronto", owner_phone_e164: A1_OWNER, owner_email: null,
        owner_phone_verified_at: "2026-10-01T00:00:00Z", ai_settings: {}, stage: "active", quote_public_base_url: null, invoice_settings: null, industry_pack: null,
        latitude: null, longitude: null, updated_at: "2026-10-01T00:00:00Z",
      },
    ],
    organization_memberships: [
      { organization_id: ORG, profile_id: "u-owner", role: "owner", phone_e164: null },
      { organization_id: ORG, profile_id: "u-member", role: "member", phone_e164: null },
      { organization_id: ORG, profile_id: "u-mike", role: "member", phone_e164: "+17055550301" },
      { organization_id: ORG, profile_id: "u-sam", role: "member", phone_e164: null },
    ],
    profiles: [
      { id: "u-owner", full_name: "Dana Whitfield", email: "dana@northshore.test" },
      { id: "u-member", full_name: "Lee Office", email: "lee@northshore.test" },
      { id: "u-mike", full_name: "Mike Brown", email: "mike@northshore.test" },
      { id: "u-sam", full_name: "Sam Helper", email: "sam@northshore.test" },
    ],
    contacts: [
      { id: JAMIE, organization_id: ORG, company_id: CO, first_name: "Jamie", last_name: "Lee", phone: "+17055550123", created_at: "2026-09-01T00:00:00Z", consent_source: "inbound_sms" },
      { id: PAT, organization_id: ORG, company_id: CO, first_name: "Pat", last_name: "Moss", phone: "+17055550124", created_at: "2026-09-01T00:00:00Z", consent_source: "inbound_sms" },
      // Yesterday's new leads (and an imported customer, which isn't one).
      { id: "lead-1", organization_id: ORG, company_id: CO, first_name: "Ann", created_at: YESTERDAY, consent_source: "web_form" },
      { id: "lead-2", organization_id: ORG, company_id: CO, first_name: "Bo", created_at: YESTERDAY, consent_source: null },
      { id: "imp-1", organization_id: ORG, company_id: CO, first_name: "Old", created_at: YESTERDAY, consent_source: "import" },
      { id: "lead-old", organization_id: ORG, company_id: CO, first_name: "Cy", created_at: "2026-10-11T16:00:00Z", consent_source: null },
    ],
    bookings: [
      booking("b1", "2026-10-13T12:00:00Z"), // 8am Mike
      booking("b2", "2026-10-13T14:00:00Z", { contact_id: PAT }), // 10am Mike
      booking("b3", "2026-10-13T17:00:00Z"), // 1pm Sam
      booking("b4", "2026-10-13T19:00:00Z"), // 3pm nobody
      booking("b-x", "2026-10-13T13:00:00Z", { status: "cancelled" }),
      booking("b-tom", "2026-10-14T13:00:00Z"),
    ],
    booking_assignments: [
      { organization_id: ORG, booking_id: "b1", profile_id: "u-mike" },
      { organization_id: ORG, booking_id: "b2", profile_id: "u-mike" },
      { organization_id: ORG, booking_id: "b3", profile_id: "u-sam" },
    ],
    tasks: [],
    invoices: [
      { id: "inv-1", organization_id: ORG, company_id: CO, contact_id: JAMIE, invoice_number: "INV-12", status: "sent", total_cents: 124000, credit_cents: 0, balance_due_cents: 124000, pending_payment_cents: 0, due_date: "2026-10-01", issue_date: "2026-09-17", sent_at: "2026-09-17T14:00:00Z", bill_to: null, public_token: "t1" },
      { id: "inv-2", organization_id: ORG, company_id: CO, contact_id: PAT, invoice_number: "INV-13", status: "sent", total_cents: 50000, credit_cents: 0, balance_due_cents: 50000, pending_payment_cents: 0, due_date: "2026-10-20", issue_date: "2026-10-06", sent_at: "2026-10-06T14:00:00Z", bill_to: null, public_token: "t2" },
    ],
    invoice_payments: [
      { id: "pay-1", organization_id: ORG, company_id: CO, invoice_id: "inv-9", amount_cents: 100000, status: "succeeded", received_at: YESTERDAY, created_at: YESTERDAY, updated_at: YESTERDAY },
      { id: "pay-old", organization_id: ORG, company_id: CO, invoice_id: "inv-9", amount_cents: 99900, status: "succeeded", received_at: "2026-10-11T16:00:00Z", created_at: "2026-10-11T16:00:00Z", updated_at: "2026-10-11T16:00:00Z" },
    ],
    quotes: [
      { id: "q1", organization_id: ORG, company_id: CO, sent_at: YESTERDAY, approved_at: "2026-10-12T18:00:00Z", approved_deposit_cents: null, deposit_paid_at: null },
      { id: "q2", organization_id: ORG, company_id: CO, sent_at: YESTERDAY, approved_at: null, approved_deposit_cents: null, deposit_paid_at: null },
      { id: "q3", organization_id: ORG, company_id: CO, sent_at: "2026-10-01T16:00:00Z", approved_at: "2026-10-02T16:00:00Z", approved_deposit_cents: 25000, deposit_paid_at: YESTERDAY },
    ],
    message_log: [
      { id: "m1", organization_id: ORG, company_id: CO, contact_id: JAMIE, sent_by: "sms_agent", channel: "sms", direction: "outbound", status: "sent", created_at: YESTERDAY },
      { id: "m2", organization_id: ORG, company_id: CO, contact_id: JAMIE, sent_by: "sms_agent", channel: "sms", direction: "outbound", status: "sent", created_at: YESTERDAY },
      { id: "m3", organization_id: ORG, company_id: CO, contact_id: PAT, sent_by: "sms_agent", channel: "sms", direction: "outbound", status: "sent", created_at: YESTERDAY },
      { id: "m4", organization_id: ORG, company_id: CO, contact_id: PAT, sent_by: null, channel: "sms", direction: "outbound", status: "sent", created_at: YESTERDAY },
    ],
    retell_calls: [
      { id: "c1", organization_id: ORG, company_id: CO, direction: "inbound", duration_ms: 60_000, in_voicemail: false, created_at: YESTERDAY },
      { id: "c2", organization_id: ORG, company_id: CO, direction: "inbound", duration_ms: 30_000, in_voicemail: true, created_at: YESTERDAY },
      { id: "c3", organization_id: ORG, company_id: CO, direction: "inbound", duration_ms: 3_000, in_voicemail: false, created_at: YESTERDAY },
    ],
    owner_approvals: [
      { id: "ap-12", organization_id: ORG, company_id: CO, contact_id: JAMIE, conversation_id: null, kind: "ai_estimate", summary: "AI estimate for Jamie Lee: Eavestrough repair $750 + HST.", payload: {}, status: "pending", short_code: 12, requested_by: "estimator", expires_at: "2026-10-14T11:00:00Z", created_at: "2026-10-12T15:00:00Z" },
      { id: "ap-13", organization_id: ORG, company_id: CO, contact_id: null, conversation_id: null, kind: "record_payment", summary: "Record $500 e-Transfer from Bob Jones on INV-9?", payload: {}, status: "pending", short_code: 13, requested_by: "owner", expires_at: "2026-10-14T11:00:00Z", created_at: "2026-10-12T16:00:00Z" },
      { id: "ap-old", organization_id: ORG, company_id: CO, contact_id: null, conversation_id: null, kind: "send_invoice_reminder", summary: "Expired one", payload: {}, status: "pending", short_code: 9, requested_by: "owner", expires_at: "2026-10-13T10:00:00Z", created_at: "2026-10-12T10:00:00Z" },
      { id: "ap-cmd", organization_id: ORG, company_id: CO, contact_id: null, conversation_id: null, kind: "owner_command", summary: "Cancel Jones?", payload: {}, status: "pending", short_code: 14, requested_by: "owner_command", expires_at: "2026-10-14T11:00:00Z", created_at: "2026-10-12T16:00:00Z" },
    ],
    owner_briefings: [],
    money_alerts: [],
    money_alert_items: [],
    invoice_collections: [],
    payment_plans: [],
    accounting_connections: [],
    accounting_sync_jobs: [],
    accounting_links: [],
    platform_sms_opt_outs: [],
    dispatch_weather_cache: [],
    service_catalog_items: [],
    crankleads_purchases: [],
    voice_numbers: [],
  };
  for (const [k, v] of Object.entries(extra)) base[k] = v;
  const db = createFakeDb(base, {
    owner_briefings: [["company_id", "local_date"]],
    owner_approvals: [["company_id", "short_code"]],
    money_alerts: [["company_id", "alert_date"]],
    money_alert_items: [["company_id", "item_key"]],
  });
  db.onRpc((name) => (name === "consume_rate_limit" ? { data: true, error: null } : { data: [], error: null }));
  h.db = db;
  return db;
}

function setSettings(companyIndex: number, patch: Record<string, unknown>) {
  rows("companies")[companyIndex].ai_settings = { ...(rows("companies")[companyIndex].ai_settings as Record<string, unknown>), ...patch };
}

const noWeather: BriefingDeps = { weatherProvider: () => ({ name: "none", forecast: vi.fn(async () => { throw new Error("weather must not be fetched"); }) }) };
const run = (deps: BriefingDeps = noWeather) => runMorningBriefings(h.db!.client, Date.now(), deps);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  at(TUE_7AM);
  process.env.TWILIO_FROM_NUMBER = PLATFORM;
  delete process.env.PLATFORM_SMS_NUMBER;
  delete process.env.WEATHER_PROVIDER;
  h.userId = "u-owner";
  clearWeatherMemoryCache();
  sendSms.mockReset();
  sendSms.mockImplementation(() => Promise.resolve({ sid: `SM${Math.random().toString(36).slice(2, 8)}` }));
  seed();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── Settings ─────────────────────────────────────────────────────────────────────

describe("settings", () => {
  it("on by default for done-for-you, off for house orgs (A1); 07:00 Monday-Saturday, text only", () => {
    expect(readOfficeManagerSettings({}, { doneForYou: true })).toEqual({ enabled: true, enabledIsDefault: true, time: "07:00", days: [1, 2, 3, 4, 5, 6], channels: ["sms"] });
    expect(readOfficeManagerSettings({}, { doneForYou: false }).enabled).toBe(false);
    expect(readOfficeManagerSettings({ office_manager: { enabled: true } }, { doneForYou: false }).enabled).toBe(true);
    expect(readOfficeManagerSettings({ office_manager: { time: "05:30", days: [], channels: ["email"] } }, { doneForYou: true })).toMatchObject({ time: "07:00", days: [1, 2, 3, 4, 5, 6], channels: ["sms", "email"] });
    expect(isBriefingTime("06:00")).toBe(true);
    expect(isBriefingTime("09:00")).toBe(true);
    expect(isBriefingTime("09:30")).toBe(false);
    expect(isBriefingTime("5:59")).toBe(false);
    expect(daysLabel([1, 2, 3, 4, 5, 6])).toBe("Monday to Saturday");
    expect(daysLabel([0, 1, 2, 3, 4, 5, 6])).toBe("every day");
    expect(daysLabel([0, 1, 3])).toBe("Mon, Wed, Sun");
  });

  it("merge touches only ai_settings.office_manager and ignores junk", () => {
    const merged = mergeOfficeManagerSettings({ collections: { enabled: false }, office_manager: { time: "06:30" } }, { enabled: true, days: [0, 6, 6, 9], emailCopy: true, time: "10:00" });
    expect(merged).toEqual({ collections: { enabled: false }, office_manager: { time: "06:30", enabled: true, days: [0, 6], channels: ["sms", "email"] } });
  });

  it("due from the set time until 11:00 local on briefing days", () => {
    const s = readOfficeManagerSettings({}, { doneForYou: true });
    expect(briefingDue(s, Date.parse("2026-10-13T10:59:00Z"), "America/Toronto")).toBe(false); // 06:59
    expect(briefingDue(s, Date.parse("2026-10-13T11:00:00Z"), "America/Toronto")).toBe(true); // 07:00
    expect(briefingDue(s, Date.parse("2026-10-13T14:59:00Z"), "America/Toronto")).toBe(true); // 10:59
    expect(briefingDue(s, Date.parse("2026-10-13T15:00:00Z"), "America/Toronto")).toBe(false); // 11:00
    expect(briefingDue(s, Date.parse("2026-10-18T12:00:00Z"), "America/Toronto")).toBe(false); // Sunday
    expect(briefingDue({ ...s, days: [0] }, Date.parse("2026-10-18T12:00:00Z"), "America/Toronto")).toBe(true);
  });
});

// ── DST (America/Toronto) ────────────────────────────────────────────────────────

describe("DST for America/Toronto", () => {
  it("07:00 local is 11:00Z in summer time and 12:00Z after the fall-back (Sun Nov 1 2026), and 11:00Z after spring-forward (Sun Mar 8 2026)", () => {
    const every = { ...readOfficeManagerSettings({}, { doneForYou: true }), days: [0, 1, 2, 3, 4, 5, 6] };
    const tz = "America/Toronto";
    expect(briefingDue(every, Date.parse("2026-10-31T11:00:00Z"), tz)).toBe(true); // Sat 07:00 EDT
    expect(briefingDue(every, Date.parse("2026-11-01T11:30:00Z"), tz)).toBe(false); // Sun 06:30 EST
    expect(briefingDue(every, Date.parse("2026-11-01T12:00:00Z"), tz)).toBe(true); // Sun 07:00 EST
    expect(briefingDue(every, Date.parse("2026-11-02T11:59:00Z"), tz)).toBe(false); // Mon 06:59 EST
    expect(briefingDue(every, Date.parse("2026-03-08T10:59:00Z"), tz)).toBe(false); // Sun 06:59 EDT
    expect(briefingDue(every, Date.parse("2026-03-08T11:00:00Z"), tz)).toBe(true); // Sun 07:00 EDT
    expect(briefingDue(every, Date.parse("2026-03-07T11:00:00Z"), tz)).toBe(false); // Sat 06:00 EST
    expect(clock("2026-11-02T13:30:00Z", tz)).toBe("8:30am");
    expect(clock("2026-10-13T12:00:00Z", tz)).toBe("8am");
  });

  it("'yesterday' runs local midnight to midnight: Monday covers Saturday + the 25-hour Sunday", () => {
    const tz = "America/Toronto";
    const mon = sinceWindow("2026-11-02", [1, 2, 3, 4, 5, 6], tz);
    expect(mon.label).toBe("Since Saturday");
    expect(mon.from.toISOString()).toBe("2026-10-31T04:00:00.000Z"); // Sat 00:00 EDT
    expect(mon.to.toISOString()).toBe("2026-11-02T05:00:00.000Z"); // Mon 00:00 EST
    expect((mon.to.getTime() - mon.from.getTime()) / 3_600_000).toBe(49);
    const tue = sinceWindow("2026-10-13", [1, 2, 3, 4, 5, 6], tz);
    expect(tue).toMatchObject({ label: "Yesterday", phrase: "yesterday" });
    expect(tue.from.toISOString()).toBe("2026-10-12T04:00:00.000Z");
  });

  it("sends at 07:00 EST on the Monday after the change, counting a lead from 23:30 Sunday EST and not one from after midnight", async () => {
    seed({
      contacts: [
        { id: "sun-late", organization_id: ORG, company_id: CO, first_name: "Late", created_at: "2026-11-02T04:30:00Z", consent_source: null }, // Sun 23:30 EST
        { id: "mon-early", organization_id: ORG, company_id: CO, first_name: "Early", created_at: "2026-11-02T05:30:00Z", consent_source: null }, // Mon 00:30 EST
        { id: "sat", organization_id: ORG, company_id: CO, first_name: "Sat", created_at: "2026-10-31T14:00:00Z", consent_source: null },
      ],
      bookings: [],
      invoices: [],
      invoice_payments: [],
      quotes: [],
      message_log: [],
      retell_calls: [],
      owner_approvals: [],
    });
    at("2026-11-02T11:30:00Z"); // 06:30 EST
    await run();
    expect(smsTo(OWNER)).toHaveLength(0);
    at("2026-11-02T12:00:00Z"); // 07:00 EST
    await run();
    expect(smsTo(OWNER)).toHaveLength(1);
    expect(smsTo(OWNER)[0].body).toContain("Since Saturday: 2 new leads.");
    expect(rows("owner_briefings")[0]).toMatchObject({ local_date: "2026-11-02", status: "sent" });
  });

  it("on the fall-back Sunday itself (Sunday switched on), the local date and hour are right", async () => {
    setSettings(0, { office_manager: { days: [0, 1, 2, 3, 4, 5, 6] } });
    at("2026-11-01T11:30:00Z"); // 06:30 EST (the clocks fell back at 02:00; with EDT's offset this would wrongly be 07:30)
    await run();
    expect(smsTo(OWNER)).toHaveLength(0);
    at("2026-11-01T12:00:00Z");
    await run();
    expect(smsTo(OWNER)).toHaveLength(1);
    expect(rows("owner_briefings")[0]).toMatchObject({ local_date: "2026-11-01" });
    expect(smsTo(OWNER)[0].body).toContain("Sun Nov 1");
  });
});

// ── Composer ─────────────────────────────────────────────────────────────────────

function input(over: Partial<BriefingInput> = {}): BriefingInput {
  return {
    ownerFirstName: "Dana",
    businessName: "Northshore Roofing",
    dayLabel: "Tue Oct 13",
    timeZone: "America/Toronto",
    jobs: null,
    weather: null,
    money: null,
    periodPhrase: "yesterday",
    fold: [],
    waiting: null,
    since: null,
    ...over,
  };
}

describe("composer", () => {
  it("a truly quiet day is one line", () => {
    const quiet = composeBriefing(input({ money: { collectedCents: 0, overdueCents: 0, overdueCount: 0 }, waiting: { items: [], total: 0 }, since: { label: "Yesterday", leads: 0, quotesSent: 0, quotesApproved: 0, textChats: 0, calls: 0 } }));
    expect(quiet.quiet).toBe(true);
    expect(quiet.text).toBe("Morning Dana - all quiet at Northshore Roofing today (Tue Oct 13): no jobs booked and nothing waiting on you.");
    expect(quiet.text).not.toContain("\n");
  });

  it("leaves out parts with nothing to say", () => {
    const text = composeBriefing(input({ jobs: { count: 1, firstStartIso: "2026-10-13T13:30:00Z", members: [], unassigned: 1 }, money: { collectedCents: 0, overdueCents: 0, overdueCount: 0 } })).text;
    expect(text).toBe('Morning Dana - Northshore Roofing, Tue Oct 13.\nToday: 1 job, first at 9:30am. None assigned yet.\nReply "today" for details.');
  });

  it("never more than 4 SMS segments (612 GSM characters with the CrankLeads prefix); money lines that don't fit stay for tomorrow", () => {
    const many = composeBriefing(
      input({
        ownerFirstName: "Bartholomew",
        businessName: "Northshore Roofing, Eavestrough & Exterior Renovations of Georgian Bay",
        jobs: { count: 24, firstStartIso: "2026-10-13T11:00:00Z", members: Array.from({ length: 9 }, (_, i) => ({ first: `Crewmember${i}`, count: 2 })), unassigned: 6 },
        weather: { today: { reason: "rain 90%, 12 mm, wind 60 km/h", atRiskJobs: 12 }, tomorrow: { reason: "wind 70 km/h", atRiskJobs: 9 } },
        money: { collectedCents: 1_234_500, overdueCents: 9_876_500, overdueCount: 31 },
        fold: Array.from({ length: 6 }, (_, i) => `Now ${30 + i}+ days overdue: Customer Number ${i} $1,240 (INV-${i}), Another Customer $900 (INV-9${i}), A Third $100 (INV-8${i}) +4 more.`),
        waiting: { items: Array.from({ length: 9 }, (_, i) => ({ code: 10 + i, summary: `AI estimate for “Customer ${i}” — “Eavestrough repair and soffit replacement” $${i},750 + HST 🙂` })), total: 9 },
        since: { label: "Yesterday", leads: 12, quotesSent: 9, quotesApproved: 4, textChats: 40, calls: 11 },
        maxSeptets: MAX_BRIEFING_SEPTETS - "CrankLeads: ".length,
      }),
    );
    expect(septets(`CrankLeads: ${many.text}`)).toBeLessThanOrEqual(612);
    expect(many.foldIncluded).toBeLessThan(6);
    expect(many.text).toMatch(/^Morning Bartholomew - /);
    expect(many.text).toContain("Money: $12,345 came in yesterday, $98,765 overdue (31 invoices).");
    expect(many.text.endsWith('Reply "today" for details.')).toBe(true);
    expect(many.text).toMatch(/^[\x20-\x7E\n]+$/); // plain GSM: no emoji, no curly quotes
  });

  it("plain GSM text: accents, curly quotes, dashes and emoji are flattened", () => {
    expect(gsmPlain("José’s “roof” — done 👍")).toBe(`Jose's "roof" - done`);
    expect(septets("a[b]")).toBe(6);
  });
});

// ── The sweep ────────────────────────────────────────────────────────────────────

describe("morning briefing sweep", () => {
  it("one text at 07:00 with today's jobs, money, what's waiting and yesterday, from the platform number to the verified owner cell", async () => {
    at("2026-10-13T10:58:00Z"); // 06:58
    await run();
    expect(sendSms).not.toHaveBeenCalled();
    at(TUE_7AM);
    await run();
    const owner = smsTo(OWNER);
    expect(owner).toHaveLength(1);
    expect(owner[0].from).toBe(PLATFORM);
    expect(owner[0].body.split("\n")).toEqual([
      "CrankLeads: Morning Dana - Northshore Roofing, Tue Oct 13.",
      "Today: 4 jobs, first at 8am. Mike 2, Sam 1, 1 unassigned.",
      "Money: $1,250 came in yesterday, $1,240 overdue (1 invoice).",
      "Waiting on you: #12 AI estimate for Jamie Lee: Eavestrough repair $750 +...; #13 Record $500 e-Transfer from Bob Jones on INV-9.",
      "Yesterday: 2 new leads, 2 quotes sent, 1 approved. AI handled 2 text chats and 1 call.",
      'Reply "today" for details.',
    ]);
    expect(septets(owner[0].body)).toBeLessThanOrEqual(612);
    expect(rows("owner_briefings")).toHaveLength(1);
    expect(rows("owner_briefings")[0]).toMatchObject({ organization_id: ORG, company_id: CO, local_date: "2026-10-13", status: "sent", attempts: 1, email_status: null });
    // No email unless asked for; nothing to A1.
    expect(sendEmail).not.toHaveBeenCalled();
    expect(smsTo(A1_OWNER)).toHaveLength(0);
    // Every read is tenant-scoped.
    for (const q of h.db!.queries.filter((q) => ["bookings", "invoices", "invoice_payments", "quotes", "contacts", "message_log", "retell_calls"].includes(q.table) && q.op === "select")) {
      expect(q.filters.some((f) => f.column === "organization_id")).toBe(true);
    }
  });

  it("exactly once per company per local date, even with two workers at once", async () => {
    await Promise.all([run(), run()]);
    expect(smsTo(OWNER)).toHaveLength(1);
    expect(rows("owner_briefings")).toHaveLength(1);
    at("2026-10-13T12:30:00Z");
    await Promise.all([run(), run()]);
    expect(smsTo(OWNER)).toHaveLength(1);
    // The next briefing day gets its own.
    at("2026-10-14T11:05:00Z");
    await run();
    expect(smsTo(OWNER)).toHaveLength(2);
    expect(rows("owner_briefings").map((r) => r.local_date)).toEqual(["2026-10-13", "2026-10-14"]);
  });

  it("not on Sunday by default; Sunday is a setting; the set time moves it", async () => {
    at("2026-10-18T11:30:00Z"); // Sun 07:30
    await run();
    expect(sendSms).not.toHaveBeenCalled();
    setSettings(0, { office_manager: { days: [0, 1, 2, 3, 4, 5, 6], time: "08:30" } });
    await run();
    expect(sendSms).not.toHaveBeenCalled();
    at("2026-10-18T12:30:00Z"); // 08:30
    await run();
    expect(smsTo(OWNER)).toHaveLength(1);
  });

  it("a failed send releases the claim: retried after 10 minutes, at most 3 tries, never after 11:00", async () => {
    sendSms.mockImplementationOnce(() => Promise.reject(new Error("twilio down")));
    await run();
    expect(rows("owner_briefings")[0]).toMatchObject({ status: "failed", attempts: 1 });
    at("2026-10-13T11:05:00Z");
    await run();
    expect(sendSms).toHaveBeenCalledTimes(1); // too soon to retry
    at("2026-10-13T11:10:00Z");
    await run();
    expect(sendSms).toHaveBeenCalledTimes(2);
    expect(rows("owner_briefings")[0]).toMatchObject({ status: "sent", attempts: 2 });

    // Three failures → given up; and nothing after 11:00 local.
    seed();
    sendSms.mockImplementation(() => Promise.reject(new Error("twilio down")));
    for (const t of ["11:00", "11:10", "11:20", "11:30", "11:40"]) {
      at(`2026-10-13T${t}:00Z`);
      await run();
    }
    expect(sendSms).toHaveBeenCalledTimes(3);
    expect(rows("owner_briefings")[0]).toMatchObject({ status: "failed", attempts: 3 });
    seed();
    sendSms.mockImplementationOnce(() => Promise.reject(new Error("twilio down")));
    at("2026-10-13T14:55:00Z"); // 10:55
    await run();
    at("2026-10-13T15:05:00Z"); // 11:05
    await run();
    expect(sendSms).toHaveBeenCalledTimes(1);
  });

  it("a STOP to the platform number is final for the day; no verified cell → nothing", async () => {
    rows("platform_sms_opt_outs").push({ phone_e164: OWNER, opted_out_at: "2026-10-01T00:00:00Z" });
    await run();
    at("2026-10-13T11:30:00Z");
    await run();
    expect(sendSms).not.toHaveBeenCalled();
    expect(rows("owner_briefings")[0]).toMatchObject({ status: "skipped", attempts: 1 });
    seed();
    rows("companies")[0].owner_phone_verified_at = null;
    await run();
    expect(sendSms).not.toHaveBeenCalled();
    expect(rows("owner_briefings")).toHaveLength(0);
  });

  it("house orgs (A1) are off: no text, no row, no tool; on when they switch it on (no CrankLeads prefix)", async () => {
    await run();
    expect(smsTo(A1_OWNER)).toHaveLength(0);
    expect(rows("owner_briefings").filter((r) => r.company_id === A1_CO)).toHaveLength(0);
    expect(await officeManagerActiveFor(h.db!.client, { organizationId: A1_ORG, companyId: A1_CO })).toBe(false);
    expect(await officeManagerActiveFor(h.db!.client, { organizationId: ORG, companyId: CO })).toBe(true);
    expect((await activeRolesFor(h.db!.client, { organizationId: A1_ORG, companyId: A1_CO })).map((r) => r.role)).not.toContain("office_manager");
    // A1's 8am money alert is never deferred to a briefing it doesn't have.
    expect(await briefingTakesMoneyAlert(h.db!.client, { organizationId: A1_ORG, companyId: A1_CO }, Date.now())).toBe(false);

    setSettings(1, { office_manager: { enabled: true } });
    at("2026-10-13T11:20:00Z");
    await run();
    const a1 = smsTo(A1_OWNER);
    expect(a1).toHaveLength(1);
    expect(a1[0].body).toBe("Morning - all quiet at A1 Marine Care today (Tue Oct 13): no jobs booked and nothing waiting on you.");
  });

  it("with EVERDOER_SMS_BRANDING=1 a house org's briefing is signed 'Everdoer: ' too, within the 612-septet budget", async () => {
    vi.stubEnv("EVERDOER_SMS_BRANDING", "1");
    try {
      setSettings(1, { office_manager: { enabled: true } });
      at("2026-10-13T11:20:00Z");
      await run();
      const a1 = smsTo(A1_OWNER);
      expect(a1).toHaveLength(1);
      expect(a1[0].body).toBe("Everdoer: Morning - all quiet at A1 Marine Care today (Tue Oct 13): no jobs booked and nothing waiting on you.");
      expect(septets(a1[0].body)).toBeLessThanOrEqual(MAX_BRIEFING_SEPTETS);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("a paused company gets nothing", async () => {
    rows("companies")[0].stage = "paused";
    await run();
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("the email copy (setting) goes to the owner's email with the full lists", async () => {
    setSettings(0, { office_manager: { channels: ["sms", "email"] } });
    rows("companies")[0].owner_email = "dana@northshore.test";
    await run();
    expect(smsTo(OWNER)).toHaveLength(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const email = sendEmail.mock.calls[0][0] as { to: string; subject: string; body: string; html: string; fromName: string };
    expect(email.to).toBe("dana@northshore.test");
    expect(email.fromName).toBe("Everdoer");
    expect(email.subject).toBe("Northshore Roofing: your morning briefing for Tue Oct 13");
    expect(email.body).toContain("Mike: 8am - Jamie - Roof repair - 12 Bay St; 10am - Pat - Roof repair - 12 Bay St");
    expect(email.body).toContain("Unassigned: 3pm - Jamie - Roof repair - 12 Bay St");
    expect(email.body).toContain("Jamie Lee $1,240 (INV-12, 12 days late)");
    expect(email.body).toContain("#13 Record $500 e-Transfer from Bob Jones on INV-9");
    expect(email.body).not.toContain('Reply "today"');
    expect(email.html).toContain("<li>");
    expect(rows("owner_briefings")[0]).toMatchObject({ status: "sent", email_status: "sent" });
  });
});

// ── The Bookkeeper's 8am alert, folded in ────────────────────────────────────────

describe("bookkeeper 8am alert fold-in", () => {
  function notable() {
    rows("invoices").push({ id: "inv-30", organization_id: ORG, company_id: CO, contact_id: JAMIE, invoice_number: "INV-30", status: "sent", total_cents: 124000, credit_cents: 0, balance_due_cents: 124000, pending_payment_cents: 0, due_date: "2026-09-12", issue_date: "2026-08-29", sent_at: "2026-08-29T14:00:00Z", bill_to: null, public_token: "t30" });
    rows("invoice_payments").push({ id: "pay-f", organization_id: ORG, company_id: CO, invoice_id: "inv-30", amount_cents: 50000, method: "card", status: "failed", failure_reason: "card_declined", updated_at: "2026-10-13T02:00:00Z", created_at: "2026-10-13T02:00:00Z", received_at: "2026-10-13T02:00:00Z" });
  }

  it("the briefing carries the alert's items and marks them reported; the 8am alert stays quiet; nothing repeats tomorrow", async () => {
    notable();
    await run();
    const body = smsTo(OWNER)[0].body;
    expect(body).toContain("Money: $1,250 came in yesterday, $2,480 overdue (2 invoices).\nPayment failed: Jamie Lee $500 (INV-30).\nNow 30+ days overdue: Jamie Lee $1,240 (INV-30).\nWaiting on you:");
    expect(rows("money_alert_items").map((r) => r.item_key).sort()).toEqual(["overdue30:inv-30", "payment_failed:pay-f"]);
    expect(rows("money_alerts")[0]).toMatchObject({ alert_date: "2026-10-13", status: "sent" });
    expect(rows("owner_briefings")[0].money_items).toEqual(["payment_failed:pay-f", "overdue30:inv-30"]);

    at("2026-10-13T12:15:00Z"); // 08:15: the standalone alert defers
    await runDailyMoneyAlerts(h.db!.client, Date.now());
    expect(smsTo(OWNER)).toHaveLength(1);

    at("2026-10-14T11:00:00Z");
    await run();
    expect(smsTo(OWNER)).toHaveLength(2);
    expect(smsTo(OWNER)[1].body).not.toContain("Payment failed");
    expect(smsTo(OWNER)[1].body).not.toContain("30+ days overdue");
  });

  it("a failed briefing leaves the items untold for the retry", async () => {
    notable();
    sendSms.mockImplementationOnce(() => Promise.reject(new Error("twilio down")));
    await run();
    expect(rows("money_alert_items")).toHaveLength(0);
    at("2026-10-13T11:10:00Z");
    await run();
    expect(smsTo(OWNER)[1].body).toContain("Payment failed: Jamie Lee $500 (INV-30).");
    expect(rows("money_alert_items")).toHaveLength(2);
  });

  it("no fold when the Bookkeeper's alert is off; briefing off → the 8am alert goes alone", async () => {
    notable();
    setSettings(0, { collections: { dailyAlert: false } });
    await run();
    expect(smsTo(OWNER)[0].body).not.toContain("Payment failed");
    expect(rows("money_alert_items")).toHaveLength(0);

    seed();
    notable();
    setSettings(0, { office_manager: { enabled: false } });
    await run();
    expect(sendSms).not.toHaveBeenCalled();
    at("2026-10-13T12:15:00Z");
    await runDailyMoneyAlerts(h.db!.client, Date.now());
    expect(smsTo(OWNER)).toHaveLength(1);
    expect(smsTo(OWNER)[0].body).toContain("Money check for Northshore Roofing:");
  });
});

// ── Review fixes ─────────────────────────────────────────────────────────────────

describe("review fixes", () => {
  const quietSeed = () =>
    seed({ bookings: [], invoices: [], invoice_payments: [], quotes: [], message_log: [], retell_calls: [], owner_approvals: [], contacts: [] });

  it("job applicants (the Recruiter's) and imported customers aren't new leads", async () => {
    expect(isNewLead({ consent_source: "web_form", metadata: {} })).toBe(true);
    expect(isNewLead({ consent_source: null })).toBe(true);
    expect(isNewLead({ consent_source: "job_application", metadata: { kind: "applicant" } })).toBe(false);
    expect(isNewLead({ consent_source: "inbound_sms", metadata: { kind: "applicant" } })).toBe(false);
    expect(isNewLead({ consent_source: "import", metadata: null })).toBe(false);
    rows("contacts").push(
      { id: "app-1", organization_id: ORG, company_id: CO, first_name: "Jo", created_at: YESTERDAY, consent_source: "job_application", metadata: { kind: "applicant" } },
      { id: "app-2", organization_id: ORG, company_id: CO, first_name: "Al", created_at: YESTERDAY, consent_source: "inbound_sms", metadata: { kind: "applicant" } },
    );
    await run();
    expect(smsTo(OWNER)[0].body).toContain("Yesterday: 2 new leads,");
  });

  it("an unreadable jobs list is never reported as a quiet day: retried, and on the last try it says so", async () => {
    quietSeed();
    h.db!.failNext("bookings", "select");
    await run();
    expect(sendSms).not.toHaveBeenCalled();
    expect(rows("owner_briefings")[0]).toMatchObject({ status: "failed", attempts: 1, last_error: "couldn't read: jobs" });
    at("2026-10-13T11:10:00Z");
    await run();
    expect(smsTo(OWNER)).toHaveLength(1);
    expect(smsTo(OWNER)[0].body).toContain("all quiet"); // read fine this time: really quiet

    // The last chance before 11:00: send, but never claim "no jobs".
    quietSeed();
    h.db!.failNext("bookings", "select");
    at("2026-10-13T14:55:00Z"); // 10:55
    await run();
    const body = smsTo(OWNER)[0].body;
    expect(body).not.toContain("all quiet");
    expect(body).toContain("Today's jobs: couldn't load them - check the app.");
    expect(rows("owner_briefings")[0]).toMatchObject({ status: "sent" });
  });

  it("an unreadable approvals list is never 'nothing waiting'", () => {
    const composed = composeBriefing(input({ unreadable: { waiting: true } }));
    expect(composed.quiet).toBe(false);
    expect(composed.text).toContain('Approvals: couldn\'t load them - text "waiting".');
  });

  function notable() {
    rows("invoices").push({ id: "inv-30", organization_id: ORG, company_id: CO, contact_id: JAMIE, invoice_number: "INV-30", status: "sent", total_cents: 124000, credit_cents: 0, balance_due_cents: 124000, pending_payment_cents: 0, due_date: "2026-09-12", issue_date: "2026-08-29", sent_at: "2026-08-29T14:00:00Z", bill_to: null, public_token: "t30" });
    rows("invoice_payments").push({ id: "pay-f", organization_id: ORG, company_id: CO, invoice_id: "inv-30", amount_cents: 50000, method: "card", status: "failed", failure_reason: "card_declined", updated_at: "2026-10-13T13:00:00Z", created_at: "2026-10-13T13:00:00Z", received_at: "2026-10-13T13:00:00Z" });
  }

  it("money alert items whose read failed are never lost: retried with the briefing; on the last try the 8am alert carries them, once", async () => {
    notable();
    h.db!.failNext("accounting_connections", "select");
    await run();
    expect(sendSms).not.toHaveBeenCalled();
    expect(rows("owner_briefings")[0]).toMatchObject({ status: "failed", last_error: "couldn't read: money alert" });
    expect(await briefingTakesMoneyAlert(h.db!.client, { organizationId: ORG, companyId: CO }, Date.now())).toBe(true); // a retry is coming
    at("2026-10-13T11:10:00Z");
    await run();
    expect(smsTo(OWNER)[0].body).toContain("Payment failed: Jamie Lee $500 (INV-30).");
    expect(rows("owner_briefings")[0]).toMatchObject({ status: "sent", money_fold: "included" });

    // Last try (10:55): sent without them → the standalone alert goes with them, and only once.
    seed();
    notable();
    h.db!.failNext("accounting_connections", "select");
    at("2026-10-13T14:55:00Z");
    await run();
    expect(smsTo(OWNER)).toHaveLength(1);
    expect(smsTo(OWNER)[0].body).not.toContain("Payment failed");
    expect(rows("owner_briefings")[0]).toMatchObject({ status: "sent", money_fold: "failed" });
    expect(rows("money_alert_items")).toHaveLength(0);
    at("2026-10-13T14:58:00Z");
    await runDailyMoneyAlerts(h.db!.client, Date.now());
    await runDailyMoneyAlerts(h.db!.client, Date.now());
    expect(smsTo(OWNER)).toHaveLength(2);
    expect(smsTo(OWNER)[1].body).toContain("Payment failed: Jamie Lee $500 (INV-30).");
    expect(rows("money_alert_items").map((r) => r.item_key).sort()).toEqual(["overdue30:inv-30", "payment_failed:pay-f"]);
  });

  it("briefingTakesMoneyAlert follows today's row: final without the items → the alert goes", async () => {
    const take = () => briefingTakesMoneyAlert(h.db!.client, { organizationId: ORG, companyId: CO }, Date.now(), { doneForYou: true });
    expect(await take()).toBe(true); // no row yet
    rows("owner_briefings").push({ id: "ob-1", organization_id: ORG, company_id: CO, local_date: "2026-10-13", status: "claimed", attempts: 1, money_fold: null });
    expect(await take()).toBe(true);
    Object.assign(rows("owner_briefings")[0], { status: "failed", attempts: 2 });
    expect(await take()).toBe(true);
    Object.assign(rows("owner_briefings")[0], { status: "failed", attempts: 3 });
    expect(await take()).toBe(false);
    Object.assign(rows("owner_briefings")[0], { status: "sent", money_fold: "included" });
    expect(await take()).toBe(true);
    Object.assign(rows("owner_briefings")[0], { status: "sent", money_fold: "failed" });
    expect(await take()).toBe(false);
    Object.assign(rows("owner_briefings")[0], { status: "skipped" });
    expect(await take()).toBe(false);
    // Off → no row read at all.
    setSettings(0, { office_manager: { enabled: false } });
    const before = h.db!.queries.filter((q) => q.table === "owner_briefings").length;
    expect(await briefingTakesMoneyAlert(h.db!.client, { organizationId: ORG, companyId: CO }, Date.now())).toBe(false);
    expect(h.db!.queries.filter((q) => q.table === "owner_briefings").length).toBe(before);
  });

  it("imported balances still on hold aren't counted as overdue", async () => {
    rows("invoices").push({ id: "inv-imp", organization_id: ORG, company_id: CO, contact_id: PAT, invoice_number: null, status: "sent", total_cents: 840000, credit_cents: 0, balance_due_cents: 840000, pending_payment_cents: 0, due_date: "2026-09-01", issue_date: "2026-09-01", sent_at: null, bill_to: null, public_token: "ti", import_hold: true });
    await run();
    expect(smsTo(OWNER)[0].body).toContain("$1,240 overdue (1 invoice)");
  });

  it("a clipped item ends in '...', never '....'", () => {
    const text = composeBriefing(
      input({ waiting: { items: [{ code: 7, summary: "Nobody has been assigned to the Smith eavestrough job on Thursday morning yet" }], total: 1 } }),
    ).text;
    expect(text).toContain("Waiting on you: #7 Nobody has been assigned to the Smith eavestrough jo...\n");
    expect(text).not.toContain("....");
    expect(waitingLine({ items: [{ code: 1, summary: "Call Jones back?" }], total: 1 })).toBe("Waiting on you: #1 Call Jones back?");
    expect(sentence("Done.")).toBe("Done.");
    expect(sentence("Done")).toBe("Done.");
  });

  it("backticks become apostrophes; the quiet line is capped in GSM septets", () => {
    expect(gsmPlain("Dana`s")).toBe("Dana's");
    const quiet = composeBriefing(input({ businessName: "[".repeat(400), maxSeptets: 300 }));
    expect(quiet.quiet).toBe(true);
    expect(septets(quiet.text)).toBeLessThanOrEqual(300);
    expect(quiet.text.endsWith("...")).toBe(true);
  });
});

// ── Weather ──────────────────────────────────────────────────────────────────────

function rainyProvider(): WeatherProvider & { forecast: ReturnType<typeof vi.fn> } {
  const hours: Forecast["hours"] = [];
  const start = Date.parse("2026-10-13T04:00:00Z");
  for (let i = 0; i < 48; i++) {
    const timeMs = start + i * 3_600_000;
    const today = timeMs < Date.parse("2026-10-14T04:00:00Z");
    hours.push({ timeMs, precipProbability: today ? 90 : 10, precipMm: today ? 1 : 0, windKmh: today ? 20 : 15, tempC: 8 });
  }
  return { name: "fake", forecast: vi.fn(async (loc: { latitude: number; longitude: number }) => ({ latitude: loc.latitude, longitude: loc.longitude, fetchedAtMs: Date.now(), hours })) };
}

describe("weather", () => {
  it("today/tomorrow risk when the Dispatcher's weather check is on (roofing: every job is weather-sensitive)", async () => {
    Object.assign(rows("companies")[0], { latitude: 44.75, longitude: -79.88 });
    const provider = rainyProvider();
    await run({ weatherProvider: () => provider });
    expect(provider.forecast).toHaveBeenCalledTimes(1);
    expect(smsTo(OWNER)[0].body).toContain("Weather: today rain 90%, 12 mm - 4 jobs at risk.");
    expect(smsTo(OWNER)[0].body).not.toContain("tomorrow");
  });

  it("never fetches weather when the check is off, or when the business has no location yet", async () => {
    Object.assign(rows("companies")[0], { latitude: 44.75, longitude: -79.88 });
    setSettings(0, { dispatch: { weather: { enabled: false } } });
    const provider = rainyProvider();
    await run({ weatherProvider: () => provider });
    expect(provider.forecast).not.toHaveBeenCalled();
    expect(smsTo(OWNER)[0].body).not.toContain("Weather");

    seed();
    await run({ weatherProvider: () => provider });
    expect(provider.forecast).not.toHaveBeenCalled();
  });
});

// ── Owner tool ───────────────────────────────────────────────────────────────────

describe("owner tool briefing_now", () => {
  const tool = () => officeManagerRole.ownerTools.find((t) => t.tool.name === "briefing_now")!;
  const state = () => ({
    admin: h.db!.client,
    scope: { organizationId: ORG, companyId: CO, companyName: "Northshore Roofing", timeZone: "America/Toronto" },
    ownerPhone: OWNER,
    nowMs: Date.now(),
    confirmation: null,
    actions: [],
  });

  it("returns today's briefing in the chat and never marks the daily send", async () => {
    at("2026-10-13T17:30:00Z"); // 1:30pm
    rows("invoice_payments").push({ id: "pay-f", organization_id: ORG, company_id: CO, invoice_id: "inv-1", amount_cents: 50000, method: "card", status: "failed", failure_reason: "card_declined", updated_at: "2026-10-13T02:00:00Z", created_at: "2026-10-13T02:00:00Z", received_at: "2026-10-13T02:00:00Z" });
    const res = await tool().run(state() as never, {});
    expect(res.ok).toBe(true);
    expect(String(res.briefing)).toContain("Today: 4 jobs, first at 8am.");
    expect(String(res.briefing)).toContain("Payment failed: Jamie Lee $500 (INV-12).");
    expect(res.details).toBeUndefined();
    expect(res.schedule).toBe("Morning text at 7am, Monday to Saturday.");
    expect(rows("owner_briefings")).toHaveLength(0);
    expect(rows("money_alert_items")).toHaveLength(0);
    expect(rows("money_alerts")).toHaveLength(0);
    expect(sendSms).not.toHaveBeenCalled();

    const detailed = await tool().run(state() as never, { detail: true });
    expect(String(detailed.details)).toContain("Today's jobs:\n- Mike: 8am - Jamie - Roof repair - 12 Bay St");
    expect(String(detailed.details)).toContain("- #12 AI estimate for Jamie Lee: Eavestrough repair $750 + HST");

    // Later the morning text still goes (the preview didn't claim the day) — tomorrow, since it's past 11.
    at("2026-10-14T11:00:00Z");
    await run();
    expect(smsTo(OWNER)).toHaveLength(1);
  });

  it("a decided approval drops off the list (N through the owner channel's decideApproval)", async () => {
    const before = String((await tool().run(state() as never, {})).briefing);
    expect(before).toContain("#13 Record $500");
    const res = await decideApproval(h.db!.client, "ap-13", { approved: false, decidedVia: "sms", decidedBy: OWNER }, { organizationId: ORG });
    expect(res.outcome).toBe("done");
    expect(rows("owner_approvals").find((a) => a.id === "ap-13")!.status).toBe("rejected");
    const text = String((await tool().run(state() as never, {})).briefing);
    expect(text).toContain("#12 AI estimate");
    expect(text).not.toContain("#13");
    expect(text).not.toContain("#9 "); // expired
    expect(text).not.toContain("Cancel Jones"); // owner command confirmations aren't listed
  });

  it("is registered without clashes and offered only where the briefing is on", async () => {
    expect(registryProblems(AGENT_TOOLS.map((t) => t.name), OWNER_TOOLS.map((t) => t.name))).toEqual([]);
    expect(officeManagerRole.approvalExecutors).toEqual({});
    expect(officeManagerRole.sweeps.map((s) => s.name)).toEqual(["office-manager:briefing"]);
    expect((await activeRolesFor(h.db!.client, { organizationId: ORG, companyId: CO })).map((r) => r.role)).toContain("office_manager");
    setSettings(0, { office_manager: { enabled: false } });
    expect((await activeRolesFor(h.db!.client, { organizationId: ORG, companyId: CO })).map((r) => r.role)).not.toContain("office_manager");
  });
});

// ── Route ────────────────────────────────────────────────────────────────────────

describe("ai-settings/office-manager route", () => {
  const params = { params: { organizationId: ORG, companyId: CO } };
  const patch = (body: unknown) => new Request("http://localhost/x", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("GET shows the done-for-you default, the fold-in and the last briefing", async () => {
    await run();
    const res = await GET(new Request("http://localhost/x"), params);
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data).toMatchObject({
      settings: { enabled: true, enabledIsDefault: true, time: "07:00", days: [1, 2, 3, 4, 5, 6], emailCopy: false },
      defaultEnabled: true,
      ownerPhoneOnFile: true,
      ownerEmailOnFile: true,
      foldsMoneyAlert: true,
      lastBriefing: { date: "2026-10-13", status: "sent" },
    });
  });

  it("PATCH (owner) merges only office_manager; members, unknown fields and bad times are refused", async () => {
    rows("companies")[0].ai_settings = { sms_agent: { enabled: true } };
    const res = await PATCH(patch({ time: "06:30", days: [0, 1, 2], emailCopy: true }), params);
    expect(res.status).toBe(200);
    expect(rows("companies")[0].ai_settings).toEqual({ sms_agent: { enabled: true }, office_manager: { time: "06:30", days: [0, 1, 2], channels: ["sms", "email"] } });
    h.userId = "u-member";
    expect((await PATCH(patch({ enabled: false }), params)).status).toBe(403);
    expect((await GET(new Request("http://localhost/x"), params)).status).toBe(200);
    h.userId = "u-owner";
    expect((await PATCH(patch({ enabled: false, sendTo: "+1" }), params)).status).toBe(400);
    expect((await PATCH(patch({ time: "05:00" }), params)).status).toBe(400);
    expect((await PATCH(patch({ days: [] }), params)).status).toBe(400);
  });
});

// ── Phase 4 wiring: other AI staff in the briefing; receipts tagged with a PO ──────────────────

describe("heads-ups from other AI staff", () => {
  it("are their own lines after the money, and a briefing with only heads-ups isn't 'all quiet'", () => {
    const out = composeBriefing(input({ staff: ["Liability insurance expires in 7 days", "Pick up materials at Home Depot Pro (Barrie) for Jones (PO-1)"] }));
    expect(out.quiet).toBe(false);
    const lines = out.text.split("\n");
    expect(lines).toContain("Liability insurance expires in 7 days.");
    expect(lines).toContain("Pick up materials at Home Depot Pro (Barrie) for Jones (PO-1).");
    expect(lines.at(-1)).toBe('Reply "today" for details.');
  });

  it("are trimmed (last first) before the briefing goes over 4 segments", () => {
    const long = Array.from({ length: 4 }, (_, i) => `Heads-up number ${i + 1}: ${"x".repeat(120)}`);
    const out = composeBriefing(input({ jobs: { count: 2, firstStartIso: "2026-10-13T12:00:00Z", members: [{ first: "Mike", count: 2 }], unassigned: 0 }, staff: long }));
    expect(septets(out.text)).toBeLessThanOrEqual(MAX_BRIEFING_SEPTETS);
    expect(out.text).toContain("Heads-up number 1");
    expect(out.text).not.toContain("Heads-up number 4");
  });

  it("one role failing (or returning junk) leaves the others; at most MAX_STAFF_ITEMS, in role order", async () => {
    const db = createFakeDb({});
    const items = await staffBriefingItems(db.client, { organizationId: "o", companyId: "c", timeZone: "America/Toronto" }, "2026-10-13", [
      { name: "a", items: () => Promise.reject(new Error("boom")) },
      { name: "b", items: () => Promise.resolve(["first", "  ", "second"]) },
      { name: "c", items: () => Promise.resolve(null as unknown as string[]) },
      { name: "d", items: () => Promise.resolve(["third", "fourth", "fifth"]) },
    ]);
    // Fair: each role's first line, then each role's second line.
    expect(items).toEqual(["first", "third", "second", "fourth"].slice(0, MAX_STAFF_ITEMS));
  });

  it("one busy role can't crowd the others out", () => {
    expect(pickFairly([["care 1"], ["c1", "c2", "c3", "c4"], [], ["fleet 1", "fleet 2", "fleet 3", "fleet 4"]], 4)).toEqual(["care 1", "c1", "fleet 1", "c2"]);
    expect(pickFairly([[], []], 4)).toEqual([]);
    expect(pickFairly([["a", "b"]], 4)).toEqual(["a", "b"]);
  });

  it("house orgs: the real roles add nothing (all four are off there)", async () => {
    const db = createFakeDb({
      organizations: [{ id: "a1", platform_brand: "empirevu" }],
      companies: [{ id: "a1co", organization_id: "a1", name: "A1 Marine Care", timezone: "America/Toronto", ai_settings: {}, stage: "active", tax_registration_number: "123456789RT0001" }],
    });
    expect(await staffBriefingItems(db.client, { organizationId: "a1", companyId: "a1co", timeZone: "America/Toronto" }, "2026-10-13")).toEqual([]);
  });
});

describe("a receipt tagged with a PO", () => {
  it("finds the job Purchasing ordered it for; unknown PO or no table gives null", async () => {
    const db = createFakeDb({ purchase_orders: [{ id: "po1", organization_id: "o", company_id: "c", po_number: "PO-12", booking_id: "b-jones" }] });
    expect(await bookingForPo(db.client, { organizationId: "o", companyId: "c" }, "po-12")).toBe("b-jones");
    expect(await bookingForPo(db.client, { organizationId: "o", companyId: "c" }, "PO-13")).toBeNull();
    expect(await bookingForPo(db.client, { organizationId: "o", companyId: "other" }, "PO-12")).toBeNull();
    const empty = createFakeDb({});
    empty.failNext("purchase_orders", "select", { message: "relation does not exist" });
    expect(await bookingForPo(empty.client, { organizationId: "o", companyId: "c" }, "PO-12")).toBeNull();
  });
});
