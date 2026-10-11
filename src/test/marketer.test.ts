/**
 * The AI Marketer (docs/ai-staff.md → "Marketer") against the in-memory DB: settings defaults
 * (CrankLeads on, house orgs off), the win-back audience and its exclusions, the drafted
 * campaign + approval text, the owner's Y through the real owner-channel decideApproval, the
 * throttled sender (window, per-hour, weekly cap, per-recipient claims, opt-outs at send time),
 * Google review replies, weekly Google posts, and the owner tools.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendSms = vi.fn((..._a: unknown[]) => Promise.resolve({ sid: `SM${Math.random().toString(36).slice(2, 10)}` }));
vi.mock("@/server/outbound/sms", () => ({ sendSms: (...a: unknown[]) => sendSms(...a) }));
vi.mock("@/server/outbound/email", () => ({ sendEmail: vi.fn(() => Promise.resolve({ id: "re_1" })) }));
vi.mock("@/server/services/usage", () => ({ recordUsageSafe: vi.fn(), recordAiUsageSafe: vi.fn() }));
vi.mock("@/server/services/workflow-engine/dispatch", () => ({
  emitActivityEventAndDispatch: vi.fn(() => Promise.resolve({ activityEvent: {}, workflowEventJob: null })),
}));

import { decideApproval, expireApproval } from "@/server/services/owner-channel/approvals";
import { OWNER_TOOLS } from "@/server/services/owner-channel/tools";
import { AGENT_TOOLS } from "@/server/services/sms-agent/tools";
import { registryProblems, roleApprovalExecutor, roleOwnerTools } from "@/server/services/staff/registry";
import { marketerRole } from "@/server/services/staff/marketer";
import { fallbackWinBackBody, marketingCopyProblems, type MarketerModel } from "@/server/services/staff/marketer/ai";
import { buildWinBackAudience } from "@/server/services/staff/marketer/audience";
import {
  campaignResults,
  composeCampaignTemplate,
  draftWinBackCampaign,
  personalise,
  sendCampaignBatches,
  sweepMonthlyWinBack,
} from "@/server/services/staff/marketer/campaigns";
import { withDeps, type MarketerDeps } from "@/server/services/staff/marketer/deps";
import { mapPlaceReviews, type FetchedPlaceReviews } from "@/server/services/staff/marketer/google";
import { marketingResultsTool, startWinBackTool } from "@/server/services/staff/marketer/owner-tools";
import { draftWeeklyPost, sweepGooglePosts } from "@/server/services/staff/marketer/posts";
import { ingestReviewsForCompany, sweepGoogleReviews } from "@/server/services/staff/marketer/reviews";
import { listMarketingCompanies, loadMarketingCompany, mergeMarketingSettings, readMarketingSettings } from "@/server/services/staff/marketer/settings";
import { createFakeDb, type FakeDb } from "@/test/helpers/fake-supabase";

const ORG = "org-cl";
const CO = "co-1";
const HOUSE_ORG = "org-a1";
const HOUSE_CO = "co-a1";
const OWNER = "+17055550142";
// Tue Oct 13 2026, 11:00 in Toronto (EDT) — inside the Mon–Sat 10–19 window.
const NOW = Date.parse("2026-10-13T15:00:00Z");
const DAY = 86_400_000;
const daysAgo = (d: number) => new Date(NOW - d * DAY).toISOString();

type Row = Record<string, unknown>;

function contact(id: string, over: Row = {}): Row {
  return {
    id, organization_id: ORG, company_id: CO, first_name: id.replace("c-", "").replace(/^\w/, (m) => m.toUpperCase()), last_name: "Test",
    phone: `+1705555${String(1000 + Math.abs([...id].reduce((a, ch) => a * 31 + ch.charCodeAt(0), 7)) % 9000)}`,
    email: null, sms_opt_out_at: null, email_opt_out_at: null, sms_consent_at: null, consent_source: null, metadata: {}, ...over,
  };
}

function completed(contactId: string, days: number, over: Row = {}): Row {
  return { id: `b-${contactId}-${days}`, organization_id: ORG, company_id: CO, contact_id: contactId, status: "completed", completed_at: daysAgo(days), scheduled_for: daysAgo(days), created_at: daysAgo(days + 5), title: "Roof repair", ...over };
}

function seed(extra: Record<string, Row[]> = {}): FakeDb {
  return createFakeDb(
    {
      organizations: [
        { id: ORG, platform_brand: "crankleads", slug: "northshore", plan: "catch" },
        { id: HOUSE_ORG, platform_brand: "empirevu", slug: "a1-group", plan: "internal" },
      ],
      companies: [
        {
          id: CO, organization_id: ORG, name: "Northshore Roofing", brand_from_name: null, timezone: "America/Toronto", stage: "active", ai_settings: {},
          owner_phone_e164: OWNER, owner_phone_verified_at: "2026-10-01T00:00:00Z", google_place_id: "ChIJnorthshore123", google_rating: 4.6, google_review_count: 40,
          industry_pack: null, service_area: "Midland", online_booking_settings: { enabled: false }, quote_public_base_url: null,
        },
        {
          id: HOUSE_CO, organization_id: HOUSE_ORG, name: "A1 Marine Care", brand_from_name: null, timezone: "America/Toronto", stage: "active", ai_settings: {},
          owner_phone_e164: "+17055550999", owner_phone_verified_at: "2026-10-01T00:00:00Z", google_place_id: "ChIJa1marine12345", google_rating: 4.9, google_review_count: 100,
          industry_pack: null, service_area: null, online_booking_settings: null, quote_public_base_url: null,
        },
      ],
      contacts: [
        contact("c-old"),
        contact("c-paid", { sms_consent_at: daysAgo(600), consent_source: "inbound_sms" }),
        contact("c-recent"),
        contact("c-ancient"),
        contact("c-optout", { sms_opt_out_at: daysAgo(10) }),
        contact("c-openbook"),
        contact("c-quote"),
        contact("c-campaigned"),
        contact("c-nophone", { phone: null }),
        { ...contact("c-house"), organization_id: HOUSE_ORG, company_id: HOUSE_CO },
      ],
      bookings: [
        completed("c-old", 365),
        completed("c-recent", 90),
        completed("c-ancient", 900),
        completed("c-optout", 365),
        completed("c-openbook", 365),
        { id: "b-open", organization_id: ORG, company_id: CO, contact_id: "c-openbook", status: "confirmed", scheduled_for: daysAgo(-5), created_at: daysAgo(2) },
        completed("c-quote", 365),
        completed("c-campaigned", 365),
        completed("c-nophone", 365),
        { ...completed("c-house", 365), organization_id: HOUSE_ORG, company_id: HOUSE_CO },
      ],
      invoices: [{ id: "inv-1", organization_id: ORG, company_id: CO, contact_id: "c-paid", status: "paid", paid_at: daysAgo(540) }],
      quotes: [{ id: "q-1", organization_id: ORG, company_id: CO, contact_id: "c-quote", status: "sent", created_at: daysAgo(10) }],
      marketing_campaigns: [{ id: "camp-old", organization_id: ORG, company_id: CO, kind: "win_back", status: "done", created_at: daysAgo(40), period_key: "2026-09", audience_count: 1 }],
      marketing_campaign_recipients: [
        { id: "r-old", organization_id: ORG, company_id: CO, campaign_id: "camp-old", contact_id: "c-campaigned", status: "sent", sent_at: daysAgo(30), created_at: daysAgo(31) },
      ],
      voice_numbers: [{ organization_id: ORG, company_id: CO, provider: "twilio", active: true, phone_e164: "+17055550111", mode: "missed_call_catcher" }],
      service_catalog_items: [{ id: "s-1", organization_id: ORG, company_id: CO, label: "Roof inspection", active: true, sort_order: 1 }],
      owner_approvals: [],
      message_log: [],
      google_reviews: [],
      google_post_drafts: [],
      marketing_sweep_claims: [],
      platform_sms_opt_outs: [],
      ...extra,
    },
    {
      owner_approvals: [["company_id", "short_code"]],
      marketing_campaign_recipients: [["campaign_id", "contact_id"]],
      google_reviews: [["company_id", "review_name"]],
      google_post_drafts: [["company_id", "week_start"]],
      marketing_sweep_claims: [["company_id", "task", "period_key"]],
    },
  );
}

const WIN_BACK_TEXT = "it's Northshore Roofing. Fall is a good time to have the roof looked at before the snow - reply here and we'll book you in.";
const REVIEW_REPLY = "Thanks so much, Sam - glad the new shingles are holding up. We appreciate you choosing us! - Northshore Roofing";
const model = vi.fn<MarketerModel>(async ({ system }) => {
  if (system.includes("Google review")) return REVIEW_REPLY;
  if (system.includes("Google Business Profile post")) return "Fall is here - a quick roof check now can save a big repair after the first snow. Questions? Northshore Roofing is happy to help.";
  return WIN_BACK_TEXT;
});

let db: FakeDb;
let clock = NOW;
const notified: string[] = [];
function deps(over: Partial<MarketerDeps> = {}): MarketerDeps {
  return withDeps({ model, notify: async (_a, id) => (notified.push(id), { notified: true }), now: () => clock, fetchReviews: async () => null, ...over });
}
const tableRows = (t: string) => (db.tables[t] ?? []) as Row[];
const textsTo = (phone: string) => sendSms.mock.calls.map((c) => c[0] as { to: string; body: string }).filter((m) => m.to === phone);
const customerTexts = () => sendSms.mock.calls.map((c) => c[0] as { to: string; body: string }).filter((m) => m.to !== OWNER);

beforeEach(() => {
  clock = NOW;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  sendSms.mockClear();
  model.mockClear();
  notified.length = 0;
  db = seed();
});
afterEach(() => {
  vi.useRealTimers();
});

async function company(id = CO, org = ORG) {
  const c = await loadMarketingCompany(db.client, { organizationId: org, companyId: id });
  if (!c) throw new Error("no company");
  return c;
}

describe("settings", () => {
  it("defaults: everything on for CrankLeads, off for house orgs (A1) unless explicitly on", () => {
    const cl = readMarketingSettings({}, { crankleads: true });
    expect(cl.winBack).toMatchObject({ enabled: true, monthsMin: 9, monthsMax: 24, weeklyCap: 150, perHour: 30, startHour: 10, endHour: 19, days: [1, 2, 3, 4, 5, 6] });
    expect(cl.reviewReplies.enabled).toBe(true);
    expect(cl.googlePosts.enabled).toBe(true);
    const house = readMarketingSettings({}, { crankleads: false });
    expect([house.winBack.enabled, house.reviewReplies.enabled, house.googlePosts.enabled]).toEqual([false, false, false]);
    expect(readMarketingSettings({ marketing: { review_replies: { enabled: true } } }, { crankleads: false }).reviewReplies.enabled).toBe(true);
  });

  it("clamps the window to CASL's 2 years and the send hours to 09:00-20:00; merge touches only marketing", () => {
    const s = readMarketingSettings({ marketing: { win_back: { months_min: 30, months_max: 40, start_hour: 6, end_hour: 23 } } }, { crankleads: true });
    expect(s.winBack.monthsMax).toBe(24);
    expect(s.winBack.monthsMin).toBe(23);
    expect(s.winBack.startHour).toBe(9);
    expect(s.winBack.endHour).toBe(20);
    const merged = mergeMarketingSettings({ sms_agent: { enabled: true }, marketing: { google_posts: { enabled: true } } }, { winBack: { enabled: false, monthsMin: 12 } });
    expect(merged).toEqual({ sms_agent: { enabled: true }, marketing: { google_posts: { enabled: true }, win_back: { enabled: false, months_min: 12 } } });
  });

  it("the house org isn't in the sweeps unless it turns something on", async () => {
    expect((await listMarketingCompanies(db.client)).map((c) => c.companyId)).toEqual([CO]);
  });
});

describe("audience", () => {
  it("past customers 9-24 months ago, minus opted-out, no phone, recently campaigned, open booking or quote", async () => {
    const out = await buildWinBackAudience(db.client, { organizationId: ORG, companyId: CO }, { monthsMin: 9, monthsMax: 24 }, NOW);
    expect(out.members.map((m) => m.contactId).sort()).toEqual(["c-old", "c-paid"]);
    expect(out.excluded).toEqual({ opted_out: 1, no_phone: 1, recent_campaign: 1, open_booking: 1, open_quote: 1 });
    // c-paid's inquiry consent is 600 days old — only the purchase (2 years) lets us text them.
    expect(out.members.find((m) => m.contactId === "c-paid")?.lastPurchaseAt).toBe(daysAgo(540));
  });

  it("every read is scoped to the org and company", async () => {
    await buildWinBackAudience(db.client, { organizationId: ORG, companyId: CO }, { monthsMin: 9, monthsMax: 24 }, NOW);
    for (const q of db.queries.filter((q) => ["bookings", "invoices", "contacts", "quotes", "marketing_campaign_recipients"].includes(q.table))) {
      const cols = q.filters.map((f) => `${f.column}=${String(f.value)}`);
      expect(cols).toContain(`organization_id=${ORG}`);
      expect(cols).toContain(`company_id=${CO}`);
    }
  });
});

describe("drafting a campaign", () => {
  it("snapshots the audience, writes a text that names the business and ends with STOP, and asks the owner with the exact text", async () => {
    const out = await draftWinBackCampaign(db.client, deps(), await company(), { createdBy: "marketer", periodKey: "2026-10" });
    expect(out.status).toBe("created");
    const campaign = tableRows("marketing_campaigns").find((c) => c.period_key === "2026-10") as Row;
    expect(campaign).toMatchObject({ status: "awaiting_owner", audience_count: 2 });
    expect(campaign.message).toBe(`Hi [first name], ${WIN_BACK_TEXT}\nReply STOP to opt out`);
    expect(tableRows("marketing_campaign_recipients").filter((r) => r.campaign_id === campaign.id).map((r) => r.status)).toEqual(["queued", "queued"]);
    const approval = tableRows("owner_approvals")[0];
    expect(approval).toMatchObject({ kind: "marketing_campaign", status: "pending", requested_by: "marketer" });
    expect(approval.summary).toContain("Win-back text to 2 past customers (last job 9-24 months ago)");
    expect(approval.summary).toContain(`"Hi [first name], ${WIN_BACK_TEXT} Reply STOP to opt out"`);
    expect(approval.summary).toContain("Sends Mon-Sat 10am-7pm, up to 30/hour.");
    expect(String(approval.summary).length).toBeLessThanOrEqual(500);
    expect(notified).toEqual([approval.id]);
    expect(customerTexts()).toHaveLength(0);
  });

  it("a draft that mentions a discount or urgency is replaced by the plain fallback", async () => {
    model.mockImplementationOnce(async () => "it's Northshore Roofing! 20% off this week only - hurry!");
    await draftWinBackCampaign(db.client, deps(), await company(), { createdBy: "marketer", periodKey: null });
    const campaign = tableRows("marketing_campaigns").find((c) => c.status === "awaiting_owner") as Row;
    expect(String(campaign.message)).toContain(fallbackWinBackBody({ businessName: "Northshore Roofing", trade: null, serviceArea: null, services: [], bookingUrl: null, website: null }, 10));
    expect(marketingCopyProblems(String(campaign.message))).toEqual([]);
    expect(marketingCopyProblems("Save 20% today only")).toEqual(["mentions money or a deal", "fake urgency"]);
  });

  it("no audience → nothing asked; one active campaign at a time; the monthly sweep runs once per month", async () => {
    const busyDeps = deps();
    const first = await sweepMonthlyWinBack(db.client, busyDeps);
    expect(first.drafted).toBe(1);
    const again = await sweepMonthlyWinBack(db.client, busyDeps);
    expect(again.drafted).toBe(0);
    expect(tableRows("owner_approvals")).toHaveLength(1);
    const busy = await draftWinBackCampaign(db.client, busyDeps, await company(), { createdBy: "owner", periodKey: null });
    expect(busy.status).toBe("busy");
  });

  it("the house org (A1) gets no automatic campaign by default", async () => {
    await sweepMonthlyWinBack(db.client, deps());
    expect(tableRows("marketing_campaigns").filter((c) => c.company_id === HOUSE_CO)).toHaveLength(0);
    const a1 = await company(HOUSE_CO, HOUSE_ORG);
    expect((await draftWinBackCampaign(db.client, deps(), a1, { createdBy: "marketer", periodKey: "2026-10" })).status).toBe("disabled");
  });

  it("personalises per recipient and falls back to 'there'", () => {
    const t = composeCampaignTemplate("it's Northshore Roofing.", "https://app.crankleads.com/book/co-1");
    expect(personalise(t, "Jamie")).toBe("Hi Jamie, it's Northshore Roofing. Book online: https://app.crankleads.com/book/co-1\nReply STOP to opt out");
    expect(personalise(t, "+17055550123")).toMatch(/^Hi there,/);
  });
});

describe("the owner's Y → throttled sending (through owner-channel decideApproval)", () => {
  async function approvedCampaign(extraContacts = 0) {
    for (let i = 0; i < extraContacts; i++) {
      (db.tables.contacts as Row[]).push(contact(`c-extra${i}`, { phone: `+1705556${String(1000 + i)}` }));
      (db.tables.bookings as Row[]).push(completed(`c-extra${i}`, 300 + i));
    }
    const out = await draftWinBackCampaign(db.client, deps(), await company(), { createdBy: "marketer", periodKey: "2026-10" });
    if (out.status !== "created") throw new Error(out.status);
    const decided = await decideApproval(db.client, out.approvalId, { approved: true, decidedVia: "sms", decidedBy: OWNER }, { nowMs: NOW });
    return { out, decided, campaign: tableRows("marketing_campaigns").find((c) => c.id === out.campaignId) as Row };
  }

  it("Y → sending; the owner hears what will happen; the approval is recorded as executed", async () => {
    const { decided, campaign } = await approvedCampaign();
    expect(decided.outcome).toBe("done");
    expect(decided.message).toBe("Approved - texting 2 past customers Mon-Sat 10am-7pm, up to 30/hour. Replies go to your assistant.");
    expect(campaign.status).toBe("sending");
    expect(tableRows("owner_approvals")[0]).toMatchObject({ status: "executed", result: expect.objectContaining({ ok: true }) });
    // A second Y is "already", nothing re-runs.
    const again = await decideApproval(db.client, String(tableRows("owner_approvals")[0].id), { approved: true, decidedVia: "app", decidedBy: "p-1" }, { nowMs: NOW });
    expect(again.outcome).toBe("already");
  });

  it("sends from the company number with the business name + STOP line, once per recipient, then finishes", async () => {
    const { campaign } = await approvedCampaign();
    const d = deps();
    const first = await sendCampaignBatches(db.client, d);
    expect(first).toEqual({ sent: 2, skipped: 0, failed: 0 });
    const texts = customerTexts();
    expect(texts).toHaveLength(2);
    for (const t of texts) {
      expect(t.body).toMatch(/^Hi (Old|Paid), it's Northshore Roofing\./);
      expect(t.body.endsWith("Reply STOP to opt out")).toBe(true);
      expect(t.body.match(/Reply STOP/g)).toHaveLength(1);
    }
    expect((sendSms.mock.calls[0][0] as { from?: string }).from).toBe("+17055550111");
    expect(tableRows("marketing_campaigns").find((c) => c.id === campaign.id)).toMatchObject({ status: "done", sent_count: 2 });
    expect(tableRows("message_log").filter((m) => m.sent_by === "marketer" && m.status === "sent")).toHaveLength(2);
    // Re-running (another worker / next tick) never texts anyone twice.
    expect(await sendCampaignBatches(db.client, d)).toEqual({ sent: 0, skipped: 0, failed: 0 });
    expect(customerTexts()).toHaveLength(2);
  });

  it("two workers racing the same tick: each recipient is claimed once", async () => {
    await approvedCampaign(4);
    const d = deps();
    const [a, b] = await Promise.all([sendCampaignBatches(db.client, d), sendCampaignBatches(db.client, d)]);
    expect(a.sent + b.sent).toBe(customerTexts().length);
    const phones = customerTexts().map((t) => t.to);
    expect(new Set(phones).size).toBe(phones.length);
  });

  it("throttled: ~1/6 of the hourly rate per tick, the hourly cap, and the weekly cap", async () => {
    await approvedCampaign(40); // 42 recipients
    const d = deps();
    expect((await sendCampaignBatches(db.client, d)).sent).toBe(5); // ceil(30/6)
    for (let i = 0; i < 10; i++) {
      clock += 5 * 60_000;
      vi.setSystemTime(clock);
      await sendCampaignBatches(db.client, d);
    }
    // Within the first hour: never more than 30.
    expect(customerTexts().length).toBe(30);
    // Weekly cap 31 → only one more ever goes out this week.
    db.tables.companies[0].ai_settings = { marketing: { win_back: { weekly_cap: 31 } } };
    const campaign = tableRows("marketing_campaigns").find((c) => c.status === "sending") as Row;
    campaign.send_window = { ...(campaign.send_window as Row), weeklyCap: 31 };
    clock += 2 * 3_600_000;
    vi.setSystemTime(clock);
    await sendCampaignBatches(db.client, d);
    clock += 3_600_000;
    vi.setSystemTime(clock);
    await sendCampaignBatches(db.client, d);
    expect(customerTexts().length).toBe(31);
  });

  it("quiet window: nothing before 10am, after 7pm or on Sunday (local)", async () => {
    await approvedCampaign();
    for (const at of ["2026-10-13T13:30:00Z" /* 9:30 */, "2026-10-13T23:30:00Z" /* 19:30 */, "2026-10-18T16:00:00Z" /* Sun 12:00 */]) {
      clock = Date.parse(at);
      vi.setSystemTime(clock);
      expect((await sendCampaignBatches(db.client, deps())).sent).toBe(0);
    }
    expect(customerTexts()).toHaveLength(0);
  });

  it("re-checks at send time: an opt-out or a new booking since the draft → skipped, never texted", async () => {
    await approvedCampaign();
    (db.tables.contacts as Row[]).find((c) => c.id === "c-old")!.sms_opt_out_at = daysAgo(0);
    (db.tables.bookings as Row[]).push({ id: "b-new", organization_id: ORG, company_id: CO, contact_id: "c-paid", status: "pending", scheduled_for: daysAgo(-3), created_at: daysAgo(0) });
    expect(await sendCampaignBatches(db.client, deps())).toEqual({ sent: 0, skipped: 2, failed: 0 });
    expect(customerTexts()).toHaveLength(0);
    const reasons = tableRows("marketing_campaign_recipients").filter((r) => r.campaign_id !== "camp-old").map((r) => r.reason).sort();
    expect(reasons).toEqual(["open_booking", "opted_out"]);
  });

  it("turning win-back off mid-campaign holds the sends", async () => {
    await approvedCampaign();
    db.tables.companies[0].ai_settings = { marketing: { win_back: { enabled: false } } };
    expect((await sendCampaignBatches(db.client, deps())).sent).toBe(0);
  });

  it("a claim left by a crashed worker is failed, never re-sent", async () => {
    const { campaign } = await approvedCampaign();
    const r = tableRows("marketing_campaign_recipients").find((x) => x.campaign_id === campaign.id) as Row;
    Object.assign(r, { status: "sending", claimed_at: daysAgo(1) });
    await sendCampaignBatches(db.client, deps());
    expect(r.status).toBe("failed");
    expect(customerTexts()).toHaveLength(1);
  });

  it("results: sends, replies and bookings / quotes within 30 days", async () => {
    const { campaign } = await approvedCampaign();
    await sendCampaignBatches(db.client, deps());
    (db.tables.message_log as Row[]).push({ id: "in-1", organization_id: ORG, company_id: CO, contact_id: "c-old", direction: "inbound", channel: "sms", created_at: new Date(NOW + 3_600_000).toISOString() });
    (db.tables.bookings as Row[]).push({ id: "b-won", organization_id: ORG, company_id: CO, contact_id: "c-old", status: "confirmed", created_at: new Date(NOW + 2 * DAY).toISOString() });
    (db.tables.quotes as Row[]).push({ id: "q-won", organization_id: ORG, company_id: CO, contact_id: "c-paid", status: "sent", created_at: new Date(NOW + 40 * DAY).toISOString() });
    const results = await campaignResults(db.client, tableRows("marketing_campaigns").find((c) => c.id === campaign.id) as never);
    expect(results).toMatchObject({ sent: 2, replies: 1, bookings: 1, quotes: 0 });
  });
});

