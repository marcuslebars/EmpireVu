import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Outbound + metering collaborators of deliverMessage — no network, no admin client.
const sendSms = vi.fn();
const sendEmail = vi.fn();
vi.mock("@/server/outbound/sms", () => ({ sendSms: (...a: unknown[]) => sendSms(...a) }));
vi.mock("@/server/outbound/email", () => ({ sendEmail: (...a: unknown[]) => sendEmail(...a) }));
vi.mock("@/server/services/workflow-engine/dispatch", () => ({
  emitActivityEventAndDispatch: () => Promise.resolve({ activityEvent: {}, workflowEventJob: null }),
}));
vi.mock("@/server/services/usage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/services/usage")>()),
  recordUsageSafe: () => Promise.resolve(),
}));

// Route tests: the request's RLS client, membership and the admin client are mocked.
const requireOrganizationContext = vi.fn();
vi.mock("@/server/organizations/context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/organizations/context")>()),
  requireOrganizationContext: (...a: unknown[]) => requireOrganizationContext(...a),
}));
const serverClient = { current: null as unknown };
vi.mock("@/server/supabase/server", () => ({ createSupabaseServerClient: () => serverClient.current }));
vi.mock("@/server/supabase/admin", () => ({ createSupabaseAdminClient: () => serverClient.current }));

import { createFakeDb, type FakeDb } from "./helpers/fake-supabase";
import { emptyScorecardInputs } from "@/server/services/monthly-scorecard/metrics";
import {
  isWeekKey,
  localWallTimeToUtcMs,
  shiftWeekKey,
  weekKeyForDate,
  weekKeyInTimeZone,
  weekLabel,
  weekRangeForKey,
} from "@/server/services/monthly-scorecard/weeks";
import {
  computeHoursSaved,
  computeWeeklyMetrics,
  emptyFrontDeskInputs,
  emptyWeeklyMetrics,
  fetchFrontDeskInputs,
  HOURS_SAVED_ASSUMPTIONS,
  isAfterHours,
  type WeeklyReportMetrics,
} from "@/server/services/weekly-report/metrics";
import { mergeWeeklyReportSettings, parseWeeklyReportSettings } from "@/server/services/weekly-report/settings";
import {
  couldBeSendWindowAnywhere,
  isInSendWindow,
  parseWeeklyArgs,
  processWeeklyReports,
  resetWeeklyReportThrottle,
  runWeeklyReports,
} from "@/server/services/weekly-report/send";
import { getWeeklyReportView } from "@/server/services/weekly-report/view";
import { sendTestWeeklyReport } from "@/server/services/weekly-report/send";
import { renderWeeklyEmail, renderWeeklySms, smsSegments, toGsmSafe } from "@/server/templates/weekly-report";
import { PATCH as settingsPATCH } from "@/app/api/organizations/[organizationId]/companies/[companyId]/ai-settings/weekly-report/route";

const TZ = "America/Toronto";
const ORG_1 = "11111111-1111-4111-8111-111111111111";
const CO_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_HOUSE = "22222222-2222-4222-8222-222222222222";
const CO_HOUSE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WEEK = "2026-10-05";
/** Monday Oct 12 2026, 08:30 in Toronto (EDT, UTC−4). */
const MON_0830 = Date.parse("2026-10-12T12:30:00.000Z");

const HOURS = {
  monday: { open: "08:00", close: "17:00" },
  tuesday: { open: "08:00", close: "17:00" },
  wednesday: { open: "08:00", close: "17:00" },
  thursday: { open: "08:00", close: "17:00" },
  friday: { open: "08:00", close: "17:00" },
  saturday: "closed",
  sunday: "closed",
};

// ── Week boundaries ───────────────────────────────────────────────────────────

