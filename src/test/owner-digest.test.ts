import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// deliverMessage's collaborators — mock the outbound + metering so no network/admin client
// is touched. usage is PARTIALLY mocked: owner-digest needs getMonthlyUsage/getUsageForFeature/
// FEATURE_USAGE_KIND (real), only recordUsageSafe is stubbed (it would spin up an admin client).
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

import {
  digestHasActivity,
  renderDigestEmail,
  renderDigestSms,
  SMS_MAX_CHARS,
  type DigestData,
} from "@/server/templates/digest";
import {
  localDateInTimeZone,
  parseDigestSettings,
  sendTestDigest,
} from "@/server/services/owner-digest";

const DEEP_LINK = "https://app.empirevu.com/inbox";

function fixtureDay(over: Partial<DigestData> = {}): DigestData {
  return {
    companyName: "A1 Marine",
    localDate: "2026-09-12",
    calls: { total: 5, booked: 2, quotesSent: 3, needsCallback: 1 },
    newLeads: 4,
    messagesNeedingReply: 2,
    quotesUnviewed48h: 1,
    todaysBookings: 3,
    usage: { smsSent: 40, emailSent: 12, voiceMinutes: 88, cap: { feature: "voice min", used: 88, limit: 500 } },
    attribution: { approvedCents: 500_000, paidCents: 150_000, currency: "CAD" },
    ...over,
  };
}

// ── Settings parsing ───────────────────────────────────────────────────────

describe("parseDigestSettings", () => {
  it("defaults a missing/empty blob to disabled, 06:30, email-only", () => {
    expect(parseDigestSettings(null)).toEqual({ enabled: false, sendAtLocal: "06:30", channels: ["email"], alwaysSend: false });
    expect(parseDigestSettings({})).toEqual({ enabled: false, sendAtLocal: "06:30", channels: ["email"], alwaysSend: false });
  });

  it("coerces enabled/always_send, filters channels, and rejects a bad time", () => {
    expect(
      parseDigestSettings({ enabled: true, send_at_local: "25:61", channels: ["sms", "carrier-pigeon"], always_send: true }),
    ).toEqual({ enabled: true, sendAtLocal: "06:30", channels: ["sms"], alwaysSend: true });
  });

  it("falls back to email when channels end up empty", () => {
    expect(parseDigestSettings({ enabled: true, channels: [] }).channels).toEqual(["email"]);
  });
});

// ── Idempotency key: local_date in the COMPANY timezone (Decision #3) ─────────

describe("localDateInTimeZone", () => {
  it("uses the company-local calendar date, not the UTC date, around midnight UTC", () => {
    // 04:30Z on Mar 2 is still Mar 1, 23:30 in America/Toronto (EST, UTC-5) — a UTC date
    // key ('2026-03-02') would double-send; the local key is '2026-03-01'.
    expect(localDateInTimeZone("America/Toronto", Date.parse("2026-03-02T04:30:00Z"))).toBe("2026-03-01");
    // Past local midnight (05:00Z), the local date rolls to Mar 2.
    expect(localDateInTimeZone("America/Toronto", Date.parse("2026-03-02T05:30:00Z"))).toBe("2026-03-02");
  });
});

// ── SMS render + truncation (Decision #4) ────────────────────────────────────

describe("renderDigestSms", () => {
  it("renders the overnight numbers and always ends with the intact deep link (golden)", () => {
    const sms = renderDigestSms(fixtureDay(), DEEP_LINK);
    expect(sms).toContain("A1 Marine:");
    expect(sms).toContain("5 calls");
    expect(sms).toContain("1 to call back");
    expect(sms).toContain("$1,500.00 collected this month.");
    expect(sms.endsWith(DEEP_LINK)).toBe(true);
    expect(sms.length).toBeLessThanOrEqual(SMS_MAX_CHARS);
  });

  it("hard-truncates content at 320 chars but never cuts the deep link", () => {
    const sms = renderDigestSms(fixtureDay({ companyName: "Marina ".repeat(80).trim() }), DEEP_LINK);
    expect(sms.length).toBeLessThanOrEqual(SMS_MAX_CHARS);
    expect(sms.endsWith(DEEP_LINK)).toBe(true); // link intact
    expect(sms).toContain("…"); // content was clipped
  });

  it("emits a one-line quiet-night message when nothing happened", () => {
    const quiet = fixtureDay({
      calls: { total: 0, booked: 0, quotesSent: 0, needsCallback: 0 },
      newLeads: 0,
      messagesNeedingReply: 0,
      quotesUnviewed48h: 0,
      todaysBookings: 0,
    });
    expect(digestHasActivity(quiet)).toBe(false);
    const sms = renderDigestSms(quiet, DEEP_LINK);
    expect(sms).toContain("quiet night");
    expect(sms.endsWith(DEEP_LINK)).toBe(true);
  });
});

