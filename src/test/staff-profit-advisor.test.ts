/**
 * Profit advisor (docs/ai-staff.md → "Profit advisor"), against the in-memory fake DB with real
 * services underneath (time/service.ts profitReport / jobProfit, insertApproval,
 * notifyOwnerOfApproval, sendOwnerSms → deliverMessage, the owner channel's decideApproval /
 * expireApproval, the registry). Only the outside world is faked: Twilio (sendSms).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "@/test/helpers/fake-supabase";

const sendSms = vi.fn((..._a: unknown[]) => Promise.resolve({ sid: `SM${Math.random().toString(36).slice(2, 8)}` }));
vi.mock("@/server/outbound/sms", () => ({ sendSms: (...a: unknown[]) => sendSms(...a) }));
vi.mock("@/server/outbound/email", () => ({ sendEmail: vi.fn(() => Promise.resolve({ id: "re_1" })) }));
vi.mock("@/server/services/usage", () => ({ recordUsageSafe: vi.fn(), recordAiUsageSafe: vi.fn() }));
vi.mock("@/server/services/push/activity", () => ({ notifyActivityEvent: vi.fn() }));
vi.mock("@/server/services/workflow-engine/dispatch", () => ({ emitActivityEventAndDispatch: vi.fn(() => Promise.resolve({ activityEvent: {}, workflowEventJob: null })) }));

import { replyInstruction } from "@/server/services/front-desk/approval-text";
import { decideApproval, expireApproval } from "@/server/services/owner-channel/approvals";
import { handleOwnerInboundSms } from "@/server/services/owner-channel/entry";
import { runOwnerTool, type ToolRunState } from "@/server/services/owner-channel/tools";
import { activeRolesFor, registryProblems, roleApprovalExecutor, staffRoles } from "@/server/services/staff/registry";
import { profitAdvisorRole, PROFIT_ADVISOR_SWEEPS } from "@/server/services/staff/profit-advisor";
import { briefingItems } from "@/server/services/staff/profit-advisor/briefing-items";
import {
  buildForecast,
  invoiceItems,
  jobItems,
  overheadRate,
  payLags,
  payrollRate,
  poItems,
  quoteItems,
  rentalItems,
  seriesItems,
  type ForecastInputs,
} from "@/server/services/staff/profit-advisor/forecast";
import { loadForecastInputs } from "@/server/services/staff/profit-advisor/forecast-data";
import { firstTuesdayOf, jobName, shortMoney } from "@/server/services/staff/profit-advisor/format";
import { executePriceChange, PRICE_CHANGE_KIND } from "@/server/services/staff/profit-advisor/price-change";
import { attributeJobs, isUnderpriced, itemStats, priceChangeSummary, proposeRaise, tidyPrice, type CatalogForPricing } from "@/server/services/staff/profit-advisor/pricing";
import { quoteLines, runPricingCheck } from "@/server/services/staff/profit-advisor/pricing-check";
import { loadProfitCompanies, loadProfitCompany, mergeProfitAdvisorSettings, profitAdvisorActiveFor, readProfitAdvisorSettings, type ProfitCompany } from "@/server/services/staff/profit-advisor/settings";
import { summarizeJobs, watchReason } from "@/server/services/staff/profit-advisor/summary";
import { claimRun, isoWeekKey, lastWeeklyWindow, pricingDue, runCompanyPricing, runCompanyWeekly, weekWindow } from "@/server/services/staff/profit-advisor/sweeps";
import { forecastLine, tightLine, weeklyText } from "@/server/services/staff/profit-advisor/texts";
import { getProfitAdvisorView } from "@/server/services/staff/profit-advisor/view";
import type { JobProfitRow } from "@/server/services/staff/profit-advisor/jobs";

const TZ = "America/Toronto";
const ORG = "11111111-1111-4111-8111-111111111111";
const CO = "22222222-2222-4222-8222-222222222222";
const HOUSE_ORG = "33333333-3333-4333-8333-333333333333";
const HOUSE_CO = "44444444-4444-4444-8444-444444444444";
const OWNER = "+17055559999";
const PLATFORM = "+16475550000";
const GUTTER = "c0000000-0000-4000-8000-000000000001";
const ROOF = "c0000000-0000-4000-8000-000000000002";
const DAY = 86_400_000;

// Fri Oct 16 2026, 15:05 in Toronto (EDT, UTC-4) — the weekly text's default slot.
const FRIDAY = Date.parse("2026-10-16T19:05:00Z");
// Tue Nov 3 2026 (the first Tuesday of November), 10:00 in Toronto (EST, UTC-5 since Nov 1).
const PRICING_DAY = Date.parse("2026-11-03T15:00:00Z");

let db: FakeDb;
let seq = 0;

function company(over: Record<string, unknown> = {}) {
  return {
    id: CO, organization_id: ORG, name: "Northshore Roofing", brand_from_name: null, timezone: TZ, ai_settings: {}, stage: "active",
    owner_phone_e164: OWNER, owner_phone_verified_at: "2026-10-01T00:00:00Z", owner_email: "dana@northshore.test",
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
    ...over,
  };
}

interface JobSpec {
  at: string;
  title: string;
  contact: string;
  /** Quote lines: [service key | null (custom), amount cents]. */
  lines: Array<[string | null, number]>;
  labourMin: number;
  expensePreTax?: number;
  duration?: number;
  crew?: string;
  imported?: boolean;
}

/** One finished job: its quote (approved, completed), booking, a crew clock-in and a receipt. */
function addJob(t: Record<string, Array<Record<string, unknown>>>, spec: JobSpec): string {
  const n = ++seq;
  const qid = `q-${n}`;
  const bid = `b-${n}`;
  const subtotal = spec.lines.reduce((s, l) => s + l[1], 0);
  const approvedAt = new Date(Date.parse(spec.at) - 5 * DAY).toISOString();
  if (!spec.imported) t.quotes.push({
    id: qid, organization_id: ORG, company_id: CO, title: spec.title, contact_id: spec.contact, status: "completed",
    sent_at: new Date(Date.parse(spec.at) - 7 * DAY).toISOString(), approved_at: approvedAt, superseded_by: null,
    subtotal_cents: subtotal, approved_subtotal_cents: subtotal, total_cents: Math.round(subtotal * 1.13), approved_total_cents: Math.round(subtotal * 1.13),
    line_items: spec.lines.map(([key, amount]) => ({ serviceId: key ?? "custom", label: key ?? "Custom", amountCents: amount, selected: true, custom: key === null })),
    approved_line_items: null, input_snapshot: { services: spec.lines.filter((l) => l[0]).map((l) => ({ serviceId: l[0] })) },
  });
  t.bookings.push({
    id: bid, organization_id: ORG, company_id: CO, title: spec.title, contact_id: spec.contact, status: "completed", scheduled_for: spec.at,
    quote_id: spec.imported ? null : qid, duration_minutes: spec.duration ?? 240, recurring_job_id: null, service_item_id: spec.imported ? GUTTER : null, price_cents: spec.imported ? subtotal : null,
    source_call_id: spec.imported ? `import:${n}` : null,
  });
  const crew = spec.crew ?? "p-mike";
  t.booking_assignments.push({ id: `ba-${n}`, organization_id: ORG, booking_id: bid, profile_id: crew });
  const start = Date.parse(spec.at);
  t.time_entries.push({ id: `te-${n}`, organization_id: ORG, company_id: CO, booking_id: bid, profile_id: crew, started_at: new Date(start).toISOString(), ended_at: new Date(start + spec.labourMin * 60_000).toISOString(), break_minutes: 0 });
  if (spec.expensePreTax) {
    t.expenses.push({ id: `e-${n}`, organization_id: ORG, company_id: CO, booking_id: bid, spent_on: spec.at.slice(0, 10), category: "materials", amount_cents: Math.round(spec.expensePreTax * 1.13), tax_cents: Math.round(spec.expensePreTax * 1.13) - spec.expensePreTax });
  }
  return bid;
}

let tablesRef: Record<string, Array<Record<string, unknown>>> = {};
const SPEC_DEFAULTS = { contact: "ct-lee", title: "Gutter cleaning" };