describe("week helpers (Monday–Sunday, company timezone)", () => {
  it("normalizes any date to its Monday and labels the week", () => {
    expect(weekKeyForDate("2026-10-11")).toBe("2026-10-05"); // Sunday → previous Monday
    expect(weekKeyForDate("2026-10-12")).toBe("2026-10-12");
    expect(isWeekKey("2026-10-05")).toBe(true);
    expect(isWeekKey("2026-10-06")).toBe(false);
    expect(shiftWeekKey("2026-12-28", 1)).toBe("2027-01-04");
    expect(weekLabel("2026-10-05")).toBe("Oct 5 – 11");
    expect(weekLabel("2026-09-28")).toBe("Sep 28 – Oct 4");
    expect(weekLabel("2026-09-28", { ascii: true })).toBe("Sep 28-Oct 4");
    expect(weekLabel("2026-12-28", { withYear: true })).toBe("Dec 28 – Jan 3, 2027");
  });

  it("puts Sunday 23:30 and Monday 00:30 local in different weeks", () => {
    expect(weekKeyInTimeZone(TZ, Date.parse("2026-10-12T03:30:00.000Z"))).toBe("2026-10-05"); // Sun 23:30 EDT
    expect(weekKeyInTimeZone(TZ, Date.parse("2026-10-12T04:30:00.000Z"))).toBe("2026-10-12"); // Mon 00:30 EDT
  });

  it("is 167 hours across spring-forward (Mar 8 2026) and starts/ends at local midnight", () => {
    const range = weekRangeForKey(TZ, "2026-03-02");
    expect(range).toEqual({ from: "2026-03-02T05:00:00.000Z", to: "2026-03-09T04:00:00.000Z" });
    expect((Date.parse(range.to) - Date.parse(range.from)) / 3_600_000).toBe(167);
  });

  it("is 169 hours across fall-back (Nov 1 2026)", () => {
    const range = weekRangeForKey(TZ, "2026-10-26");
    expect(range).toEqual({ from: "2026-10-26T04:00:00.000Z", to: "2026-11-02T05:00:00.000Z" });
    expect((Date.parse(range.to) - Date.parse(range.from)) / 3_600_000).toBe(169);
  });

  it("consecutive weeks tile with no gap or overlap, in other zones too", () => {
    for (const zone of [TZ, "America/Vancouver", "America/Halifax", "America/St_Johns"]) {
      let key = "2026-02-23";
      for (let i = 0; i < 40; i += 1) {
        expect(weekRangeForKey(zone, key).to).toBe(weekRangeForKey(zone, shiftWeekKey(key, 1)).from);
        key = shiftWeekKey(key, 1);
      }
    }
    expect(new Date(localWallTimeToUtcMs("2026-03-09", 8, 0, TZ)).toISOString()).toBe("2026-03-09T12:00:00.000Z");
  });

  it("send window: Monday/Tuesday 08:00–21:00 local only", () => {
    const at = (iso: string) => isInSendWindow(TZ, Date.parse(iso));
    expect(at("2026-10-12T11:59:00.000Z")).toBe(false); // Mon 07:59
    expect(at("2026-10-12T12:00:00.000Z")).toBe(true); // Mon 08:00
    expect(at("2026-10-13T00:59:00.000Z")).toBe(true); // Mon 20:59
    expect(at("2026-10-13T01:00:00.000Z")).toBe(false); // Mon 21:00
    expect(at("2026-10-13T14:00:00.000Z")).toBe(true); // Tue 10:00 (catch-up)
    expect(at("2026-10-14T14:00:00.000Z")).toBe(false); // Wed
    // Monday after spring-forward: 08:00 EDT = 12:00Z.
    expect(isInSendWindow(TZ, Date.parse("2026-03-09T11:30:00.000Z"))).toBe(false);
    expect(isInSendWindow(TZ, Date.parse("2026-03-09T12:00:00.000Z"))).toBe(true);
  });

  it("the scheduler gate skips all DB work Wednesday–Sunday afternoon (UTC)", () => {
    expect(couldBeSendWindowAnywhere(Date.parse("2026-10-14T12:00:00.000Z"))).toBe(false); // Wed noon
    expect(couldBeSendWindowAnywhere(Date.parse("2026-10-17T12:00:00.000Z"))).toBe(false); // Sat
    expect(couldBeSendWindowAnywhere(Date.parse("2026-10-11T19:00:00.000Z"))).toBe(true); // Sun evening (Mon morning NZ)
    expect(couldBeSendWindowAnywhere(MON_0830)).toBe(true);
  });
});

// ── Metrics ─────────────────────────────────────────────────────────────────────

function fixtureScorecard() {
  const inputs = emptyScorecardInputs();
  inputs.quotes = [
    { sentAt: "2026-10-06T15:00:00.000Z", approvedAt: "2026-10-07T15:00:00.000Z", depositPaidAt: "2026-10-07T16:00:00.000Z", approvedTotalCents: 65000, totalCents: 65000, approvedDepositCents: 20000, depositCents: 20000, currency: "CAD" },
    { sentAt: "2026-10-09T15:00:00.000Z", approvedAt: null, depositPaidAt: null, approvedTotalCents: null, totalCents: 40000, approvedDepositCents: null, depositCents: null, currency: "CAD" },
  ];
  inputs.bookings = [
    { createdAt: "2026-10-07T16:05:00.000Z", scheduledFor: "2026-10-15T13:00:00.000Z", status: "confirmed" },
    { createdAt: "2026-10-08T16:05:00.000Z", scheduledFor: "2026-10-16T13:00:00.000Z", status: "cancelled" },
  ];
  return inputs;
}

function fixtureFrontDesk() {
  return {
    conversations: [
      { lastAiReplyAt: "2026-10-06T13:00:00.000Z" },
      { lastAiReplyAt: "2026-10-11T22:00:00.000Z" },
      { lastAiReplyAt: "2026-10-12T05:00:00.000Z" }, // next week
    ],
    approvals: [
      { createdAt: "2026-10-06T13:05:00.000Z", status: "executed", decidedAt: "2026-10-06T13:20:00.000Z" },
      { createdAt: "2026-10-08T13:05:00.000Z", status: "approved", decidedAt: "2026-10-08T14:00:00.000Z" },
      { createdAt: "2026-10-09T13:05:00.000Z", status: "rejected", decidedAt: "2026-10-09T14:00:00.000Z" },
    ],
    calls: [
      { direction: "inbound", at: "2026-10-06T14:00:00.000Z", durationMs: 120_000, inVoicemail: false }, // Tue 10:00
      { direction: "inbound", at: "2026-10-06T23:30:00.000Z", durationMs: 60_000, inVoicemail: false }, // Tue 19:30 — after hours
      { direction: "inbound", at: "2026-10-10T15:00:00.000Z", durationMs: 90_000, inVoicemail: null }, // Saturday — after hours
      { direction: "inbound", at: "2026-10-07T14:00:00.000Z", durationMs: 30_000, inVoicemail: true }, // voicemail
      { direction: "inbound", at: "2026-10-07T15:00:00.000Z", durationMs: 3_000, inVoicemail: false }, // hang-up
      { direction: "outbound", at: "2026-10-07T16:00:00.000Z", durationMs: 60_000, inVoicemail: false },
      { direction: "inbound", at: "2026-10-12T14:00:00.000Z", durationMs: 60_000, inVoicemail: false }, // next week
    ],
    invoicePayments: [
      { receivedAt: "2026-10-09T18:00:00.000Z", amountCents: 30000, status: "succeeded" },
      { receivedAt: "2026-10-09T18:30:00.000Z", amountCents: 99900, status: "failed" },
    ],
    hours: HOURS,
  };
}