describe("the owner's N, expiry and notes", () => {
  async function pending() {
    const out = await draftWinBackCampaign(db.client, deps(), await company(), { createdBy: "marketer", periodKey: "2026-10" });
    if (out.status !== "created") throw new Error(out.status);
    return out;
  }

  it("N → cancelled, queued recipients released (they don't count against the 90-day cooldown)", async () => {
    const out = await pending();
    const decided = await decideApproval(db.client, out.approvalId, { approved: false, decidedVia: "sms", decidedBy: OWNER }, { nowMs: NOW });
    expect(decided.message).toBe("OK - the win-back campaign won't go out.");
    expect(tableRows("marketing_campaigns").find((c) => c.id === out.campaignId)).toMatchObject({ status: "cancelled", cancel_reason: "owner_declined" });
    expect(tableRows("marketing_campaign_recipients").filter((r) => r.campaign_id === out.campaignId).every((r) => r.status === "skipped")).toBe(true);
    expect(await sendCampaignBatches(db.client, deps())).toEqual({ sent: 0, skipped: 0, failed: 0 });
    const next = await buildWinBackAudience(db.client, { organizationId: ORG, companyId: CO }, { monthsMin: 9, monthsMax: 24 }, NOW);
    expect(next.members).toHaveLength(2);
  });

  it("expiry (owner-channel sweep) → cancelled, nothing sent", async () => {
    const out = await pending();
    const row = tableRows("owner_approvals")[0];
    const result = await expireApproval(db.client, row as never, Date.parse(String(row.expires_at)) + 60_000);
    expect(result.outcome).toBe("expired");
    expect(result.result?.message).toBe("The win-back campaign wasn't approved in time, so nothing was sent.");
    expect(tableRows("marketing_campaigns").find((c) => c.id === out.campaignId)).toMatchObject({ status: "cancelled", cancel_reason: "expired" });
    expect(tableRows("owner_approvals")[0].status).toBe("expired");
    expect(customerTexts()).toHaveLength(0);
  });

  it("'Y 1 $700' on a campaign → nothing sent, the same campaign re-asked under a new code", async () => {
    const out = await pending();
    const decided = await decideApproval(db.client, out.approvalId, { approved: true, ownerNote: "$700", decidedVia: "sms", decidedBy: OWNER }, { nowMs: NOW });
    expect(decided.message).toMatch(/^Nothing sent yet - the campaign goes out exactly as shown.*Reply Y 2 to approve it as written, or N 2 to skip\.$/);
    const campaign = tableRows("marketing_campaigns").find((c) => c.id === out.campaignId) as Row;
    expect(campaign.status).toBe("awaiting_owner");
    const fresh = tableRows("owner_approvals").find((a) => a.short_code === 2) as Row;
    expect(campaign.approval_id).toBe(fresh.id);
    expect(fresh.status).toBe("pending");
    // The re-asked one works.
    await decideApproval(db.client, String(fresh.id), { approved: true, decidedVia: "sms", decidedBy: OWNER }, { nowMs: NOW });
    expect(campaign.status).toBe("sending");
  });
});