function seed(): FakeDb {
  seq = 0;
  const t: Record<string, Array<Record<string, unknown>>> = {
    organizations: [
      { id: ORG, platform_brand: "crankleads", name: "Northshore" },
      { id: HOUSE_ORG, platform_brand: "empirevu", name: "A1 Group" },
    ],
    companies: [company(), company({ id: HOUSE_CO, organization_id: HOUSE_ORG, name: "A1 Marine Care", owner_phone_e164: "+17055558888" })],
    organization_memberships: [{ organization_id: ORG, profile_id: "p-owner", role: "owner" }],
    profiles: [
      { id: "p-owner", full_name: "Dana Whitfield", email: "dana@northshore.test" },
      { id: "p-mike", full_name: "Mike Crew", email: "mike@northshore.test" },
      { id: "p-sam", full_name: "Sam Helper", email: "sam@northshore.test" },
    ],
    member_pay_rates: [{ organization_id: ORG, profile_id: "p-mike", hourly_cost_cents: 4000 }],
    contacts: [
      { id: "ct-jones", organization_id: ORG, company_id: CO, first_name: "Sam", last_name: "Jones" },
      { id: "ct-smith", organization_id: ORG, company_id: CO, first_name: "Pat", last_name: "Smith" },
      { id: "ct-lee", organization_id: ORG, company_id: CO, first_name: "Jo", last_name: "Lee" },
    ],
    service_catalog_items: [
      { id: GUTTER, organization_id: ORG, company_id: CO, service_key: "gutter_clean", label: "Gutter cleaning", pricing_type: "flat", rate_cents: 18_900, minimum_cents: 0, unit_label: null, active: true, sort_order: 1 },
      { id: ROOF, organization_id: ORG, company_id: CO, service_key: "roof_repair", label: "Roof repair", pricing_type: "flat", rate_cents: 150_000, minimum_cents: 0, unit_label: null, active: true, sort_order: 2 },
    ],
    quotes: [],
    bookings: [],
    booking_assignments: [],
    time_entries: [],
    job_materials: [],
    expenses: [],
    invoices: [
      { id: "inv-7", organization_id: ORG, company_id: CO, contact_id: "ct-jones", invoice_number: "INV-7", status: "sent", balance_due_cents: 2_000_000, total_cents: 2_000_000, due_date: "2026-10-20", issue_date: "2026-10-06" },
    ],
    invoice_payments: [],
    recurring_jobs: [],
    purchase_orders: [],
    service_agreements: [],
    price_changes: [],
    price_watch: [],
    profit_advisor_runs: [],
    owner_approvals: [],
    owner_command_log: [],
    message_log: [],
    platform_sms_opt_outs: [],
    activity_events: [],
  };
  // Six months of gutter cleaning (thin margin) and roof repairs (healthy), Aug 2026.
  for (let i = 0; i < 6; i++) {
    addJob(t, { at: `2026-08-0${i + 3}T13:00:00.000Z`, title: "Gutter cleaning", contact: "ct-lee", lines: [["gutter_clean", 18_900]], labourMin: 150, expensePreTax: 6_600 });
    addJob(t, { at: `2026-08-1${i}T13:00:00.000Z`, title: "Roof repair", contact: "ct-jones", lines: [["roof_repair", 150_000]], labourMin: 600, expensePreTax: 35_000, duration: 600 });
  }
  // One gutter quote that was turned down (expired).
  t.quotes.push({ id: "q-lost", organization_id: ORG, company_id: CO, title: "Gutter cleaning", status: "expired", sent_at: "2026-08-20T13:00:00.000Z", approved_at: null, superseded_by: null, line_items: [{ serviceId: "gutter_clean", amountCents: 18_900, selected: true }], approved_line_items: null, input_snapshot: {} });
  // This week (Oct 13–15): a good roof job, a deck that lost money (labour way over), a gutter clean.
  addJob(t, { at: "2026-10-13T12:00:00.000Z", title: "Roof repair", contact: "ct-jones", lines: [["roof_repair", 150_000]], labourMin: 480, duration: 480 });
  addJob(t, { at: "2026-10-14T12:00:00.000Z", title: "Deck", contact: "ct-smith", lines: [[null, 80_000]], labourMin: 1_200, expensePreTax: 18_000, duration: 480 });
  addJob(t, { at: "2026-10-15T12:00:00.000Z", title: "Gutter cleaning", contact: "ct-lee", lines: [["gutter_clean", 18_900]], labourMin: 120 });
  // An imported past job (customer import) — history, never counted.
  addJob(t, { at: "2026-10-12T12:00:00.000Z", title: "Old job", contact: "ct-lee", lines: [["gutter_clean", 500_000]], labourMin: 0, imported: true });
  // A1's own completed job: must never be read for anything.
  t.bookings.push({ id: "b-a1", organization_id: HOUSE_ORG, company_id: HOUSE_CO, title: "Winterize", contact_id: null, status: "completed", scheduled_for: "2026-10-14T12:00:00.000Z", quote_id: null, duration_minutes: 120 });
  tablesRef = t;
  return createFakeDb(t, {
    owner_approvals: [["company_id", "short_code"]],
    profit_advisor_runs: [["company_id", "kind", "run_key"]],
    price_changes: [["approval_id"]],
  });
}

const rows = (t: string) => (db.tables[t] ?? []) as Array<Record<string, unknown>>;
const texts = () => sendSms.mock.calls.map((c) => c[0] as { to: string; body: string });

async function crank(): Promise<ProfitCompany> {
  return (await loadProfitCompany(db.client, ORG, CO)) as ProfitCompany;
}

function ownerState(nowMs: number): ToolRunState {
  return { admin: db.client, scope: { organizationId: ORG, companyId: CO, companyName: "Northshore Roofing", timeZone: TZ }, ownerPhone: OWNER, nowMs, confirmation: null, actions: [] };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FRIDAY);
  sendSms.mockClear();
  process.env.TWILIO_FROM_NUMBER = PLATFORM;
  delete process.env.PLATFORM_SMS_NUMBER;
  delete process.env.ANTHROPIC_API_KEY;
  db = seed();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── Pure: the forecast ─────────────────────────────────────────────────────────────

const TODAY = "2026-10-16";

function inputs(over: Partial<ForecastInputs> = {}): ForecastInputs {
  return { today: TODAY, openInvoices: [], paidHistory: [], quotes: [], jobs: [], series: [], renewals: [], expenses: [], labour: [], averageJobCents: null, hst: [], pos: [], rentals: [], notes: [], ...over };
}

describe("forecast maths", () => {
  it("pay lags: each customer's median lateness, else the company's, else 7 days", () => {
    const lags = payLags([
      { contactId: "a", dueDate: "2026-09-01", issueDate: "2026-08-18", paidDate: "2026-09-11" }, // 10 late
      { contactId: "a", dueDate: "2026-09-10", issueDate: "2026-08-27", paidDate: "2026-09-30" }, // 20 late
      { contactId: "b", dueDate: "2026-09-10", issueDate: "2026-08-27", paidDate: "2026-09-08" }, // 2 early
    ]);
    expect(lags.byContact.get("a")).toBe(15);
    expect(lags.byContact.get("b")).toBe(-2);
    expect(lags.companyDueLag).toBe(10);
    expect(lags.payAfterJob).toBe(24);
    expect(payLags([])).toMatchObject({ companyDueLag: 7, payAfterJob: 14 });
  });

  it("open invoices: due + lateness; already later than usual → a week (likely) / a month (low); 90+ days late → half / none", () => {
    const lags = payLags([{ contactId: "a", dueDate: "2026-09-01", issueDate: null, paidDate: "2026-09-11" }]);
    const items = invoiceItems(
      [
        { id: "1", label: "INV-1 Jones", contactId: "a", balanceCents: 100_000, dueDate: "2026-10-20", issueDate: null },
        { id: "2", label: "INV-2 Lee", contactId: "x", balanceCents: 50_000, dueDate: "2026-09-01", issueDate: null },
        { id: "3", label: "INV-3 Old", contactId: null, balanceCents: 40_000, dueDate: "2026-06-01", issueDate: null },
      ],
      lags,
      TODAY,
    );
    expect(items[0]).toMatchObject({ date: "2026-10-30", likelyCents: 100_000, lowDate: "2026-11-13", lowCents: 100_000 });
    expect(items[1]).toMatchObject({ date: "2026-10-23", lowDate: "2026-11-15", likelyCents: 50_000 });
    expect(items[2]).toMatchObject({ likelyCents: 20_000, lowCents: 0 });
  });

  it("quotes, jobs, series, renewals", () => {
    const lags = payLags([]);
    expect(quoteItems([{ id: "q", label: "Jones roof", depositDueCents: 25_000, balanceCents: 75_000, jobDate: "2026-10-20" }], lags, TODAY)).toEqual([
      { kind: "deposit", label: "Jones roof deposit", date: "2026-10-23", likelyCents: 25_000, lowDate: "2026-11-06", lowCents: 12_500 },
      { kind: "quote_balance", label: "Jones roof", date: "2026-11-03", likelyCents: 75_000, lowDate: "2026-11-17", lowCents: 56_250 },
    ]);
    const jobs = jobItems(
      [
        { id: "1", label: "Lee gutters", date: "2026-10-18", expectedCents: 10_000 },
        { id: "2", label: "Smith", date: "2026-10-19", expectedCents: null },
        { id: "3", label: "Plan visit", date: "2026-10-19", expectedCents: 0 },
      ],
      lags,
      50_000,
      TODAY,
    );
    expect(jobs.map((j) => [j.label, j.date, j.likelyCents, j.lowCents])).toEqual([
      ["Lee gutters", "2026-11-01", 9_000, 7_000],
      ["Smith (no price)", "2026-11-02", 25_000, 0],
    ]);
    expect(seriesItems([{ id: "s", label: "Lawn", visitCents: 10_000, dates: ["2026-10-10", "2026-12-20"] }], lags, TODAY).map((i) => i.date)).toEqual(["2027-01-03"]);
  });

  it("overhead: a daily rate from 90 days, one-offs over $2,500 left out; payroll at the average rate for crew without one", () => {
    const o = overheadRate([
      { spentOn: "2026-09-01", category: "fuel", amountCents: 45_000 },
      { spentOn: "2026-09-02", category: "materials", amountCents: 90_000 },
      { spentOn: "2026-09-03", category: "equipment", amountCents: 900_000 },
    ]);
    expect(o.dailyCents).toBe(1_500);
    expect(o.materialsDailyCents).toBe(1_000);
    expect(o.oneOffCount).toBe(1);
    expect(o.byCategory[0]).toEqual({ category: "materials", monthlyCents: 30_000 });
    const p = payrollRate([
      { profileId: "a", minutes: 6_000, rateCents: 3_000 },
      { profileId: "b", minutes: 6_000, rateCents: null },
    ]);
    expect(p.missingRate).toBe(1);
    expect(p.dailyCents).toBeCloseTo((2 * 6_000 * 3_000) / 60 / 28, 6);
  });

  it("open POs: the low case pays them in full; the likely case only what's beyond the usual materials spend", () => {
    const items = poItems([{ label: "PO-1", neededBy: "2026-10-25", cents: 200_000 }], 1_000, TODAY);
    // 10 days × $10/day = $100 already in the overhead rate → $1,900 extra.
    expect(items[0]).toMatchObject({ date: "2026-10-25", likelyCents: 190_000, lowCents: 200_000 });
    expect(rentalItems([{ label: "Mini-ex", from: "2026-10-10", to: "2026-10-20", dailyCents: 38_000 }], TODAY)[0]).toMatchObject({ date: "2026-10-20", likelyCents: 5 * 38_000 });
  });

  it("windows and 'tight': relative from $0 today; the deepest dip and how far below −cushion", () => {
    const f = buildForecast(
      inputs({
        labour: [{ profileId: "a", minutes: 28 * 60, rateCents: 10_000 }], // $100/day
        openInvoices: [{ id: "1", label: "INV-1", contactId: null, balanceCents: 200_000, dueDate: "2026-11-01", issueDate: null }],
      }),
    );
    // Paid Nov 8 (due + 7): the day before, 23 days × $100 have gone out.
    expect(f.windows[0]).toMatchObject({ days: 30, inLikelyCents: 200_000, outLikelyCents: 300_000, netLikelyCents: -100_000 });
    expect(f.tight30).toEqual({ tight: true, date: "2026-11-07", shortCents: 230_000, lowestCents: -230_000 });
    // The lowest point in 90 days: the end.
    expect(f.tight90).toMatchObject({ tight: true, date: "2027-01-13", shortCents: 700_000 });
    // A $10,000 cushion: still tight at the end of 90 days, not in 30.
    const cushion = buildForecast(inputs({ labour: [{ profileId: "a", minutes: 28 * 60, rateCents: 10_000 }], openInvoices: [{ id: "1", label: "INV-1", contactId: null, balanceCents: 200_000, dueDate: "2026-11-01", issueDate: null }] }), { cushionCents: 1_000_000 });
    expect(cushion.tight30.tight).toBe(false);
    expect(cushion.lowCase.tight).toBe(false);
    expect(buildForecast(inputs()).tight90).toEqual({ tight: false, date: null, shortCents: 0, lowestCents: 0 });
  });

  it("the low case: later, smaller money in and 10% more out", () => {
    const f = buildForecast(inputs({ labour: [{ profileId: "a", minutes: 28 * 60, rateCents: 10_000 }], jobs: [{ id: "1", label: "Lee", date: "2026-10-17", expectedCents: 400_000 }] }));
    expect(f.windows[0].inLikelyCents).toBe(360_000);
    expect(f.windows[0].inLowCents).toBe(280_000);
    expect(f.windows[0].outLowCents).toBe(330_000);
    // Paid Oct 31 (job + 14 days): 15 days × $100 out before it lands.
    expect(f.tight30).toMatchObject({ tight: true, date: "2026-10-30", shortCents: 150_000 });
    // Cautious: the job pays 70%, two weeks later, and 10% more goes out — lowest at the end.
    expect(f.lowCase).toMatchObject({ tight: true, date: "2027-01-13" });
  });

  it("texts: the forecast line, the tight line, short money", () => {
    const fine = buildForecast(inputs({ openInvoices: [{ id: "1", label: "INV-1", contactId: null, balanceCents: 1_100_000, dueDate: "2026-10-20", issueDate: null }], expenses: [{ spentOn: "2026-09-01", category: "fuel", amountCents: 210_000 }] }));
    expect(forecastLine(fine, 2026)).toBe("Next 30 days: about $11k in, $700 out - fine.");
    expect(tightLine(fine, 2026)).toBeNull();
    const tight = buildForecast(inputs({ labour: [{ profileId: "a", minutes: 28 * 60, rateCents: 8_000 }] }));
    expect(tightLine(tight, 2026)).toBe("Cash looks tight around Nov 14 (about $2,400 short)");
    expect(forecastLine(tight, 2026)).toBe("Next 30 days: about $0 in, $2.4k out - tight around Nov 14 (about $2,400 short).");
    expect([shortMoney(84_000), shortMoney(740_000), shortMoney(1_150_000), shortMoney(700_000)]).toEqual(["$840", "$7.4k", "$12k", "$7k"]);
  });
});