describe("computeWeeklyMetrics", () => {
  const range = weekRangeForKey(TZ, WEEK);

  it("counts the front desk's week from fixtures", () => {
    const m = computeWeeklyMetrics({ scorecard: fixtureScorecard(), frontDesk: fixtureFrontDesk(), range, weekStart: WEEK, timeZone: TZ });
    expect(m.textConversations).toBe(2);
    expect(m.approvals).toEqual({ asked: 3, approved: 2 });
    expect(m.calls.answered).toBe(3);
    expect(m.calls.afterHours).toBe(2);
    expect(m.quotes).toEqual({ sent: 2, approved: 1, approvedCents: 65000 });
    expect(m.jobsBooked).toBe(1);
    expect(m.collected).toEqual({ cents: 50000, deposits: 1, payments: 1 });
    // 2 texts × 3 + 3 calls × 4 + 2 quotes × 5 + 1 booking × 2 = 30 min.
    expect(m.hoursSaved).toEqual({ minutes: 30, hours: 0.5, wageValueCents: 1100 });
    expect(m.hasActivity).toBe(true);
  });

  it("handles empty front-desk tables (other parts not live yet): zeros, no after-hours claim", () => {
    const m = computeWeeklyMetrics({ scorecard: emptyScorecardInputs(), frontDesk: emptyFrontDeskInputs(), range, weekStart: WEEK, timeZone: TZ });
    expect(m).toMatchObject({
      textConversations: 0,
      approvals: { asked: 0, approved: 0 },
      calls: { answered: 0, afterHours: null, minutes: 0 },
      collected: { cents: 0, deposits: 0, payments: 0 },
      hoursSaved: { minutes: 0, hours: 0, wageValueCents: 0 },
      hasActivity: false,
    });
  });

  it("doesn't claim after-hours calls when the hours can't be read", () => {
    const frontDesk = { ...fixtureFrontDesk(), hours: { summary: "call us whenever" } };
    const m = computeWeeklyMetrics({ scorecard: emptyScorecardInputs(), frontDesk, range, weekStart: WEEK, timeZone: TZ });
    expect(m.calls.answered).toBe(3);
    expect(m.calls.afterHours).toBeNull();
    expect(isAfterHours("2026-10-06T14:00:00.000Z", HOURS, TZ)).toBe(false);
    expect(isAfterHours("2026-10-06T11:30:00.000Z", HOURS, TZ)).toBe(true); // 07:30
  });
});

describe("hours saved (estimate)", () => {
  it("is the documented per-item minutes, rounded to 0.1 h, valued at the receptionist wage", () => {
    expect(HOURS_SAVED_ASSUMPTIONS).toMatchObject({
      minutesPerTextConversation: 3,
      minutesPerCallAnswered: 4,
      minutesPerQuoteSent: 5,
      minutesPerJobBooked: 2,
      receptionistHourlyWageCents: 2200,
    });
    const saved = computeHoursSaved({ textConversations: 10, callsAnswered: 20, quotesSent: 4, jobsBooked: 6, missedCallsTextedBack: 3 });
    // 30 + 80 + 20 + 12 + 3 = 145 min.
    expect(saved).toEqual({ minutes: 145, hours: 2.4, wageValueCents: Math.round((145 / 60) * 2200) });
    expect(computeHoursSaved({ textConversations: 0, callsAnswered: 0, quotesSent: 0, jobsBooked: 0, missedCallsTextedBack: 0 }).minutes).toBe(0);
  });
});

// ── Templates ───────────────────────────────────────────────────────────────────

function busyMetrics(): WeeklyReportMetrics {
  const range = weekRangeForKey(TZ, WEEK);
  return computeWeeklyMetrics({ scorecard: fixtureScorecard(), frontDesk: fixtureFrontDesk(), range, weekStart: WEEK, timeZone: TZ });
}