describe("Google reviews", () => {
  const fetched = (reviews: Partial<FetchedPlaceReviews["reviews"][number]>[]): FetchedPlaceReviews => ({
    rating: 4.5,
    reviewCount: 42,
    mapsUri: "https://maps.google.com/?cid=1",
    reviews: reviews.map((r, i) => ({ name: `places/ChIJnorthshore123/reviews/r${i}`, rating: 5, text: "Great job on the roof", author: "Sam Keller", publishedAt: daysAgo(2), googleMapsUri: `https://maps.google.com/review/r${i}`, ...r })),
  });

  it("maps the Places API (New) body", () => {
    const m = mapPlaceReviews({
      rating: 4.7,
      userRatingCount: 12,
      reviews: [
        { name: "places/ChIJx/reviews/abc", rating: 2, text: { text: "Late" }, originalText: { text: "Late!" }, authorAttribution: { displayName: "Pat L" }, publishTime: "2026-10-10T12:00:00Z", googleMapsUri: "https://maps/r" },
        { name: "bogus", rating: 5 },
      ],
    });
    expect(m).toMatchObject({ rating: 4.7, reviewCount: 12, reviews: [{ name: "places/ChIJx/reviews/abc", rating: 2, text: "Late!", author: "Pat L", googleMapsUri: "https://maps/r" }] });
    expect(m.reviews).toHaveLength(1);
  });

  it("new review → draft + approval; once a day; old reviews recorded without a draft; rating refreshed", async () => {
    const fetchReviews = vi.fn(async () => fetched([{}, { publishedAt: daysAgo(200), name: "places/ChIJnorthshore123/reviews/old" }]));
    const d = deps({ fetchReviews });
    const out = await ingestReviewsForCompany(db.client, d, await company());
    expect(out).toMatchObject({ fetched: 2, drafted: 1 });
    const [fresh, old] = tableRows("google_reviews");
    expect(fresh).toMatchObject({ reply_status: "awaiting_owner", reply_draft: REVIEW_REPLY });
    expect(old).toMatchObject({ reply_status: "skipped" });
    const approval = tableRows("owner_approvals")[0];
    expect(approval.kind).toBe("review_reply");
    expect(approval.summary).toBe(`New 5-star Google review from Sam K.: "Great job on the roof" Reply: "${REVIEW_REPLY}" Y = I text you this reply to paste on Google.`);
    expect(db.tables.companies[0]).toMatchObject({ google_rating: 4.5, google_review_count: 42 });
    // Same day again: claimed, no second API call.
    await sweepGoogleReviews(db.client, d, [await company()]);
    expect(fetchReviews).toHaveBeenCalledTimes(1);
    // Next day: the same reviews are not drafted twice.
    clock += DAY;
    vi.setSystemTime(clock);
    await ingestReviewsForCompany(db.client, d, await company());
    expect(fetchReviews).toHaveBeenCalledTimes(2);
    expect(tableRows("owner_approvals")).toHaveLength(1);
  });

  it("a 2-star review also alerts the owner right away", async () => {
    await ingestReviewsForCompany(db.client, deps({ fetchReviews: async () => fetched([{ rating: 2, text: "They were late and left a mess" }]) }), await company());
    const owner = textsTo(OWNER);
    expect(owner).toHaveLength(1);
    expect(owner[0].body).toMatch(/^CrankLeads: Heads up: a new 2-star Google review for Northshore Roofing from Sam K\. "They were late and left a mess" I've drafted a calm reply for you to OK \(#1\)\.$/);
  });

  it("Y through decideApproval → the owner is texted the reply + link to paste (postReply seam unused)", async () => {
    await ingestReviewsForCompany(db.client, deps({ fetchReviews: async () => fetched([{}]) }), await company());
    const approval = tableRows("owner_approvals")[0];
    const decided = await decideApproval(db.client, String(approval.id), { approved: true, decidedVia: "sms", decidedBy: OWNER }, { nowMs: NOW });
    expect(decided.message).toBe("Approved - I texted you the reply and the link to paste it on Google.");
    const paste = textsTo(OWNER);
    expect(paste).toHaveLength(1);
    expect(paste[0].body).toBe(`CrankLeads: Your reply to Sam K.'s Google review - open https://maps.google.com/review/r0 , tap Reply and paste:\n\n${REVIEW_REPLY}`);
    expect(tableRows("google_reviews")[0]).toMatchObject({ reply_status: "approved" });
    expect(tableRows("google_reviews")[0].owner_texted_at).toBeTruthy();
  });

  it("house org: no review fetch by default", async () => {
    const fetchReviews = vi.fn(async () => fetched([{}]));
    await ingestReviewsForCompany(db.client, deps({ fetchReviews }), await company(HOUSE_CO, HOUSE_ORG));
    expect(fetchReviews).not.toHaveBeenCalled();
  });

  it("review text is dropped after 30 days", async () => {
    (db.tables.google_reviews as Row[]).push({ id: "gr-old", organization_id: ORG, company_id: CO, review_name: "places/x/reviews/y", text: "old words", created_at: daysAgo(45), text_pruned_at: null, reply_status: "approved" });
    await ingestReviewsForCompany(db.client, deps({ fetchReviews: async () => fetched([]) }), await company());
    expect(tableRows("google_reviews")[0]).toMatchObject({ text: null });
  });
});

describe("weekly Google post", () => {
  it("one draft per week (Monday), approval shows the copy; Y texts the owner the copy + link", async () => {
    clock = Date.parse("2026-10-12T14:00:00Z"); // Mon 10:00 local
    vi.setSystemTime(clock);
    const d = deps();
    expect((await sweepGooglePosts(db.client, d, [await company()])).drafted).toBe(1);
    expect((await sweepGooglePosts(db.client, d, [await company()])).drafted).toBe(0);
    expect(await draftWeeklyPost(db.client, d, await company())).toBe("exists");
    const post = tableRows("google_post_drafts")[0];
    expect(post).toMatchObject({ week_start: "2026-10-12", status: "awaiting_owner" });
    const approval = tableRows("owner_approvals")[0];
    expect(approval.kind).toBe("google_post");
    expect(String(approval.summary)).toContain(String(post.body));
    const decided = await decideApproval(db.client, String(approval.id), { approved: true, decidedVia: "sms", decidedBy: OWNER }, { nowMs: clock });
    expect(decided.message).toBe("Approved - I texted you the post and the link to paste it on Google.");
    expect(textsTo(OWNER)[0].body).toContain("https://business.google.com/posts");
    expect(textsTo(OWNER)[0].body).toContain(String(post.body));
  });

  it("not on other days (Wed), not after 5pm, and never for the house org by default", async () => {
    clock = Date.parse("2026-10-14T15:00:00Z"); // Wed 11:00 local
    vi.setSystemTime(clock);
    expect((await sweepGooglePosts(db.client, deps(), [await company()])).drafted).toBe(0);
    clock = Date.parse("2026-10-12T22:00:00Z"); // Mon 18:00 local
    vi.setSystemTime(clock);
    expect((await sweepGooglePosts(db.client, deps(), [await company()])).drafted).toBe(0);
    clock = Date.parse("2026-10-12T14:00:00Z"); // Mon 10:00 local
    vi.setSystemTime(clock);
    expect((await sweepGooglePosts(db.client, deps(), [await company(HOUSE_CO, HOUSE_ORG)])).drafted).toBe(0);
    expect(await draftWeeklyPost(db.client, deps(), await company(HOUSE_CO, HOUSE_ORG))).toBe("skipped");
  });
});

describe("owner tools + registry", () => {
  const state = () => ({ admin: db.client, scope: { organizationId: ORG, companyId: CO, companyName: "Northshore Roofing", timeZone: "America/Toronto" }, ownerPhone: OWNER, nowMs: NOW, confirmation: null, actions: [] });

  it("start_win_back drafts → approval (urgent, so it's texted now); never sends", async () => {
    const out = await startWinBackTool(deps()).run(state() as never, {});
    expect(out).toMatchObject({ ok: true, approval_code: 1, audience_count: 2 });
    expect(tableRows("owner_approvals")[0].payload).toMatchObject({ urgent: true });
    expect(customerTexts()).toHaveLength(0);
    expect(await startWinBackTool(deps()).run(state() as never, {})).toMatchObject({ ok: false, note: expect.stringMatching(/waiting for the owner's OK/) });
  });

  it("start_win_back says so when it's off", async () => {
    db.tables.companies[0].ai_settings = { marketing: { win_back: { enabled: false } } };
    expect(await startWinBackTool(deps()).run(state() as never, {})).toMatchObject({ ok: false, error: expect.stringMatching(/turned off/) });
  });

  it("marketing_results: last campaign + Google", async () => {
    const out = await marketingResultsTool.run(state() as never, {});
    expect(out).toMatchObject({ ok: true, last_campaign: { status: "done" }, google: { rating: 4.6, review_count: 40 } });
  });

  it("registers its kinds, tools and sweeps with no clashes", () => {
    expect(Object.keys(marketerRole.approvalExecutors).sort()).toEqual(["google_post", "marketing_campaign", "review_reply"]);
    expect(roleApprovalExecutor("marketing_campaign")).toBeTypeOf("function");
    expect(roleOwnerTools().map((t) => t.tool.name)).toEqual(expect.arrayContaining(["start_win_back", "marketing_results"]));
    expect(marketerRole.sweeps.map((s) => s.name)).toEqual(["marketer_campaign_sender", "marketer_hourly"]);
    expect(registryProblems(AGENT_TOOLS.map((t) => t.name), OWNER_TOOLS.map((t) => t.name))).toEqual([]);
  });
});