// ── Pure: pricing ─────────────────────────────────────────────────────────────────

describe("pricing maths", () => {
  it("a multi-line job splits revenue and profit by line amount; custom lines belong to no item", () => {
    const a = attributeJobs([
      { bookingId: "1", revenueCents: 100_000, profitCents: 40_000, lines: [{ itemId: "roof", amountCents: 90_000 }, { itemId: "vent", amountCents: 10_000 }] },
      { bookingId: "2", revenueCents: 50_000, profitCents: 10_000, lines: [{ itemId: "vent", amountCents: 25_000 }, { itemId: null, amountCents: 25_000 }] },
      { bookingId: "3", revenueCents: 0, profitCents: -5_000, lines: [{ itemId: "vent", amountCents: 0 }] },
    ]);
    expect(a.get("roof")).toEqual({ jobs: 1, revenueCents: 90_000, profitCents: 36_000 });
    expect(a.get("vent")).toEqual({ jobs: 2, revenueCents: 35_000, profitCents: 9_000 });
  });

  it("flags only with enough jobs and decided quotes, margin 10+ points under, win rate 70%+", () => {
    const jobs = Array.from({ length: 5 }, (_, i) => ({ bookingId: `g${i}`, revenueCents: 10_000, profitCents: 1_000, lines: [{ itemId: "g", amountCents: 10_000 }] }));
    const big = Array.from({ length: 5 }, (_, i) => ({ bookingId: `r${i}`, revenueCents: 100_000, profitCents: 50_000, lines: [{ itemId: "r", amountCents: 100_000 }] }));
    const quotes = Array.from({ length: 5 }, (_, i) => ({ id: `q${i}`, won: i < 4, itemIds: ["g"] }));
    const { companyMargin, items } = itemStats([...jobs, ...big], quotes);
    expect(companyMargin).toBeCloseTo(255_000 / 550_000, 6);
    expect(items.get("g")).toMatchObject({ jobs: 5, margin: 0.1, quotes: 5, won: 4, winRate: 0.8 });
    expect(isUnderpriced(items.get("g")!, companyMargin)).toBe(true);
    expect(isUnderpriced({ ...items.get("g")!, winRate: 0.6 }, companyMargin)).toBe(false);
    expect(isUnderpriced({ ...items.get("g")!, quotes: 4 }, companyMargin)).toBe(false);
    expect(isUnderpriced({ ...items.get("g")!, jobs: 4 }, companyMargin)).toBe(false);
    expect(isUnderpriced({ ...items.get("g")!, margin: 0.4 }, companyMargin)).toBe(false);
  });

  it("raises: capped at +15%, tidy, never a cut, simple prices only, at least +3%", () => {
    const item: CatalogForPricing = { id: "g", label: "Gutter cleaning", pricingType: "flat", rateCents: 18_900, minimumCents: 0, unitLabel: null, active: true };
    const stats = { itemId: "g", jobs: 18, revenueCents: 1, profitCents: 1, margin: 0.12, quotes: 12, won: 11, winRate: 0.92 };
    const p = proposeRaise(item, stats, 0.35)!;
    expect(p).toMatchObject({ oldRateCents: 18_900, newRateCents: 21_500, pct: 14 });
    expect(p.newRateCents).toBeLessThanOrEqual(Math.floor(18_900 * 1.15));
    // A small gap → a small raise ((1-.30)/(1-.35) = +7.7% → $203.54, down to the $5 step).
    expect(proposeRaise(item, { ...stats, margin: 0.3 }, 0.35)).toMatchObject({ newRateCents: 20_000, pct: 6 });
    expect(proposeRaise(item, { ...stats, margin: 0.34 }, 0.35)).toBeNull();
    expect(proposeRaise({ ...item, pricingType: "tiered_by_measure" }, stats, 0.35)).toBeNull();
    expect(proposeRaise({ ...item, rateCents: 0 }, stats, 0.35)).toBeNull();
    // The minimum moves with it (whole dollars, capped).
    expect(proposeRaise({ ...item, pricingType: "per_measure", unitLabel: "sq ft", rateCents: 450, minimumCents: 25_000 }, stats, 0.35)).toMatchObject({ newRateCents: 517, newMinimumCents: 28_700 });
    expect(tidyPrice(21_735, 18_900, 21_734)).toBe(21_500);
    expect(tidyPrice(18_950, 18_900, 21_734)).toBe(18_950);
    expect(tidyPrice(18_000, 18_900, 21_734)).toBeNull();
  });

  it("the owner's text", () => {
    const p = proposeRaise({ id: "g", label: "Gutter cleaning", pricingType: "flat", rateCents: 18_900, minimumCents: 0, unitLabel: null, active: true }, { itemId: "g", jobs: 18, revenueCents: 1, profitCents: 1, margin: 0.12, quotes: 12, won: 11, winRate: 0.92 }, 0.35)!;
    expect(priceChangeSummary(p, { jobs: 18, margin: 0.12, winRate: 0.92 }, 0.35)).toBe(
      "Price check - Gutter cleaning: 18 jobs in 6 months, 12% margin (you average 35%), and you win 92% of quotes. Y raises it from $189 to $215 (+14%) for new quotes. Estimates from your app data - not financial advice.",
    );
    expect(replyInstruction(PRICE_CHANGE_KIND, 12)).toBe("Reply Y 12 to raise it, N 12 to leave it.");
  });

  it("quote lines: the lines the customer took, custom lines unattributed", () => {
    expect(
      quoteLines({
        line_items: [
          { serviceId: "roof", amountCents: 90_000, selected: true },
          { serviceId: "vent", amountCents: 10_000, optional: true, selected: false },
          { serviceId: "custom", amountCents: 5_000, custom: true },
        ],
        approved_line_items: null,
        input_snapshot: {},
      }),
    ).toEqual([
      { key: "roof", amountCents: 90_000 },
      { key: null, amountCents: 5_000 },
    ]);
  });
});

// ── Pure: the week ──────────────────────────────────────────────────────────────────