describe("weekly report templates", () => {
  const options = {
    companyName: "Northshore Lawn & Snow",
    platformBrand: "CrankLeads",
    reportUrl: "https://app.crankleads.test/reports/weekly?week=2026-10-05",
  };

  it("a CrankLeads email never says EmpireVu, labels hours saved as an estimate, and links the report", () => {
    const email = renderWeeklyEmail(busyMetrics(), options);
    for (const part of [email.subject, email.html, email.text]) {
      expect(part).not.toMatch(/empirevu/i);
    }
    expect(email.subject).toBe("Your front desk last week: 3 calls answered, 2 text conversations");
    expect(email.html).toContain("Northshore Lawn &amp; Snow");
    expect(email.html).toContain("Time saved (estimate)");
    expect(email.html).toContain("Sent by CrankLeads for Northshore Lawn &amp; Snow");
    expect(email.html).toContain('href="https://app.crankleads.test/reports/weekly?week=2026-10-05"');
    expect(email.text).toContain("About 30 min of front desk work handled (estimate)");
    expect(email.text).toContain("Estimate: 3 min per text conversation");
    expect(email.text).toContain("- Calls answered by your AI: 3 (2 after hours");
    expect(email.text).toContain("- Deposits & payments collected: $500");
  });

  it("quiet week: short note, no hours claim", () => {
    const quiet = emptyWeeklyMetrics(WEEK, weekRangeForKey(TZ, WEEK), TZ);
    const email = renderWeeklyEmail(quiet, options);
    expect(email.subject).toBe("Your front desk last week: a quiet week");
    expect(email.text).toContain("A quiet week");
    expect(email.text).not.toContain("front desk work handled");
    const sms = renderWeeklySms(quiet, options);
    expect(sms).toContain("Quiet week");
    expect(sms.split("\n")).toHaveLength(3);
  });

  it("SMS: 3 lines, GSM-7, at most 2 segments — even with a long name and every number non-zero", () => {
    const sms = renderWeeklySms(busyMetrics(), options);
    expect(sms).toBe(
      [
        "CrankLeads weekly report for Northshore Lawn & Snow, Oct 5-11:",
        "3 calls answered (2 after hours), 2 text chats, 1 job booked, 2 quotes sent.",
        "About 30 min of front desk work saved (est). Full report: https://app.crankleads.test/reports/weekly?week=2026-10-05",
      ].join("\n"),
    );
    expect(smsSegments(sms)).toMatchObject({ encoding: "GSM-7" });
    expect(smsSegments(sms).segments).toBeLessThanOrEqual(2);
    expect(sms).not.toMatch(/empirevu/i);

    const huge: WeeklyReportMetrics = {
      ...busyMetrics(),
      textConversations: 1234,
      calls: { answered: 4321, afterHours: 1999, minutes: 9000 },
      jobsBooked: 777,
      quotes: { sent: 888, approved: 300, approvedCents: 123456789 },
      collected: { cents: 987654321, deposits: 50, payments: 60 },
      missedCalls: { caught: 99, textedBack: 98 },
      reviewsRequested: 55,
      hoursSaved: { minutes: 99999, hours: 1666.7, wageValueCents: 3666630 },
    };
    const long = renderWeeklySms(huge, {
      ...options,
      companyName: "Très Long Name — Landscaping, Snow Removal & Property Maintenance Services of Greater Sudbury Inc.",
      reportUrl: "https://app.crankleads.example.com/reports/weekly?week=2026-10-05&utm_source=sms&utm_campaign=weekly",
    });
    expect(smsSegments(long).encoding).toBe("GSM-7");
    expect(smsSegments(long).segments).toBeLessThanOrEqual(2);
    expect(long.split("\n")).toHaveLength(3);
    expect(long).toContain("https://app.crankleads.example.com/reports/weekly?week=2026-10-05&utm_source=sms&utm_campaign=weekly");
  });

  it("segment counting and GSM folding", () => {
    expect(smsSegments("a".repeat(160)).segments).toBe(1);
    expect(smsSegments("a".repeat(161)).segments).toBe(2);
    expect(smsSegments("a".repeat(306)).segments).toBe(2);
    expect(smsSegments("a".repeat(307)).segments).toBe(3);
    expect(smsSegments("—").encoding).toBe("UCS-2");
    expect(toGsmSafe("Très — “Smith’s”")).toBe("Tres - \"Smith's\"");
  });
});

// ── Settings ────────────────────────────────────────────────────────────────────

describe("weekly report settings", () => {
  it("defaults ON (text + email) for CrankLeads, OFF (email only) for others", () => {
    expect(parseWeeklyReportSettings({}, true)).toEqual({ enabled: true, channels: ["sms", "email"], explicit: false });
    expect(parseWeeklyReportSettings(null, false)).toEqual({ enabled: false, channels: ["email"], explicit: false });
    expect(parseWeeklyReportSettings({ weekly_report: { enabled: false } }, true).enabled).toBe(false);
    expect(parseWeeklyReportSettings({ weekly_report: { enabled: true, channels: ["sms"] } }, false)).toMatchObject({ enabled: true, channels: ["email"] });
    expect(parseWeeklyReportSettings({ weekly_report: { channels: ["sms", "fax"] } }, true).channels).toEqual(["sms"]);
  });

  it("merging touches only the weekly_report section", () => {
    const blob = { sms_agent: { enabled: true, autonomy: "ask_first" }, call_answering: { mode: "voicemail" }, weekly_report: { channels: ["email"] } };
    expect(mergeWeeklyReportSettings(blob, { enabled: false })).toEqual({
      sms_agent: { enabled: true, autonomy: "ask_first" },
      call_answering: { mode: "voicemail" },
      weekly_report: { channels: ["email"], enabled: false },
    });
  });
});

// ── Send pass ───────────────────────────────────────────────────────────────────

function company(over: Record<string, unknown>) {
  return {
    name: "Company",
    timezone: TZ,
    created_at: "2026-08-15T12:00:00.000Z",
    updated_at: "2026-09-01T12:00:00.000Z",
    owner_email: "owner@example.test",
    owner_phone_e164: "+17055550100",
    brand_primary_color: null,
    stage: "active",
    ai_settings: {},
    hours: HOURS,
    ...over,
  };
}