describe("renderDigestEmail", () => {
  it("includes the company, the overnight numbers, the money, and the CTA link", () => {
    const email = renderDigestEmail(fixtureDay(), { deepLink: DEEP_LINK });
    expect(email.subject).toBe("A1 Marine: your morning digest");
    expect(email.html).toContain("A1 Marine");
    expect(email.html).toContain("$1,500.00");
    expect(email.html).toContain(DEEP_LINK);
    expect(email.text).toContain("Calls: 5 (1 need a callback)");
    expect(email.text).toContain("Plan usage: 88 / 500 voice min");
  });

  it("uses the quiet subject/body when nothing happened", () => {
    const email = renderDigestEmail(fixtureDay({
      calls: { total: 0, booked: 0, quotesSent: 0, needsCallback: 0 },
      newLeads: 0,
      messagesNeedingReply: 0,
      quotesUnviewed48h: 0,
      todaysBookings: 0,
    }), { deepLink: DEEP_LINK });
    expect(email.subject).toBe("A1 Marine: quiet night");
    expect(email.text).toContain("quiet night");
  });
});

// ── Quiet failure: no phone + sms channel → skip SMS, still send email (Decision #5) ──

interface FakeCompany {
  id: string;
  name: string;
  timezone: string | null;
  owner_email: string | null;
  owner_phone_e164: string | null;
  brand_primary_color: string | null;
  brand_from_name: string | null;
  brand_reply_email: string | null;
  digest: unknown;
}

function makeContext(company: FakeCompany) {
  const messageLogInserts: Array<Record<string, unknown>> = [];
  // A generic chainable + thenable query stub: every filter returns itself; awaiting it (or
  // .then/.single/.maybeSingle) yields the table's canned result.
  function chain(result: unknown) {
    const p: Record<string, unknown> = {};
    for (const method of ["select", "eq", "gte", "gt", "lte", "lt", "is", "not", "in", "order", "limit"]) {
      p[method] = () => p;
    }
    p.single = () => Promise.resolve(result);
    p.maybeSingle = () => Promise.resolve(result);
    p.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej);
    return p;
  }
  const supabase = {
    rpc: () => Promise.resolve({ data: [], error: null }),
    from(table: string) {
      if (table === "companies") return chain({ data: company, error: null });
      if (table === "message_log") {
        const api: Record<string, unknown> = {
          insert: (row: Record<string, unknown>) => {
            messageLogInserts.push(row);
            return Promise.resolve({ error: null });
          },
          select: () => api,
          eq: () => api,
          limit: () => Promise.resolve({ data: [], error: null }),
        };
        return api;
      }
      return chain({ data: [], count: 0, error: null });
    },
  };
  return { context: { organizationId: "org-1", actorProfileId: null, supabase } as never, messageLogInserts };
}

beforeEach(() => {
  sendSms.mockReset().mockResolvedValue({ sid: "SM1" });
  sendEmail.mockReset().mockResolvedValue({ id: "re_1" });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("sendTestDigest — quiet-failure handling", () => {
  const company: FakeCompany = {
    id: "co-1",
    name: "A1 Marine",
    timezone: "America/Toronto",
    owner_email: "owner@a1.test",
    owner_phone_e164: null, // no phone on file
    brand_primary_color: null,
    brand_from_name: "A1 Marine",
    brand_reply_email: null,
    digest: { enabled: true, send_at_local: "06:30", channels: ["email", "sms"], always_send: false },
  };

  it("skips SMS with a reason when there's no phone, but still sends the email — never throws", async () => {
    const { context } = makeContext(company);
    const result = await sendTestDigest(context, "co-1", Date.parse("2026-09-12T13:00:00Z"));

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendSms).not.toHaveBeenCalled();
    expect(result.emailStatus).toBe("sent");
    expect(result.smsStatus).toBe("skipped:no_phone");
    expect(result.channelsSent).toEqual(["email"]);
    expect(result.sent).toBe(true);
  });
});