function jp(over: Partial<JobProfitRow>): JobProfitRow {
  return {
    bookingId: "b", title: "Roof", scheduledFor: "2026-10-14T12:00:00Z", contactName: "Sam Jones", revenueCents: 0, revenueSource: "estimate", labourMinutes: 0, labourCents: 0, materialsCents: 0, expensesCents: 0, costCents: 0, profitCents: 0, marginPct: null, missingRates: [], running: false, durationMinutes: 240, crewCount: 1, quoteId: null, serviceItemId: null, freeVisit: null,
    ...over,
  };
}

describe("the weekly text", () => {
  it("names the best job and the one to watch, and why", () => {
    const s = summarizeJobs([
      jp({ bookingId: "1", title: "Roof", contactName: "Sam Jones", revenueCents: 300_000, costCents: 180_000, profitCents: 120_000 }),
      jp({ bookingId: "2", title: "Deck", contactName: "Pat Smith", revenueCents: 200_000, costCents: 218_000, profitCents: -18_000, labourMinutes: 960, labourCents: 64_000, durationMinutes: 420 }),
      jp({ bookingId: "3", title: "Gutters", contactName: "Jo Lee", revenueCents: 342_000, costCents: 200_000, profitCents: 142_000 - 32_000 }),
      jp({ bookingId: "4", title: "Siding", contactName: "Al Moss", revenueCents: 0, costCents: 5_000, profitCents: -5_000 }),
    ]);
    expect(s).toMatchObject({ jobs: 4, billedCents: 842_000, profitCents: 842_000 - 598_000, unpriced: 1 });
    expect(s.best?.name).toBe("Jones roof");
    expect(s.watch).toMatchObject({ name: "Smith deck", profitCents: -18_000, reason: "labour 9h over" });
    expect(watchReason(jp({ labourMinutes: 100, labourCents: 4_000, materialsCents: 50_000, expensesCents: 14_000 }))).toBe("materials $640");
  });

  it("the example text, word for word", () => {
    const s = summarizeJobs([
      jp({ bookingId: "1", title: "Roof", contactName: "Sam Jones", revenueCents: 300_000, profitCents: 120_000, costCents: 180_000 }),
      jp({ bookingId: "2", title: "Deck", contactName: "Pat Smith", revenueCents: 170_000, profitCents: -18_000, costCents: 188_000, labourMinutes: 960 + 60, labourCents: 70_000, durationMinutes: 480 }),
      jp({ bookingId: "3", revenueCents: 120_000, profitCents: 66_000, costCents: 54_000, contactName: "A B" }),
      jp({ bookingId: "4", revenueCents: 100_000, profitCents: 40_000, costCents: 60_000, contactName: "C D" }),
      jp({ bookingId: "5", revenueCents: 100_000, profitCents: 60_000, costCents: 40_000, contactName: "E F" }),
      jp({ bookingId: "6", revenueCents: 52_000, profitCents: 42_000, costCents: 10_000, contactName: "G H" }),
    ]);
    // $11k lands tomorrow (this customer pays on the due date); $7.4k a month goes out.
    const f = buildForecast(inputs({ paidHistory: [{ contactId: null, dueDate: "2026-09-01", issueDate: null, paidDate: "2026-09-01" }], openInvoices: [{ id: "1", label: "INV", contactId: null, balanceCents: 1_100_000, dueDate: "2026-10-17", issueDate: null }], expenses: [{ spentOn: "2026-09-01", category: "fuel", amountCents: 2_100_000 / 10 }], labour: [{ profileId: "a", minutes: 28 * 60, rateCents: 22_333 }] }));
    expect(weeklyText(s, f, 2026)).toBe(
      "This week: 6 jobs done, $8,420 billed, profit about $3,100 (37%). Best: Jones roof $1,200. Watch: Smith deck lost $180 (labour 9h over). Next 30 days: about $11k in, $7.4k out - fine. Text 'profit' for more.",
    );
  });

  it("says when the numbers are a guess; shortens to fit; a quiet week", () => {
    const s = summarizeJobs([jp({ bookingId: "1", revenueCents: 100_000, profitCents: 100_000, costCents: 0 }), jp({ bookingId: "2", revenueCents: 50_000, profitCents: 50_000, costCents: 0 })], ["Mike", "Sam", "Al"]);
    expect(weeklyText(s, null, 2026)).toBe("This week: 2 jobs done, $1,500 billed, profit about $1,500 (100%). Best: Jones roof $1,000. 3 crew have no pay rate - profit is a guess. Text 'profit' for more.");
    expect(weeklyText(summarizeJobs([]), null, 2026)).toBe("This week: no jobs done. Text 'profit' for more.");
    const long = summarizeJobs([jp({ bookingId: "1", title: "x".repeat(300), revenueCents: 100_000, profitCents: 1_000, costCents: 99_000 }), jp({ bookingId: "2", title: "y".repeat(300), revenueCents: 100_000, profitCents: -1_000, costCents: 101_000 })], ["A"]);
    expect(weeklyText(long, null, 2026).length).toBeLessThanOrEqual(480);
    expect(jobName({ contactName: "Sam Jones", title: "Roof repair" })).toBe("Jones roof repair");
  });
});

// ── Settings + registry ──────────────────────────────────────────────────────────────

describe("settings and registry", () => {
  it("on for CrankLeads, off for house orgs unless switched on; merge only touches profit_advisor", () => {
    expect(readProfitAdvisorSettings({}, { doneForYou: true })).toMatchObject({ enabled: true, weekly: { enabled: true, day: 5, time: "15:00" }, pricingCheck: { enabled: true }, tightCushionCents: 0, enabledIsDefault: true });
    expect(readProfitAdvisorSettings({}, { doneForYou: false }).enabled).toBe(false);
    expect(readProfitAdvisorSettings({ profit_advisor: { weekly: { day: 9, time: "03:00" }, tight_cushion_cents: -5 } }, { doneForYou: true })).toMatchObject({ weekly: { day: 5, time: "15:00" }, tightCushionCents: 0 });
    const merged = mergeProfitAdvisorSettings({ sms_agent: { autonomy: "ask_first" } }, { enabled: true, weekly: { day: 1, time: "07:30" }, pricingCheck: { enabled: false }, tightCushionCents: 250_000 });
    expect(merged).toEqual({ sms_agent: { autonomy: "ask_first" }, profit_advisor: { enabled: true, weekly: { day: 1, time: "07:30" }, pricing_check: { enabled: false }, tight_cushion_cents: 250_000, any_on: true } });
  });

  it("activeFor: CrankLeads yes, A1 no; registered after purchasing; no duplicate kinds/tools", async () => {
    expect(await profitAdvisorActiveFor(db.client, { organizationId: ORG, companyId: CO })).toBe(true);
    expect(await profitAdvisorActiveFor(db.client, { organizationId: HOUSE_ORG, companyId: HOUSE_CO })).toBe(false);
    const house = await activeRolesFor(db.client, { organizationId: HOUSE_ORG, companyId: HOUSE_CO });
    expect(house.map((r) => r.role)).not.toContain("profit_advisor");
    expect((await loadProfitCompanies(db.client)).map((c) => c.companyId)).toEqual([CO]);
    const roles = staffRoles().map((r) => r.role);
    expect(roles.indexOf("profit_advisor")).toBeGreaterThan(roles.indexOf("purchasing"));
    expect(roleApprovalExecutor(PRICE_CHANGE_KIND)).toBeTypeOf("function");
    expect(registryProblems([], [])).toEqual([]);
    expect(profitAdvisorRole.ownerTools.map((t) => t.tool.name)).toEqual(["profit", "job_profit", "cash_forecast", "pricing_check"]);
    expect(PROFIT_ADVISOR_SWEEPS.map((s) => s.name)).toEqual(["profit_advisor:weekly", "profit_advisor:pricing"]);
    expect(profitAdvisorRole.agentTools).toEqual([]);
    expect(profitAdvisorRole.ownerMedia).toBeUndefined();
  });
});

// ── The weekly sweep ─────────────────────────────────────────────────────────────────