function seed(): FakeDb {
  return createFakeDb(
    {
      companies: [
        company({ id: CO_1, organization_id: ORG_1, name: "Northshore Lawn & Snow", owner_email: "owner@northshore.test" }),
        company({ id: CO_HOUSE, organization_id: ORG_HOUSE, name: "A1 Marine Care" }),
      ],
      organizations: [
        { id: ORG_1, subscription_status: "active", platform_brand: "crankleads", crankleads_tier: "close" },
        { id: ORG_HOUSE, subscription_status: "active", platform_brand: "empirevu", crankleads_tier: null },
      ],
      crankleads_purchases: [{ id: "p1", company_id: CO_1, organization_id: ORG_1, live_at: "2026-09-20T15:00:00.000Z" }],
      sms_conversations: [
        { id: "conv-1", organization_id: ORG_1, company_id: CO_1, last_ai_reply_at: "2026-10-06T13:00:00.000Z" },
        { id: "conv-2", organization_id: ORG_1, company_id: CO_1, last_ai_reply_at: "2026-10-09T13:00:00.000Z" },
        // Another tenant's conversation in the same week — must never leak in.
        { id: "conv-x", organization_id: ORG_HOUSE, company_id: CO_HOUSE, last_ai_reply_at: "2026-10-06T13:00:00.000Z" },
      ],
      retell_calls: [
        { id: "call-1", organization_id: ORG_1, company_id: CO_1, direction: "inbound", created_at: "2026-10-06T23:30:00.000Z", duration_ms: 60_000, in_voicemail: false },
      ],
      bookings: [
        { id: "b-1", organization_id: ORG_1, company_id: CO_1, created_at: "2026-10-07T16:05:00.000Z", scheduled_for: "2026-10-15T13:00:00.000Z", status: "confirmed" },
      ],
    },
    { weekly_report_sends: [["company_id", "week_start"]] },
  );
}

function sends(db: FakeDb) {
  return db.tables.weekly_report_sends ?? [];
}

beforeEach(() => {
  sendSms.mockReset().mockResolvedValue({ sid: "SM1" });
  sendEmail.mockReset().mockResolvedValue({ id: "re_1" });
  vi.stubEnv("OWNER_EMAIL", "");
  vi.stubEnv("PLATFORM_BRAND_NAME", "");
  vi.stubEnv("APP_BASE_URL", "https://app.test");
  vi.stubEnv("CRANKLEADS_APP_BASE_URL", "https://app.crankleads.test");
  requireOrganizationContext.mockReset();
  resetWeeklyReportThrottle();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("runWeeklyReports — Monday 08:30 Toronto", () => {
  it("texts (platform number) + emails a live CrankLeads owner once; house org is off by default", async () => {
    const db = seed();
    const outcomes = await runWeeklyReports(db.client, { nowMs: MON_0830, respectSendWindow: true });
    expect(Object.fromEntries(outcomes.map((o) => [o.companyId, [o.result, o.reason ?? null]]))).toEqual({
      [CO_1]: ["sent", null],
      [CO_HOUSE]: ["skipped", "disabled"],
    });

    expect(sendSms).toHaveBeenCalledTimes(1);
    const sms = sendSms.mock.calls[0][0] as { to: string; body: string; from?: string };
    expect(sms.to).toBe("+17055550100");
    expect(sms.from).toBeUndefined(); // platform number (TWILIO_FROM_NUMBER), never the company line
    expect(sms.body).toContain("CrankLeads weekly report for Northshore Lawn & Snow, Oct 5-11:");
    expect(sms.body).toContain("https://app.crankleads.test/reports/weekly?week=2026-10-05");
    expect(smsSegments(sms.body).segments).toBeLessThanOrEqual(2);

    expect(sendEmail).toHaveBeenCalledTimes(1);
    const mail = sendEmail.mock.calls[0][0] as { to: string; subject: string; fromName: string; html: string; body: string };
    expect(mail.to).toBe("owner@northshore.test");
    expect(mail.fromName).toBe("CrankLeads");
    expect(`${mail.subject} ${mail.html} ${mail.body}`).not.toMatch(/empirevu/i);
    expect(mail.subject).toBe("Your front desk last week: 1 call answered, 2 text conversations");

    const row = sends(db).find((r) => r.company_id === CO_1);
    expect(row).toMatchObject({ organization_id: ORG_1, week_start: WEEK, status: "sent", channels: ["sms", "email"] });
    expect((row?.metrics as WeeklyReportMetrics).textConversations).toBe(2); // conv-x (other tenant) excluded
    expect((row?.metrics as WeeklyReportMetrics).calls).toMatchObject({ answered: 1, afterHours: 1 });
  });

  it("is idempotent: a second pass sends nothing", async () => {
    const db = seed();
    await runWeeklyReports(db.client, { nowMs: MON_0830, respectSendWindow: true });
    const again = await runWeeklyReports(db.client, { nowMs: MON_0830 + 3_600_000, respectSendWindow: true });
    expect(again.find((o) => o.companyId === CO_1)).toMatchObject({ result: "skipped", reason: "already_sent" });
    expect(sendSms).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("claim race: two workers at once → exactly one send", async () => {
    const db = seed();
    const [a, b] = await Promise.all([
      runWeeklyReports(db.client, { nowMs: MON_0830, companyId: CO_1, respectSendWindow: true }),
      runWeeklyReports(db.client, { nowMs: MON_0830, companyId: CO_1, respectSendWindow: true }),
    ]);
    const results = [a[0].result, b[0].result].sort();
    expect(results).toEqual(["sent", "skipped"]);
    expect(sendSms).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sends(db)).toHaveLength(1);
  });

  it("doesn't send while another run holds the claim", async () => {
    const db = seed();
    db.tables.weekly_report_sends = [{ id: "w1", organization_id: ORG_1, company_id: CO_1, week_start: WEEK, status: "claimed", updated_at: "2026-10-12T12:29:00.000Z" }];
    const outcomes = await runWeeklyReports(db.client, { nowMs: MON_0830, companyId: CO_1 });
    expect(outcomes[0]).toMatchObject({ result: "skipped", reason: "already_sent" });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("retries a failed send (after an hour), and a partial success counts as sent", async () => {
    const db = seed();
    sendEmail.mockRejectedValueOnce(new Error("Resend down"));
    sendSms.mockRejectedValueOnce(new Error("Twilio down"));
    const first = await runWeeklyReports(db.client, { nowMs: MON_0830, companyId: CO_1, respectSendWindow: true });
    expect(first[0]).toMatchObject({ result: "failed" });
    expect(sends(db)[0]).toMatchObject({ status: "failed" });
    sends(db)[0].updated_at = new Date(MON_0830).toISOString();

    const tooSoon = await runWeeklyReports(db.client, { nowMs: MON_0830 + 10 * 60_000, companyId: CO_1, respectSendWindow: true });
    expect(tooSoon[0]).toMatchObject({ result: "skipped", reason: "retry_later" });

    sendSms.mockRejectedValueOnce(new Error("Twilio still down"));
    const retry = await runWeeklyReports(db.client, { nowMs: MON_0830 + 61 * 60_000, companyId: CO_1, respectSendWindow: true });
    expect(retry[0]).toMatchObject({ result: "sent", channels: ["email"] });
    expect(sends(db)).toHaveLength(1);
    expect(sends(db)[0]).toMatchObject({ status: "sent", channels: ["email"] });
    expect(String(sends(db)[0].last_error)).toContain("Twilio still down");
  });

  it("not before 08:00 local, and not once the account was not live by the end of the week", async () => {
    const db = seed();
    const early = await runWeeklyReports(db.client, { nowMs: Date.parse("2026-10-12T11:30:00.000Z"), companyId: CO_1, respectSendWindow: true });
    expect(early[0]).toMatchObject({ result: "skipped", reason: "outside_send_window" });

    db.tables.crankleads_purchases[0].live_at = null;
    const notLive = await runWeeklyReports(db.client, { nowMs: MON_0830, companyId: CO_1, respectSendWindow: true });
    expect(notLive[0]).toMatchObject({ result: "skipped", reason: "not_live" });

    db.tables.crankleads_purchases[0].live_at = "2026-10-12T05:00:00.000Z"; // went live after the week ended
    const lateLive = await runWeeklyReports(db.client, { nowMs: MON_0830, companyId: CO_1, respectSendWindow: true });
    expect(lateLive[0]).toMatchObject({ result: "skipped", reason: "not_live" });

    expect(sendSms).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(sends(db)).toHaveLength(0);
  });

  it("not when the owner turned it off; email only when text is off", async () => {
    const db = seed();
    db.tables.companies[0].ai_settings = { sms_agent: { enabled: true }, weekly_report: { enabled: false } };
    const off = await runWeeklyReports(db.client, { nowMs: MON_0830, companyId: CO_1, respectSendWindow: true });
    expect(off[0]).toMatchObject({ result: "skipped", reason: "disabled" });
    expect(sendEmail).not.toHaveBeenCalled();

    db.tables.companies[0].ai_settings = { weekly_report: { channels: ["email"] } };
    const emailOnly = await runWeeklyReports(db.client, { nowMs: MON_0830, companyId: CO_1, respectSendWindow: true });
    expect(emailOnly[0]).toMatchObject({ result: "sent", channels: ["email"] });
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("a house (non-CrankLeads) org that opts in gets email only, branded EmpireVu", async () => {
    const db = seed();
    db.tables.companies[1].ai_settings = { weekly_report: { enabled: true, channels: ["sms", "email"] } };
    const outcomes = await runWeeklyReports(db.client, { nowMs: MON_0830, companyId: CO_HOUSE, respectSendWindow: true });
    expect(outcomes[0]).toMatchObject({ result: "sent", channels: ["email"] });
    expect(sendSms).not.toHaveBeenCalled();
    expect((sendEmail.mock.calls[0][0] as { fromName: string }).fromName).toBe("EmpireVu");
  });

  it("quiet week: skips a brand-new account with no activity in 30 days, but sends a short note after recent activity", async () => {
    const db = seed();
    db.tables.sms_conversations = [];
    db.tables.retell_calls = [];
    db.tables.bookings = [];
    const silent = await runWeeklyReports(db.client, { nowMs: MON_0830, companyId: CO_1, respectSendWindow: true });
    expect(silent[0]).toMatchObject({ result: "skipped", reason: "no_activity" });
    expect(sends(db)[0]).toMatchObject({ status: "skipped", last_error: "no_activity" });
    expect(sendEmail).not.toHaveBeenCalled();

    const db2 = seed();
    db2.tables.sms_conversations = [];
    db2.tables.retell_calls = [{ id: "old", organization_id: ORG_1, company_id: CO_1, direction: "inbound", created_at: "2026-09-25T15:00:00.000Z", duration_ms: 60_000 }];
    db2.tables.bookings = [];
    const quiet = await runWeeklyReports(db2.client, { nowMs: MON_0830, companyId: CO_1, respectSendWindow: true });
    expect(quiet[0]).toMatchObject({ result: "sent" });
    expect((sendEmail.mock.calls[0][0] as { subject: string }).subject).toBe("Your front desk last week: a quiet week");
    expect((sendSms.mock.calls[0][0] as { body: string }).body).toContain("Quiet week");
  });

  it("dry run renders and writes nothing", async () => {
    const db = seed();
    const outcomes = await runWeeklyReports(db.client, { nowMs: MON_0830, dryRun: true, companyId: CO_1 });
    expect(outcomes[0]).toMatchObject({ result: "dry_run", emailTo: "owner@northshore.test", smsTo: "+17055550100" });
    expect(outcomes[0].sms).toContain("Oct 5-11");
    expect(sendSms).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(db.queries.some((q) => q.op !== "select" && q.table === "weekly_report_sends")).toBe(false);
  });

  it("keeps every front-desk read inside the company's tenant", async () => {
    const db = seed();
    await runWeeklyReports(db.client, { nowMs: MON_0830, companyId: CO_1 });
    const scoped = new Set(["sms_conversations", "owner_approvals", "retell_calls", "invoice_payments", "message_log", "quotes", "bookings"]);
    const reads = db.queries.filter((q) => scoped.has(q.table) && q.op === "select");
    expect(reads.length).toBeGreaterThan(5);
    for (const query of reads) {
      const eqs = query.filters.filter((f) => f.kind === "eq");
      expect(eqs, query.table).toContainEqual({ kind: "eq", column: "organization_id", value: ORG_1 });
      expect(eqs, query.table).toContainEqual({ kind: "eq", column: "company_id", value: CO_1 });
    }
  });
});

describe("processWeeklyReports (scheduler entry)", () => {
  it("does no DB work outside the possible window, and throttles to every 10 minutes", async () => {
    const db = seed();
    expect(await processWeeklyReports(db.client, Date.parse("2026-10-15T14:00:00.000Z"))).toBe(0); // Thursday
    expect(db.queries).toHaveLength(0);

    expect(await processWeeklyReports(db.client, MON_0830)).toBe(1);
    const queriesAfterFirst = db.queries.length;
    expect(await processWeeklyReports(db.client, MON_0830 + 60_000)).toBe(0); // throttled
    expect(db.queries.length).toBe(queriesAfterFirst);
  });
});

describe("parseWeeklyArgs", () => {
  it("parses flags and normalizes --week to its Monday", () => {
    expect(parseWeeklyArgs([])).toEqual({ dryRun: false, force: false, companyId: null, week: null });
    expect(parseWeeklyArgs(["--dry-run", "--company", "co-1", "--week=2026-10-08"])).toEqual({
      dryRun: true,
      force: false,
      companyId: "co-1",
      week: "2026-10-05",
    });
    expect(() => parseWeeklyArgs(["--week", "Oct 5"])).toThrow(/YYYY-MM-DD/);
    expect(() => parseWeeklyArgs(["--force"])).toThrow(/requires --company/);
    expect(() => parseWeeklyArgs(["--everyone"])).toThrow(/Unknown argument/);
  });
});

// ── Settings route ──────────────────────────────────────────────────────────────

describe("PATCH …/ai-settings/weekly-report", () => {
  function membership(role: string) {
    return { organizationId: ORG_1, user: { id: "user-1", email: "me@northshore.test" }, membership: { role }, profile: null };
  }
  const params = { params: { organizationId: ORG_1, companyId: CO_1 } };
  const patch = (body: unknown) => new Request("http://test", { method: "PATCH", body: JSON.stringify(body) });

  it("is owner/admin only", async () => {
    serverClient.current = seed().client;
    requireOrganizationContext.mockResolvedValue(membership("member"));
    const res = await settingsPATCH(patch({ enabled: false }), params);
    expect(res.status).toBe(403);
  });

  it("merges only ai_settings.weekly_report", async () => {
    const db = seed();
    db.tables.companies[0].ai_settings = { sms_agent: { autonomy: "ask_first" }, call_answering: { mode: "ai" } };
    serverClient.current = db.client;
    requireOrganizationContext.mockResolvedValue(membership("admin"));
    const res = await settingsPATCH(patch({ enabled: true, channels: ["email"] }), params);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { enabled: boolean; channels: string[]; isCrankleads: boolean } };
    expect(body.data).toMatchObject({ enabled: true, channels: ["email"], isCrankleads: true });
    expect(db.tables.companies[0].ai_settings).toEqual({
      sms_agent: { autonomy: "ask_first" },
      call_answering: { mode: "ai" },
      weekly_report: { enabled: true, channels: ["email"] },
    });
  });

  it("rejects an empty channel list and unknown fields", async () => {
    serverClient.current = seed().client;
    requireOrganizationContext.mockResolvedValue(membership("owner"));
    expect((await settingsPATCH(patch({ channels: [] }), params)).status).toBe(400);
    expect((await settingsPATCH(patch({ sms_agent: { enabled: false } }), params)).status).toBe(400);
  });
});

describe("in-app view + test send", () => {
  it("returns this week so far + N complete weeks, using the numbers we sent for sent weeks", async () => {
    const db = seed();
    await runWeeklyReports(db.client, { nowMs: MON_0830, companyId: CO_1 });
    // Later data changes don't rewrite a week that was already reported.
    db.tables.sms_conversations.push({ id: "conv-late", organization_id: ORG_1, company_id: CO_1, last_ai_reply_at: "2026-10-08T13:00:00.000Z" });
    const view = await getWeeklyReportView({ organizationId: ORG_1, actorProfileId: "u", supabase: db.client }, CO_1, {
      weeks: 3,
      includeCurrent: true,
      nowMs: MON_0830,
    });
    expect(view.weeks.map((w) => [w.weekStart, w.partial])).toEqual([
      ["2026-10-12", true],
      ["2026-10-05", false],
      ["2026-09-28", false],
      ["2026-09-21", false],
    ]);
    expect(view.weeks[1].metrics.textConversations).toBe(2);
    expect(view.weeks[1].send).toMatchObject({ status: "sent", channels: ["sms", "email"] });
    expect(view).toMatchObject({ isCrankleads: true, brandName: "CrankLeads", settings: { enabled: true, channels: ["sms", "email"] } });
  });

  it("'send a test to me' emails the requester and doesn't use up the week", async () => {
    const db = seed();
    const result = await sendTestWeeklyReport(db.client, { organizationId: ORG_1, companyId: CO_1, toEmail: "me@northshore.test", nowMs: MON_0830 });
    expect(result).toMatchObject({ week: WEEK, emailTo: "me@northshore.test", smsTo: "+17055550100", sent: ["sms", "email"] });
    expect((sendEmail.mock.calls[0][0] as { subject: string }).subject).toMatch(/^\[Test\] /);
    expect(sends(db)).toHaveLength(0);
    const real = await runWeeklyReports(db.client, { nowMs: MON_0830, companyId: CO_1, respectSendWindow: true });
    expect(real[0]).toMatchObject({ result: "sent" });
  });
});

describe("AI texts counted from message_log.sent_by", () => {
  const range = weekRangeForKey(TZ, WEEK);

  it("textReplies = AI texts sent in the week; textConversations = customers who got one (plus older conversation rows)", () => {
    const frontDesk = {
      ...emptyFrontDeskInputs(),
      aiTexts: [
        { contactId: "c-1", at: "2026-10-06T14:00:00.000Z" },
        { contactId: "c-1", at: "2026-10-06T14:05:00.000Z" },
        { contactId: "c-2", at: "2026-10-08T20:00:00.000Z" },
        { contactId: "c-3", at: "2026-10-12T14:00:00.000Z" }, // next week
      ],
      conversations: [
        { contactId: "c-2", lastAiReplyAt: "2026-10-08T20:00:00.000Z" }, // same customer — not double-counted
        { contactId: "c-4", lastAiReplyAt: "2026-10-09T20:00:00.000Z" }, // a reply logged before sent_by existed
      ],
    };
    const withCommands = {
      ...frontDesk,
      approvals: [
        { createdAt: "2026-10-06T14:00:00.000Z", status: "executed", decidedAt: "2026-10-06T14:10:00.000Z", kind: "custom_price" },
        { createdAt: "2026-10-06T15:00:00.000Z", status: "executed", decidedAt: "2026-10-06T15:01:00.000Z", kind: "owner_command" }, // the owner's own "move Jamie" confirmation
      ],
    };
    const m = computeWeeklyMetrics({ scorecard: emptyScorecardInputs(), frontDesk: withCommands, range, weekStart: WEEK, timeZone: TZ });
    expect(m.approvals).toEqual({ asked: 1, approved: 1 });
    expect(m.textReplies).toBe(3);
    expect(m.textConversations).toBe(3);
  });

  it("fetchFrontDeskInputs reads only this company's sent AI texts in the week", async () => {
    const row = (over: Record<string, unknown>) => ({
      organization_id: "org-1", company_id: "co-1", contact_id: "c-1", channel: "sms", direction: "outbound", status: "sent",
      sent_by: "sms_agent", created_at: "2026-10-06T14:00:00.000Z", ...over,
    });
    const db = createFakeDb({
      message_log: [
        row({ id: "m1" }),
        row({ id: "m2", contact_id: "c-2" }),
        row({ id: "m3", sent_by: null }), // staff
        row({ id: "m4", status: "failed" }),
        row({ id: "m5", direction: "inbound", sent_by: null }),
        row({ id: "m6", company_id: "co-2" }),
        row({ id: "m7", organization_id: "org-2", company_id: "co-x" }),
        row({ id: "m8", created_at: "2026-10-13T14:00:00.000Z" }),
      ],
    });
    const inputs = await fetchFrontDeskInputs({ organizationId: "org-1", actorProfileId: null, supabase: db.client } as never, "co-1", range);
    expect(inputs.aiTexts).toEqual([
      { contactId: "c-1", at: "2026-10-06T14:00:00.000Z" },
      { contactId: "c-2", at: "2026-10-06T14:00:00.000Z" },
    ]);
  });
});