describe("profit_advisor:weekly", () => {
  it("Friday 15:00: one money text from the platform number, the week's real job costing, once across workers", async () => {
    const outcome = await runCompanyWeekly(db.client, await crank(), FRIDAY);
    expect(outcome).toBe("sent");
    const [text] = texts();
    expect(text.to).toBe(OWNER);
    // Roof $1,500 − 8h × $40 = $1,180; deck $800 − 20h × $40 − $180 = −$180 (20h vs 8h booked);
    // gutters $189 − 2h × $40 = $109. The imported job and A1's job aren't counted.
    expect(text.body).toMatch(/^CrankLeads: This week: 3 jobs done, \$2,489 billed, profit about \$1,109 \(45%\)\. Best: Jones roof repair \$1,180\. Watch: Smith deck lost \$180 \(labour 12h over\)\. Next 30 days: about \$\S+ in, \$\S+ out - fine\. Text 'profit' for more\.$/);
    expect(rows("profit_advisor_runs")[0]).toMatchObject({ kind: "weekly", run_key: "2026-W42", status: "sent" });
    // A second worker in the same window: nothing.
    expect(await runCompanyWeekly(db.client, await crank(), FRIDAY + 60_000)).toBe("claimed_elsewhere");
    expect(sendSms).toHaveBeenCalledTimes(1);
    // A1 never touched.
    expect(db.queries.filter((q) => q.filters.some((f) => f.value === HOUSE_CO || f.value === HOUSE_ORG) && q.table === "bookings")).toEqual([]);
  });

  it("only on the owner's day, from their time, until 20:00; weekWindow is gap-free", async () => {
    const c = await crank();
    expect(await runCompanyWeekly(db.client, c, FRIDAY - DAY)).toBe("not_now");
    expect(await runCompanyWeekly(db.client, c, Date.parse("2026-10-16T18:55:00Z"))).toBe("not_now"); // 14:55
    expect(await runCompanyWeekly(db.client, c, Date.parse("2026-10-17T00:05:00Z"))).toBe("not_now"); // 20:05
    expect(weekWindow("2026-10-16", "15:00", TZ)).toEqual({ fromIso: "2026-10-09T19:00:00.000Z", toIso: "2026-10-16T19:00:00.000Z" });
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("a quiet week with cash fine: no text (claimed as skipped)", async () => {
    db.tables.bookings = (db.tables.bookings as Array<Record<string, unknown>>).filter((b) => !["b-14", "b-15"].includes(String(b.id)));
    expect(await runCompanyWeekly(db.client, await crank(), FRIDAY)).toBe("skipped");
    expect(sendSms).not.toHaveBeenCalled();
    expect(rows("profit_advisor_runs")[0]).toMatchObject({ status: "skipped" });
  });

  it("a quiet week but cash tight: it texts anyway", async () => {
    db.tables.bookings = (db.tables.bookings as Array<Record<string, unknown>>).filter((b) => !["b-14", "b-15"].includes(String(b.id)));
    db.tables.invoices = [];
    expect(await runCompanyWeekly(db.client, await crank(), FRIDAY)).toBe("sent");
    expect(texts()[0].body).toMatch(/^CrankLeads: This week: 1 job done, \$1,500 billed, profit about \$1,180 \(79%\)\. Next 30 days: about \$0 in, \$\S+ out - tight around Nov 1[45] \(about \$[\d,]+ short\)\. Text 'profit' for more\.$/);
  });

  it("a failed send is retried after 30 minutes (3 tries); weekly off / no verified cell → nothing", async () => {
    sendSms.mockImplementationOnce(() => Promise.reject(new Error("twilio down")));
    expect(await runCompanyWeekly(db.client, await crank(), FRIDAY)).toBe("failed");
    expect(await runCompanyWeekly(db.client, await crank(), FRIDAY + 10 * 60_000)).toBe("claimed_elsewhere");
    expect(await runCompanyWeekly(db.client, await crank(), FRIDAY + 31 * 60_000)).toBe("sent");
    expect(rows("profit_advisor_runs")[0]).toMatchObject({ status: "sent", attempts: 2 });
    db = seed();
    (db.tables.companies[0] as Record<string, unknown>).ai_settings = { profit_advisor: { weekly: { enabled: false } } };
    expect(await runCompanyWeekly(db.client, await crank(), FRIDAY)).toBe("off");
    (db.tables.companies[0] as Record<string, unknown>).ai_settings = {};
    (db.tables.companies[0] as Record<string, unknown>).owner_phone_verified_at = null;
    expect(await runCompanyWeekly(db.client, await crank(), FRIDAY)).toBe("off");
  });

  it("an owner with two businesses: the text names which one", async () => {
    db.tables.companies.push(company({ id: "66666666-6666-4666-8666-666666666666", name: "Northshore Snow" }));
    expect(await runCompanyWeekly(db.client, await crank(), FRIDAY)).toBe("sent");
    expect(texts()[0].body).toMatch(/^CrankLeads: Northshore Roofing: This week: 3 jobs done/);
  });

  it("claimRun: one winner per key", async () => {
    const a = await claimRun(db.client, { organizationId: ORG, companyId: CO }, "pricing", "2026-11", PRICING_DAY);
    const b = await claimRun(db.client, { organizationId: ORG, companyId: CO }, "pricing", "2026-11", PRICING_DAY);
    expect(a).not.toBeNull();
    expect(b).toBeNull();
  });
});

// ── The pricing check + price_change ──────────────────────────────────────────────────

describe("the pricing check", () => {
  it("first Tuesday of the month (caught up to Friday), 09:00–17:00", () => {
    expect(firstTuesdayOf("2026-11-20")).toBe("2026-11-03");
    expect(firstTuesdayOf("2026-09-30")).toBe("2026-09-01");
    expect(pricingDue("2026-11-03", "10:00")).toBe(true);
    expect(pricingDue("2026-11-06", "16:59")).toBe(true);
    expect(pricingDue("2026-11-07", "10:00")).toBe(false);
    expect(pricingDue("2026-11-02", "10:00")).toBe(false);
    expect(pricingDue("2026-11-03", "08:59")).toBe(false);
  });

  it("finds the thin-margin item customers still say yes to (read-only report)", async () => {
    const report = await runPricingCheck(db.client, await crank(), PRICING_DAY);
    const gutter = report.items.find((i) => i.label === "Gutter cleaning")!;
    const roof = report.items.find((i) => i.label === "Roof repair")!;
    // 7 gutter jobs: 6 × ($189 − $100 labour − $66 receipts) + ($189 − $80) = $247 on $1,323.
    expect(gutter).toMatchObject({ jobs: 7, revenueCents: 132_300, profitCents: 24_700, quotes: 8, won: 7, underpriced: true });
    expect(gutter.proposal).toMatchObject({ oldRateCents: 18_900, newRateCents: 21_500, pct: 14 });
    expect(roof).toMatchObject({ jobs: 7, underpriced: false, proposal: null });
    expect(Math.round(report.companyMargin! * 100)).toBe(46);
    expect(rows("price_changes")).toEqual([]);
    expect(rows("owner_approvals")).toEqual([]);
  });

  it("price_change end to end through decideApproval: the exact owner text, Y raises the price once, recorded", async () => {
    vi.setSystemTime(PRICING_DAY);
    const result = await runCompanyPricing(db.client, await crank(), PRICING_DAY);
    expect(result).toEqual({ outcome: "done", asked: 1 });
    const approval = rows("owner_approvals")[0];
    expect(approval).toMatchObject({ kind: PRICE_CHANGE_KIND, status: "pending", notified_to: OWNER });
    const code = approval.short_code;
    expect(texts()[0].body).toBe(
      `CrankLeads: #${code} Price check - Gutter cleaning: 7 jobs in 6 months, 19% margin (you average 46%), and you win 88% of quotes. Y raises it from $189 to $215 (+14%) for new quotes. Estimates from your app data - not financial advice. Reply Y ${code} to raise it, N ${code} to leave it.`,
    );
    expect(rows("price_changes")[0]).toMatchObject({ status: "proposed", old_rate_cents: 18_900, new_rate_cents: 21_500, approval_id: approval.id, basis: { jobs: 7, marginPct: 19, companyMarginPct: 46, quotes: 8, winRatePct: 88 } });
    // A second pass this month asks nothing more.
    expect(await runCompanyPricing(db.client, await crank(), PRICING_DAY + 60 * 60_000)).toEqual({ outcome: "claimed_elsewhere", asked: 0 });

    const decided = await decideApproval(db.client, String(approval.id), { approved: true, decidedVia: "sms", decidedBy: OWNER }, { organizationId: ORG, nowMs: PRICING_DAY + 60_000 });
    expect(decided.message).toBe("Done - Gutter cleaning is now $215 on your price list (was $189). New quotes use it; quotes already sent keep their price. I'll show you how it does in next month's price check.");
    expect(rows("service_catalog_items").find((i) => i.id === GUTTER)).toMatchObject({ rate_cents: 21_500, active: true });
    expect(rows("service_catalog_items").find((i) => i.id === ROOF)).toMatchObject({ rate_cents: 150_000 });
    expect(rows("price_changes")[0]).toMatchObject({ status: "applied" });
    expect(rows("price_changes")[0].applied_at).toBeTruthy();
    expect(rows("owner_approvals")[0].status).toBe("executed");
    // Idempotent: a second Y is "already"; the executor re-run changes nothing.
    expect((await decideApproval(db.client, String(approval.id), { approved: true, decidedVia: "sms", decidedBy: OWNER }, { organizationId: ORG })).outcome).toBe("already");
    const again = await executePriceChange(db.client, rows("owner_approvals")[0] as never, { approved: true, decidedVia: "sms", decidedBy: OWNER });
    expect(again.message).toBe("Already done - Gutter cleaning is $215.");
    expect(rows("service_catalog_items").find((i) => i.id === GUTTER)?.rate_cents).toBe(21_500);

    // The next check shows the effect, and doesn't ask about it again for 90 days.
    const tool = await runOwnerTool(ownerState(PRICING_DAY + 2 * DAY), "pricing_check", {});
    expect(tool.past_changes).toEqual(["Gutter cleaning: raised 2 days ago - no jobs since yet"]);
    const later = await runPricingCheck(db.client, await crank(), PRICING_DAY + 35 * DAY);
    expect(later.items.find((i) => i.label === "Gutter cleaning")).toMatchObject({ proposal: null });
  });

  it('the owner texts "Y 1" to the platform number: the price goes up; "Y 1 $199" changes nothing', async () => {
    vi.setSystemTime(PRICING_DAY);
    await runCompanyPricing(db.client, await crank(), PRICING_DAY);
    const code = rows("owner_approvals")[0].short_code;
    const sms = (body: string, n: number) => handleOwnerInboundSms(db.client, { from: OWNER, to: PLATFORM, body, media: [], providerRef: `SMpa${n}`, viaPlatformNumber: true, companyId: null });
    sendSms.mockClear();
    await sms(`Y ${code} $199`, 1);
    expect(rows("service_catalog_items").find((i) => i.id === GUTTER)?.rate_cents).toBe(18_900);
    expect(rows("owner_approvals")[0].status).toBe("pending");
    await sms(`Y ${code}`, 2);
    expect(rows("service_catalog_items").find((i) => i.id === GUTTER)?.rate_cents).toBe(21_500);
    expect(texts().at(-1)?.body).toContain("Done - Gutter cleaning is now $215 on your price list (was $189).");
  });

  it("N: nothing changes, and it isn't asked again for 90 days; expiry: nothing changes", async () => {
    vi.setSystemTime(PRICING_DAY);
    await runCompanyPricing(db.client, await crank(), PRICING_DAY);
    const approval = rows("owner_approvals")[0];
    const no = await decideApproval(db.client, String(approval.id), { approved: false, decidedVia: "sms", decidedBy: OWNER }, { organizationId: ORG, nowMs: PRICING_DAY + 60_000 });
    expect(no.message).toBe("OK - Gutter cleaning stays at $189. I won't ask about it again for 90 days.");
    expect(rows("service_catalog_items").find((i) => i.id === GUTTER)?.rate_cents).toBe(18_900);
    expect(rows("price_changes")[0].status).toBe("declined");
    const dec = await runPricingCheck(db.client, await crank(), PRICING_DAY + 28 * DAY);
    expect(dec.items.find((i) => i.label === "Gutter cleaning")).toMatchObject({ underpriced: true, proposal: null, held: "recent_change" });

    db = seed();
    await runCompanyPricing(db.client, await crank(), PRICING_DAY);
    const a2 = rows("owner_approvals")[0];
    const exp = await expireApproval(db.client, { ...a2, expires_at: new Date(PRICING_DAY).toISOString() } as never, PRICING_DAY + 8 * DAY);
    expect(exp.outcome).toBe("expired");
    expect(rows("price_changes")[0].status).toBe("expired");
    expect(rows("service_catalog_items").find((i) => i.id === GUTTER)?.rate_cents).toBe(18_900);
  });

  it("Y after someone changed the price by hand: nothing written (stale); a note re-asks under a fresh code", async () => {
    vi.setSystemTime(PRICING_DAY);
    await runCompanyPricing(db.client, await crank(), PRICING_DAY);
    const approval = rows("owner_approvals")[0];
    (rows("service_catalog_items").find((i) => i.id === GUTTER) as Record<string, unknown>).rate_cents = 19_900;
    const y = await decideApproval(db.client, String(approval.id), { approved: true, decidedVia: "sms", decidedBy: OWNER }, { organizationId: ORG, nowMs: PRICING_DAY + 60_000 });
    expect(y.message).toBe("Nothing changed - Gutter cleaning is $199 now, not $189 (it was changed since I asked).");
    expect(rows("service_catalog_items").find((i) => i.id === GUTTER)?.rate_cents).toBe(19_900);
    expect(rows("price_changes")[0].status).toBe("stale");

    db = seed();
    await runCompanyPricing(db.client, await crank(), PRICING_DAY);
    const first = rows("owner_approvals")[0];
    const noted = await decideApproval(db.client, String(first.id), { approved: true, ownerNote: "$199", decidedVia: "app", decidedBy: "profile:p-owner" }, { organizationId: ORG, nowMs: PRICING_DAY + 60_000 });
    const fresh = rows("owner_approvals").find((a) => a.id !== first.id)!;
    expect(noted.message).toContain(`Nothing changed yet - #${first.short_code} only raises Gutter cleaning to exactly $215 (+14%).`);
    expect(noted.message).toContain(`#${fresh.short_code} Reply Y ${fresh.short_code} to raise it, N ${fresh.short_code} to leave it.`);
    expect(rows("price_changes")[0]).toMatchObject({ status: "proposed", approval_id: fresh.id });
    expect(rows("service_catalog_items").find((i) => i.id === GUTTER)?.rate_cents).toBe(18_900);
    // Y on the fresh one applies it.
    expect((await decideApproval(db.client, String(fresh.id), { approved: true, decidedVia: "app", decidedBy: "profile:p-owner" }, { organizationId: ORG, nowMs: PRICING_DAY + 120_000 })).message).toContain("Done - Gutter cleaning is now $215");
  });

  it("an executor run for a question with no price change row changes nothing", async () => {
    const r = await executePriceChange(db.client, { id: "nope", organization_id: ORG, company_id: CO, contact_id: null, conversation_id: null, kind: PRICE_CHANGE_KIND, summary: "x", payload: {}, status: "approved", short_code: 4, requested_by: "profit_advisor", expires_at: null, created_at: "" }, { approved: true, decidedVia: "sms", decidedBy: OWNER });
    expect(r).toEqual({ ok: false, message: "#4 isn't linked to a price change any more, so nothing changed." });
  });

  it("the pricing check is off → no question; A1 is never checked", async () => {
    (db.tables.companies[0] as Record<string, unknown>).ai_settings = { profit_advisor: { pricing_check: { enabled: false } } };
    expect(await runCompanyPricing(db.client, await crank(), PRICING_DAY)).toEqual({ outcome: "off", asked: 0 });
    const house = (await loadProfitCompany(db.client, HOUSE_ORG, HOUSE_CO))!;
    expect(await runCompanyPricing(db.client, house, PRICING_DAY)).toEqual({ outcome: "off", asked: 0 });
    expect(await runCompanyWeekly(db.client, house, FRIDAY)).toBe("off");
    expect(rows("owner_approvals")).toEqual([]);
  });
});

// ── Forecast data (tolerant reads) ─────────────────────────────────────────────────────

describe("forecast inputs", () => {
  it("reads invoices, quotes, booked jobs, series, plans, spending, payroll, POs and rentals; a failed source is a note", async () => {
    db.tables.quotes.push({ id: "q-open", organization_id: ORG, company_id: CO, title: "Chimney", contact_id: "ct-smith", status: "approved", approved_at: "2026-10-10T12:00:00Z", approved_total_cents: 113_000, total_cents: 113_000, approved_deposit_cents: 28_250, deposit_paid_at: null });
    db.tables.bookings.push(
      { id: "b-up1", organization_id: ORG, company_id: CO, title: "Chimney", contact_id: "ct-smith", status: "confirmed", scheduled_for: "2026-10-22T13:00:00Z", quote_id: "q-open" },
      { id: "b-up2", organization_id: ORG, company_id: CO, title: "Eavestrough", contact_id: "ct-lee", status: "confirmed", scheduled_for: "2026-10-23T13:00:00Z", quote_id: null, price_cents: 40_000 },
    );
    db.tables.recurring_jobs.push({ id: "rj-1", organization_id: ORG, company_id: CO, title: "Lawn", status: "active", frequency: "weekly", interval_count: 2, weekdays: [1], start_date: "2026-06-01", ends_on: null, max_occurrences: null, generated_through: "2026-12-14", line_items: [{ label: "Cut", quantity: 1, unitPriceCents: 6_000 }] });
    db.tables.service_agreements.push({ id: "sa-1", organization_id: ORG, company_id: CO, plan_name: "Spring + Fall", customer_name: "Dana Jones", status: "active", billing: "annual", price_cents: 42_000, renewal_price_cents: null, term_end: "2026-11-30", renewed_by_agreement_id: null, renewal_declined_at: null });
    db.tables.purchase_orders.push({ id: "po-1", organization_id: ORG, company_id: CO, po_number: "PO-1", needed_by: "2026-10-21", est_total_cents: 116_200, status: "sent", job_label: "Smith - Chimney" });
    db.tables.rentals = [{ id: "r-1", organization_id: ORG, company_id: CO, item: "Mini-ex", vendor: "Sunbelt", out_at: "2026-10-15T12:00:00Z", due_back_at: "2026-10-20T21:00:00Z", returned_at: null, rate_per_day_cents: 38_000 }];
    const inp = await loadForecastInputs(db.client, await crank(), FRIDAY);
    expect(inp.openInvoices).toEqual([{ id: "inv-7", label: "INV-7 Jones", contactId: "ct-jones", balanceCents: 2_000_000, dueDate: "2026-10-20", issueDate: "2026-10-06" }]);
    expect(inp.quotes).toEqual([{ id: "q-open", label: "Smith Chimney", depositDueCents: 28_250, balanceCents: 84_750, jobDate: "2026-10-22" }]);
    expect(inp.jobs).toEqual([{ id: "b-up2", label: "Lee Eavestrough", date: "2026-10-23", expectedCents: 45_200 }]);
    expect(inp.series).toEqual([{ id: "rj-1", label: "Lawn", visitCents: 6_780, dates: ["2026-12-28", "2027-01-11"] }]);
    expect(inp.renewals).toEqual([{ id: "sa-1", label: "Jones Spring + Fall renewal", date: "2026-11-30", cents: 47_460 }]);
    expect(inp.pos).toEqual([{ label: "PO-1 Smith - Chimney", neededBy: "2026-10-21", cents: 116_200 }]);
    expect(inp.rentals).toEqual([{ label: "Mini-ex (Sunbelt)", from: "2026-10-15", to: "2026-10-20", dailyCents: 38_000 }]);
    expect(inp.labour.find((l) => l.profileId === "p-mike")).toMatchObject({ rateCents: 4_000 });
    expect(inp.notes).toEqual([]);

    // Another role's table missing / a read failing: left out with a note, never a crash.
    delete db.tables.rentals;
    db.failNext("expenses", "select");
    const partial = await loadForecastInputs(db.client, await crank(), FRIDAY);
    expect(partial.notes).toEqual(["Expenses not included - couldn't read it."]);
    expect(partial.openInvoices).toHaveLength(1);
  });
});

// ── Owner tools ─────────────────────────────────────────────────────────────────────────

describe("owner tools", () => {
  it("profit: this week's numbers, best/worst and why, the disclaimer", async () => {
    const r = await runOwnerTool(ownerState(FRIDAY), "profit", {});
    expect(r).toMatchObject({ ok: true, period: "the 7 days to Fri Oct 16 3pm (the weekly money text)", jobs_done: 3, billed: "$2,489", profit: "$1,109", margin: "45%", disclaimer: "Estimates from your app data - not financial advice." });
    expect((r.best as Array<Record<string, unknown>>)[0]).toMatchObject({ job: "Jones roof repair", profit: "$1,180" });
    expect((r.worst as Array<Record<string, unknown>>)[0]).toMatchObject({ job: "Smith deck", profit: "-$180", why: "labour 12h over" });
    const month = await runOwnerTool(ownerState(FRIDAY), "profit", { period: "last_month" });
    expect(month).toMatchObject({ period: "last month (Sep)", jobs_done: 0 });
  });

  it("job_profit: one job's money; several matches → which one", async () => {
    const r = await runOwnerTool(ownerState(FRIDAY), "job_profit", { job: "how did the Smith deck do" });
    expect(r).toMatchObject({ ok: true, job: "Smith deck", billed: "$800", labour: "20h ($800), booked 8h", receipts: "$180", profit: "-$180", margin: "-22%", why: "labour 12h over", billed_from: "the approved quote / series price (not invoiced yet)" });
    const many = await runOwnerTool(ownerState(FRIDAY), "job_profit", { job: "Jones roof" });
    expect((many.which_one as unknown[]).length).toBeGreaterThan(1);
    const latest = await runOwnerTool(ownerState(FRIDAY), "job_profit", { job: "Jones roof", most_recent: true });
    expect(latest).toMatchObject({ job: "Jones roof repair", day: "Oct 13", profit: "$1,180" });
    expect(await runOwnerTool(ownerState(FRIDAY), "job_profit", { job: "Zebra" })).toMatchObject({ error: 'No job in the last 6 months matches "Zebra".' });
  });

  it("cash_forecast: windows, tight or not, the disclaimer", async () => {
    const r = await runOwnerTool(ownerState(FRIDAY), "cash_forecast", {});
    expect(r).toMatchObject({ ok: true, tight_next_30_days: "no", disclaimer: "Estimates from your app data - not financial advice." });
    expect(String(r.summary)).toMatch(/^Next 30 days: about \$\S+ in, \$\S+ out - fine\.$/);
    expect((r.windows as unknown[]).length).toBe(3);
    expect(r.biggest_coming_in_30_days).toEqual(["INV-7 Jones $20k around Oct 27"]);
  });

  it("A1 / switched off: the tools say so", async () => {
    (db.tables.companies[0] as Record<string, unknown>).ai_settings = { profit_advisor: { enabled: false } };
    expect(await runOwnerTool(ownerState(FRIDAY), "profit", {})).toMatchObject({ error: expect.stringContaining("off for this business") });
  });
});

// ── Briefing items + Settings view ──────────────────────────────────────────────────────

describe("briefing items", () => {
  it("only when the next 30 days look tight; [] when fine, off, or for A1", async () => {
    expect(await briefingItems(db.client, { organizationId: ORG, companyId: CO }, "2026-10-17")).toEqual([]);
    db.tables.invoices = [];
    const [line] = await briefingItems(db.client, { organizationId: ORG, companyId: CO }, "2026-10-17");
    expect(line).toMatch(/^Cash looks tight around (Oct|Nov) \d+ \(about \$[\d,]+ short\)$/);
    expect(await briefingItems(db.client, { organizationId: HOUSE_ORG, companyId: HOUSE_CO }, "2026-10-17")).toEqual([]);
    db.failNext("companies", "select");
    expect(await briefingItems(db.client, { organizationId: ORG, companyId: CO }, "2026-10-17")).toEqual([]);
  });
});

describe("settings view", () => {
  it("members see the switches only; owners/admins see the money", async () => {
    const member = (await getProfitAdvisorView(db.client, { organizationId: ORG, companyId: CO }, { manager: false, nowMs: FRIDAY }))!;
    expect(member).toMatchObject({ manager: false, forecast: null, pricing: null, lastWeekly: null, settings: { enabled: true } });
    await runCompanyWeekly(db.client, await crank(), FRIDAY);
    const owner = (await getProfitAdvisorView(db.client, { organizationId: ORG, companyId: CO }, { manager: true, nowMs: FRIDAY }))!;
    expect(owner.forecast?.windows.map((w) => w.days)).toEqual([30, 60, 90]);
    expect(owner.pricing?.items.find((i) => i.label === "Gutter cleaning")).toMatchObject({ jobs: 7, underpriced: true, proposalCents: 21_500 });
    expect(owner.lastWeekly).toMatchObject({ date: "2026-10-16", status: "sent" });
  });
});

// ── Review fixes ─────────────────────────────────────────────────────────────────────────

/** Add a finished job to the live fake DB (same shape as the seed's). */
function liveJob(spec: Partial<JobSpec> & Pick<JobSpec, "at" | "lines" | "labourMin">): string {
  return addJob(db.tables as Record<string, Array<Record<string, unknown>>>, { ...SPEC_DEFAULTS, ...spec });
}
const gutter = () => rows("service_catalog_items").find((i) => i.id === GUTTER) as Record<string, unknown>;
void tablesRef;

describe("review: items switched off, minimums, price types", () => {
  it("an item switched off on the price list is never proposed", async () => {
    gutter().active = false;
    const report = await runPricingCheck(db.client, await crank(), PRICING_DAY);
    expect(report.items.find((i) => i.label === "Gutter cleaning")).toMatchObject({ underpriced: true, proposal: null, held: "inactive" });
    expect(await runCompanyPricing(db.client, await crank(), PRICING_DAY)).toEqual({ outcome: "done", asked: 0 });
  });

  it("switched off after the question: Y writes nothing and never switches it back on", async () => {
    vi.setSystemTime(PRICING_DAY);
    await runCompanyPricing(db.client, await crank(), PRICING_DAY);
    gutter().active = false;
    const y = await decideApproval(db.client, String(rows("owner_approvals")[0].id), { approved: true, decidedVia: "sms", decidedBy: OWNER }, { organizationId: ORG, nowMs: PRICING_DAY + 60_000 });
    expect(y.message).toBe("Nothing changed - Gutter cleaning is switched off on your price list.");
    expect(gutter()).toMatchObject({ active: false, rate_cents: 18_900 });
    expect(rows("price_changes")[0].status).toBe("stale");
  });

  it("a minimum the owner changed by hand (or a new price type) is never overwritten", async () => {
    vi.setSystemTime(PRICING_DAY);
    gutter().minimum_cents = 15_000;
    await runCompanyPricing(db.client, await crank(), PRICING_DAY);
    expect(rows("price_changes")[0]).toMatchObject({ old_minimum_cents: 15_000, new_minimum_cents: 17_000 });
    gutter().minimum_cents = 10_000;
    const y = await decideApproval(db.client, String(rows("owner_approvals")[0].id), { approved: true, decidedVia: "sms", decidedBy: OWNER }, { organizationId: ORG, nowMs: PRICING_DAY + 60_000 });
    expect(y.message).toBe("Nothing changed - the Gutter cleaning price was edited since I asked (its minimum or how it's priced).");
    expect(gutter()).toMatchObject({ minimum_cents: 10_000, rate_cents: 18_900 });

    db = seed();
    await runCompanyPricing(db.client, await crank(), PRICING_DAY);
    gutter().pricing_type = "tiered_by_measure";
    await decideApproval(db.client, String(rows("owner_approvals")[0].id), { approved: true, decidedVia: "sms", decidedBy: OWNER }, { organizationId: ORG, nowMs: PRICING_DAY + 60_000 });
    expect(gutter().rate_cents).toBe(18_900);
    expect(rows("price_changes")[0].status).toBe("stale");
  });
});

describe("review: only numbers at the current price count", () => {
  it("a raise the owner made by hand: the next check counts from then (no stacking on old margins)", async () => {
    // October's check saw $189 (the watch records it).
    await runPricingCheck(db.client, await crank(), Date.parse("2026-10-06T14:00:00Z"), { record: true });
    expect(rows("price_watch").find((w) => w.service_catalog_item_id === GUTTER)).toMatchObject({ rate_cents: 18_900, changed_at: null });
    // The owner raises it to $199 in the app.
    gutter().rate_cents = 19_900;
    expect(await runCompanyPricing(db.client, await crank(), PRICING_DAY)).toEqual({ outcome: "done", asked: 0 });
    expect(rows("price_watch").find((w) => w.service_catalog_item_id === GUTTER)).toMatchObject({ rate_cents: 19_900, changed_at: new Date(PRICING_DAY).toISOString() });
    const report = await runPricingCheck(db.client, await crank(), PRICING_DAY + 28 * DAY);
    expect(report.items.find((i) => i.label === "Gutter cleaning")).toMatchObject({ jobs: 0, underpriced: false, proposal: null, priceSince: new Date(PRICING_DAY).toISOString() });
  });

  it("day 91 after an approved raise: needs 5 new jobs at the new price, then judges those", async () => {
    vi.setSystemTime(PRICING_DAY);
    await runCompanyPricing(db.client, await crank(), PRICING_DAY);
    await decideApproval(db.client, String(rows("owner_approvals")[0].id), { approved: true, decidedVia: "sms", decidedBy: OWNER }, { organizationId: ORG, nowMs: PRICING_DAY + 60_000 });
    expect(gutter().rate_cents).toBe(21_500);
    const day91 = PRICING_DAY + 91 * DAY;
    // The 90 days are up, but nothing has been sold at $215 yet: no new question off the old $189 numbers.
    const quiet = await runPricingCheck(db.client, await crank(), day91);
    expect(quiet.items.find((i) => i.label === "Gutter cleaning")).toMatchObject({ jobs: 0, underpriced: false, proposal: null });
    // Five jobs sold at $215 (quoted after the raise), still thin: judged on those alone.
    for (let i = 0; i < 5; i++) liveJob({ at: `2026-12-1${i}T14:00:00.000Z`, lines: [["gutter_clean", 21_500]], labourMin: 300 });
    const busy = await runPricingCheck(db.client, await crank(), day91);
    const g = busy.items.find((i) => i.label === "Gutter cleaning")!;
    expect(g).toMatchObject({ jobs: 5, revenueCents: 107_500, quotes: 5, won: 5, underpriced: true });
    expect(g.proposal).toMatchObject({ oldRateCents: 21_500, newRateCents: 24_500, pct: 14 });
  });

  it("approved quotes that were never 'sent' still count as wins", async () => {
    db.tables.quotes.push({ id: "q-onsite", organization_id: ORG, company_id: CO, status: "approved", sent_at: null, approved_at: "2026-08-21T13:00:00.000Z", superseded_by: null, line_items: [{ serviceId: "gutter_clean", amountCents: 18_900, selected: true }], approved_line_items: null, input_snapshot: {} });
    const report = await runPricingCheck(db.client, await crank(), PRICING_DAY);
    expect(report.items.find((i) => i.label === "Gutter cleaning")).toMatchObject({ quotes: 9, won: 8 });
  });
});

describe("review: stuck rows", () => {
  it("a price change stuck in 'applying' is finished after 10 minutes, re-checking the price first", async () => {
    vi.setSystemTime(PRICING_DAY);
    await runCompanyPricing(db.client, await crank(), PRICING_DAY);
    const change = rows("price_changes")[0];
    Object.assign(change, { status: "applying", decided_at: new Date(PRICING_DAY).toISOString(), updated_at: new Date(PRICING_DAY).toISOString() });
    // Not yet 10 minutes: left alone.
    await runCompanyPricing(db.client, await crank(), PRICING_DAY + 5 * 60_000);
    expect(change.status).toBe("applying");
    await runCompanyPricing(db.client, await crank(), PRICING_DAY + 11 * 60_000);
    expect(change.status).toBe("applied");
    expect(gutter().rate_cents).toBe(21_500);

    // The write happened but the worker died before recording it: no second write, just recorded.
    db = seed();
    await runCompanyPricing(db.client, await crank(), PRICING_DAY);
    const c2 = rows("price_changes")[0];
    Object.assign(c2, { status: "applying", updated_at: new Date(PRICING_DAY).toISOString() });
    gutter().rate_cents = 21_500;
    db.queries.length = 0;
    await runCompanyPricing(db.client, await crank(), PRICING_DAY + 11 * 60_000);
    expect(c2.status).toBe("applied");
    expect(db.queries.filter((q) => q.table === "service_catalog_items" && q.op === "update")).toEqual([]);
  });

  it("a weekly run stuck at 'claimed' (dead worker) is taken again after 30 minutes", async () => {
    db.tables.profit_advisor_runs.push({ id: "run-x", organization_id: ORG, company_id: CO, kind: "weekly", run_key: "2026-W42", status: "claimed", attempts: 1, created_at: new Date(FRIDAY - 40 * 60_000).toISOString(), updated_at: new Date(FRIDAY - 40 * 60_000).toISOString() });
    expect(await runCompanyWeekly(db.client, await crank(), FRIDAY)).toBe("sent");
    expect(rows("profit_advisor_runs")[0]).toMatchObject({ status: "sent", attempts: 2 });
  });

  it("one weekly text per ISO week, even if the day is moved mid-week", async () => {
    expect(await runCompanyWeekly(db.client, await crank(), FRIDAY)).toBe("sent");
    (db.tables.companies[0] as Record<string, unknown>).ai_settings = { profit_advisor: { weekly: { day: 6 } } };
    expect(await runCompanyWeekly(db.client, await crank(), FRIDAY + DAY)).toBe("claimed_elsewhere");
    expect(sendSms).toHaveBeenCalledTimes(1);
    expect(["2026-10-16", "2026-10-12", "2026-10-18", "2026-01-01", "2027-01-01", "2026-12-31", "2021-01-03", "2021-01-04", "2024-12-30"].map(isoWeekKey)).toEqual([
      "2026-W42", "2026-W42", "2026-W42", "2026-W01", "2026-W53", "2026-W53", "2020-W53", "2021-W01", "2025-W01",
    ]);
  });
});

describe("review: free visits and deposits", () => {
  it("callback/warranty and prepaid plan visits aren't jobs or 'no price'; a callback's cost is reported on its own", async () => {
    const care = liveJob({ at: "2026-10-15T15:00:00.000Z", title: "Callback: leak", contact: "ct-smith", lines: [], labourMin: 120 });
    const careBooking = db.tables.bookings.find((b) => b.id === care)!;
    careBooking.quote_id = null;
    db.tables.care_case_bookings = [{ id: "ccb-1", organization_id: ORG, company_id: CO, case_id: "case-1", booking_id: care, kind: "callback" }];
    const plan = liveJob({ at: "2026-10-15T17:00:00.000Z", title: "Spring visit", contact: "ct-jones", lines: [], labourMin: 60 });
    Object.assign(db.tables.bookings.find((b) => b.id === plan)!, { quote_id: null, recurring_job_id: "rj-plan", occurrence_date: "2026-10-15" });
    db.tables.recurring_jobs.push({ id: "rj-plan", organization_id: ORG, company_id: CO, line_items: [] });
    db.tables.service_agreements.push({ id: "sa-p", organization_id: ORG, company_id: CO, recurring_job_id: "rj-plan", billing: "annual", term_start: "2026-05-01", term_end: "2027-04-30", activated_at: "2026-05-01T12:00:00Z", status: "active" });
    expect(await runCompanyWeekly(db.client, await crank(), FRIDAY)).toBe("sent");
    const body = texts()[0].body;
    expect(body).toMatch(/^CrankLeads: This week: 3 jobs done, \$2,489 billed, profit about \$1,109 \(45%\)\./);
    expect(body).toContain("1 free callback/warranty visit cost about $80.");
    expect(body).not.toContain("no price");
    const tool = await runOwnerTool(ownerState(FRIDAY), "profit", {});
    expect(tool).toMatchObject({ jobs_done: 3, plan_visits: 1 });
  });

  it("an online-booking deposit isn't counted twice: the job's expected money is net of it", async () => {
    db.tables.bookings.push({ id: "b-dep", organization_id: ORG, company_id: CO, title: "Eavestrough", contact_id: "ct-lee", status: "confirmed", scheduled_for: "2026-10-23T13:00:00Z", quote_id: null, price_cents: 40_000, deposit_cents: 10_000, deposit_invoice_id: "inv-dep", deposit_paid_at: null });
    db.tables.invoices.push({ id: "inv-dep", organization_id: ORG, company_id: CO, contact_id: "ct-lee", invoice_number: "INV-8", status: "sent", balance_due_cents: 10_000, total_cents: 10_000, due_date: "2026-10-16", issue_date: "2026-10-16", booking_id: null });
    const inp = await loadForecastInputs(db.client, await crank(), FRIDAY);
    expect(inp.jobs.find((j) => j.id === "b-dep")).toMatchObject({ expectedCents: 45_200 - 10_000 });
    expect(inp.openInvoices.map((i) => i.id)).toContain("inv-dep");
    // Paid already: still net of it (the money came in with the deposit).
    Object.assign(db.tables.bookings.find((b) => b.id === "b-dep")!, { deposit_paid_at: "2026-10-16T12:00:00Z" });
    db.tables.invoices = db.tables.invoices.filter((i) => i.id !== "inv-dep");
    expect((await loadForecastInputs(db.client, await crank(), FRIDAY)).jobs.find((j) => j.id === "b-dep")).toMatchObject({ expectedCents: 35_200 });
  });

  it("Fleet's rentals (rate_cents_per_day) are read", async () => {
    db.tables.rentals = [{ id: "r-1", organization_id: ORG, company_id: CO, item: "Mini-ex", vendor: "Sunbelt", out_at: "2026-10-15T12:00:00Z", due_back_at: "2026-10-20T21:00:00Z", returned_at: null, rate_cents_per_day: 38_000 }];
    expect((await loadForecastInputs(db.client, await crank(), FRIDAY)).rentals).toEqual([{ label: "Mini-ex (Sunbelt)", from: "2026-10-15", to: "2026-10-20", dailyCents: 38_000 }]);
  });
});

describe("review: HST in the forecast", () => {
  it("a running period is scaled with the days so far (today included), and not before a week of it", async () => {
    (db.tables.companies[0] as Record<string, unknown>).ai_settings = { tax_clerk: { hst: { registrant: true, frequency: "monthly" } } };
    db.tables.invoices.push({ id: "inv-oct", organization_id: ORG, company_id: CO, contact_id: null, invoice_number: "INV-9", status: "paid", issue_date: "2026-10-05", subtotal_cents: 238_462, tax_cents: 31_000, total_cents: 269_462, balance_due_cents: 0, credit_cents: 0, amount_paid_cents: 269_462, imported_at: null });
    db.tables.hst_periods = [];
    const inp = await loadForecastInputs(db.client, await crank(), FRIDAY);
    // Oct so far: $310 collected − $23.40 ITC (the deck receipt) = $286.60, over 16 of 31 days.
    expect(inp.hst).toEqual([{ label: "Oct HST (so far, scaled)", dueDate: "2026-11-30", cents: Math.round((28_660 * 31) / 16) }]);
    const early = await loadForecastInputs(db.client, await crank(), Date.parse("2026-10-03T16:00:00Z"));
    expect(early.hst).toEqual([]);
    expect(early.notes).toContain("Oct HST not included yet - too early in the period to tell.");
  });
});

describe("review: the profit tool matches the weekly text; paused businesses", () => {
  it("'profit' right after the text covers the same 7 days", async () => {
    const w = lastWeeklyWindow(FRIDAY + 10 * 60_000, { day: 5, time: "15:00" }, TZ);
    expect(w).toEqual({ ...weekWindow("2026-10-16", "15:00", TZ), sendDate: "2026-10-16" });
    // Thursday: the window of last Friday's text.
    expect(lastWeeklyWindow(FRIDAY - DAY, { day: 5, time: "15:00" }, TZ).sendDate).toBe("2026-10-09");
    // Friday morning, before the text: last Friday's.
    expect(lastWeeklyWindow(Date.parse("2026-10-16T13:00:00Z"), { day: 5, time: "15:00" }, TZ).sendDate).toBe("2026-10-09");
  });

  it("owner tools refuse for a paused business", async () => {
    (db.tables.companies[0] as Record<string, unknown>).stage = "paused";
    expect(await runOwnerTool(ownerState(FRIDAY), "cash_forecast", {})).toMatchObject({ error: expect.stringContaining("paused or archived") });
  });
});
