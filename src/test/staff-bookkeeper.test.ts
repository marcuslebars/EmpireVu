/**
 * The AI Bookkeeper (docs/ai-staff.md → "Bookkeeper"): money formatting, settings defaults (on for
 * CrankLeads, off for house orgs like A1), the reminder schedule and send window, the sweep against
 * the fake DB (consent, quiet hours, idempotency), the approvals end to end through the owner
 * channel's decideApproval, the SMS-agent and owner tools, the daily money alert and the route.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "@/test/helpers/fake-supabase";

const h = vi.hoisted(() => ({ db: null as FakeDb | null, userId: "u-owner" }));
const sendSms = vi.fn((..._a: unknown[]) => Promise.resolve({ sid: `SM${Math.random().toString(36).slice(2, 8)}` }));
vi.mock("@/server/outbound/sms", () => ({ sendSms: (...a: unknown[]) => sendSms(...a) }));
vi.mock("@/server/outbound/email", () => ({ sendEmail: vi.fn(() => Promise.resolve({ id: "re_1" })) }));
vi.mock("@/server/services/usage", () => ({ recordUsageSafe: vi.fn(), recordAiUsageSafe: vi.fn() }));
vi.mock("@/server/services/invoices/pdf", () => ({ renderInvoicePdf: vi.fn(async () => new Uint8Array([1])), invoicePdfFilename: () => "x.pdf" }));
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

import { decideApproval, expireApproval } from "@/server/services/owner-channel/approvals";
import { newTurnEffects } from "@/server/services/sms-agent/tools";
import { bookkeeperRole } from "@/server/services/staff/bookkeeper";
import { buildInstalments } from "@/server/services/staff/bookkeeper/agent-tools";
import { agingSummary, bucketFor, cashSnapshot } from "@/server/services/staff/bookkeeper/ar";
import { reminderConsent } from "@/server/services/staff/bookkeeper/context";
import { composeMoneyAlert, missedInstalment, runDailyMoneyAlerts } from "@/server/services/staff/bookkeeper/daily-alert";
import { addMonths, dollarsToCents, inCustomerWindow, money, nextWindowLabel, ownerMoney } from "@/server/services/staff/bookkeeper/format";
import { isCollectionsHold } from "@/server/services/staff/bookkeeper/hold";
import { decideNextText, nextInstalmentToRemind, runReminderSweep } from "@/server/services/staff/bookkeeper/reminders";
import { bookkeeperActiveFor, loadActiveCompanies, mergeCollectionsSettings, readCollectionsSettings } from "@/server/services/staff/bookkeeper/settings";
import { isDateKey } from "@/server/services/staff/bookkeeper/format";
import { finalNoticeText, reminderText, toneForStep, type ReminderInput } from "@/server/services/staff/bookkeeper/texts";
import { checkConsent } from "@/server/services/workflow-engine/messaging";
import { GET, PATCH } from "@/app/api/organizations/[organizationId]/companies/[companyId]/ai-settings/collections/route";
import { emptyScorecardInputs } from "@/server/services/monthly-scorecard/metrics";
import { computeWeeklyMetrics, emptyFrontDeskInputs } from "@/server/services/weekly-report/metrics";
import { renderWeeklyEmail } from "@/server/templates/weekly-report";

const ORG = "11111111-1111-1111-1111-111111111111";
const CO = "22222222-2222-2222-2222-222222222222";
const JAMIE = "33333333-3333-3333-3333-333333333333";
const A1_ORG = "44444444-4444-4444-4444-444444444444";
const A1_CO = "55555555-5555-5555-5555-555555555555";
const A1_CONTACT = "66666666-6666-6666-6666-666666666666";
const OWNER = "+17055550142";
const JAMIE_PHONE = "+17055550123";
const A1_OWNER = "+17055550999";
const PLATFORM = "+17055550100";

// Tue Oct 13 2026, 10:00 in Toronto (EDT, UTC-4).
const TUE_10AM = "2026-10-13T14:00:00Z";

const tool = (name: string) => bookkeeperRole.agentTools.find((t) => t.name === name)! as unknown as { run: (s: unknown, i: unknown) => Promise<Record<string, unknown>> };
const ownerTool = (name: string) => bookkeeperRole.ownerTools.find((t) => t.tool.name === name)!;

function invoice(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "inv-1",
    organization_id: ORG,
    company_id: CO,
    contact_id: JAMIE,
    customer_account_id: null,
    quote_id: null,
    invoice_number: "INV-2026-0012",
    public_token: "tok-1",
    status: "sent",
    title: "Fall cleanup",
    total_cents: 124000,
    credit_cents: 0,
    amount_paid_cents: 0,
    pending_payment_cents: 0,
    balance_due_cents: 124000,
    issue_date: "2026-09-17",
    due_date: "2026-10-01",
    sent_at: "2026-09-17T14:00:00Z",
    paid_at: null,
    paid_notified_at: null,
    last_reminder_at: null,
    reminder_count: 0,
    reminders_paused: false,
    stripe_checkout_session_id: null,
    bill_to: { name: "Jamie Lee" },
    line_items: [],
    ...over,
  };
}

function seed(extra: Record<string, Array<Record<string, unknown>>> = {}) {
  sendSms.mockClear();
  const base: Record<string, Array<Record<string, unknown>>> = {
    organizations: [
      { id: ORG, platform_brand: "crankleads" },
      { id: A1_ORG, platform_brand: "empirevu" },
    ],
    companies: [
      {
        id: CO, organization_id: ORG, name: "Northshore Snow & Lawn", brand_from_name: null, timezone: "America/Toronto", owner_phone_e164: OWNER,
        // The Office manager's morning briefing (on by default for CrankLeads) would carry the 8am
        // alert instead (staff-office-manager.test.ts); these tests cover the standalone alert.
        owner_phone_verified_at: "2026-10-01T00:00:00Z", ai_settings: { office_manager: { enabled: false } }, quote_public_base_url: "https://pay.northshore.test", invoice_settings: null,
        updated_at: "2026-10-01T00:00:00Z",
      },
      {
        id: A1_CO, organization_id: A1_ORG, name: "A1 Marine Care", brand_from_name: null, timezone: "America/Toronto", owner_phone_e164: A1_OWNER,
        owner_phone_verified_at: "2026-10-01T00:00:00Z", ai_settings: {}, quote_public_base_url: null, invoice_settings: null, updated_at: "2026-10-01T00:00:00Z",
      },
    ],
    organization_memberships: [
      { organization_id: ORG, profile_id: "u-owner", role: "owner" },
      { organization_id: ORG, profile_id: "u-member", role: "member" },
    ],
    profiles: [{ id: "u-owner", full_name: "Dana Whitfield" }, { id: "u-member", full_name: "Sam Helper" }],
    contacts: [
      {
        id: JAMIE, organization_id: ORG, company_id: CO, first_name: "Jamie", last_name: "Lee", phone: JAMIE_PHONE, email: null,
        sms_opt_out_at: null, email_opt_out_at: null, sms_consent_at: "2026-09-10T00:00:00Z", consent_source: "inbound_sms",
      },
      {
        id: A1_CONTACT, organization_id: A1_ORG, company_id: A1_CO, first_name: "Pat", last_name: "Boater", phone: "+17055550777", email: null,
        sms_opt_out_at: null, email_opt_out_at: null, sms_consent_at: "2026-09-10T00:00:00Z", consent_source: "inbound_sms",
      },
    ],
    invoices: [invoice()],
    invoice_payments: [],
    invoice_events: [],
    invoice_collections: [],
    invoice_reminder_texts: [],
    payment_plans: [],
    money_alerts: [],
    money_alert_items: [],
    owner_approvals: [],
    message_log: [],
    sms_conversations: [],
    platform_sms_opt_outs: [],
    voice_numbers: [{ organization_id: ORG, company_id: CO, provider: "twilio", active: true, phone_e164: "+17055550111", mode: "missed_call_catcher" }],
    accounting_connections: [],
    accounting_sync_jobs: [],
    accounting_links: [],
    quotes: [],
  };
  for (const [k, v] of Object.entries(extra)) base[k] = v;
  const db = createFakeDb(base, {
    owner_approvals: [["company_id", "short_code"]],
    invoice_reminder_texts: [["invoice_id", "reminder_key"]],
    invoice_collections: [["invoice_id"]],
    money_alerts: [["company_id", "alert_date"]],
    money_alert_items: [["company_id", "item_key"]],
    payment_plans: [["approval_id"]],
  });
  db.onRpc((name, args) => {
    if (name === "refresh_invoice_balance") {
      const inv = db.tables.invoices.find((i) => i.id === args.p_invoice_id)!;
      const paid = db.tables.invoice_payments.filter((p) => p.invoice_id === inv.id && p.status === "succeeded").reduce((s, p) => s + Number(p.amount_cents), 0);
      inv.amount_paid_cents = paid;
      inv.balance_due_cents = Math.max(0, Number(inv.total_cents) - Number(inv.credit_cents) - paid);
      inv.status = inv.balance_due_cents === 0 ? "paid" : paid > 0 ? "partially_paid" : inv.status;
      return { data: [{ ...inv }], error: null };
    }
    if (name === "consume_rate_limit") return { data: true, error: null };
    return { data: [], error: null };
  });
  h.db = db;
  return db;
}

const at = (iso: string) => vi.setSystemTime(new Date(iso));
const smsTo = (phone: string) => sendSms.mock.calls.map((c) => c[0] as { to: string; body: string; from?: string }).filter((m) => m.to === phone);
const rows = (table: string) => h.db!.tables[table] as Array<Record<string, unknown>>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  at(TUE_10AM);
  process.env.TWILIO_FROM_NUMBER = PLATFORM;
  delete process.env.PLATFORM_SMS_NUMBER;
  sendSms.mockClear();
  h.userId = "u-owner";
  seed();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── Pure pieces ──────────────────────────────────────────────────────────────────

describe("money formatting", () => {
  it("customer money is always dollars and cents with separators; owner money drops .00", () => {
    expect(money(124000)).toBe("$1,240.00");
    expect(money(50)).toBe("$0.50");
    expect(money(0)).toBe("$0.00");
    expect(money(123456789)).toBe("$1,234,567.89");
    expect(money(-1200)).toBe("-$12.00");
    expect(money(40001)).toBe("$400.01");
    expect(ownerMoney(124000)).toBe("$1,240");
    expect(ownerMoney(124050)).toBe("$1,240.50");
    expect(ownerMoney(100000000)).toBe("$1,000,000");
  });

  it("parses dollar inputs to cents, refusing junk", () => {
    expect(dollarsToCents(500)).toBe(50000);
    expect(dollarsToCents("1,240.50")).toBe(124050);
    expect(dollarsToCents("$19.999")).toBe(2000);
    expect(dollarsToCents(0)).toBeNull();
    expect(dollarsToCents(-5)).toBeNull();
    expect(dollarsToCents("lots")).toBeNull();
  });
});

describe("settings", () => {
  it("default ON for CrankLeads, OFF for house orgs (A1) unless switched on", () => {
    expect(readCollectionsSettings({}, { doneForYou: true })).toMatchObject({ enabled: true, enabledIsDefault: true, textReminders: true, finalNotice: true, dailyAlert: true, reminderDays: [3, 10, 20, 30] });
    expect(readCollectionsSettings({}, { doneForYou: false })).toMatchObject({ enabled: false, enabledIsDefault: true });
    expect(readCollectionsSettings({ collections: { enabled: true } }, { doneForYou: false }).enabled).toBe(true);
    expect(readCollectionsSettings({ collections: { reminderDays: [30, 5, 5, 0, 500, 12] } }, { doneForYou: true }).reminderDays).toEqual([5, 12, 30]);
  });

  it("merge touches only ai_settings.collections", () => {
    const merged = mergeCollectionsSettings({ sms_agent: { enabled: true }, collections: { dailyAlert: false } }, { finalNotice: false, reminderDays: [2, 9] });
    expect(merged).toEqual({ sms_agent: { enabled: true }, collections: { dailyAlert: false, finalNotice: false, reminderDays: [2, 9] } });
  });
});

describe("send window and schedule", () => {
  it("customer texts go 09:00-20:00 local, Monday to Saturday", () => {
    const tz = "America/Toronto";
    expect(inCustomerWindow(Date.parse("2026-10-13T14:00:00Z"), tz)).toBe(true); // Tue 10:00
    expect(inCustomerWindow(Date.parse("2026-10-13T12:59:00Z"), tz)).toBe(false); // Tue 08:59
    expect(inCustomerWindow(Date.parse("2026-10-14T00:00:00Z"), tz)).toBe(false); // Tue 20:00
    expect(inCustomerWindow(Date.parse("2026-10-17T14:00:00Z"), tz)).toBe(true); // Sat 10:00
    expect(inCustomerWindow(Date.parse("2026-10-18T16:00:00Z"), tz)).toBe(false); // Sun 12:00
    expect(nextWindowLabel(Date.parse("2026-10-13T11:00:00Z"), tz)).toBe("9am today");
    expect(nextWindowLabel(Date.parse("2026-10-14T00:30:00Z"), tz)).toBe("9am tomorrow");
    expect(nextWindowLabel(Date.parse("2026-10-18T01:00:00Z"), tz)).toBe("9am Monday"); // Sat 21:00
  });

  const base = { reminderDays: [3, 10, 20, 30], smsCount: 0, lastSmsDay: null, lastReminderDay: null, today: "2026-10-13", holdUntil: null, finalNoticeStatus: "none" as const, finalNoticeEnabled: true };

  it("picks the step due, catching up to the latest one (never a backlog)", () => {
    expect(decideNextText({ ...base, daysOverdue: 0 })).toEqual({ action: "none", why: "not_overdue" });
    expect(decideNextText({ ...base, daysOverdue: 2 })).toEqual({ action: "none", why: "not_yet" });
    expect(decideNextText({ ...base, daysOverdue: 3 })).toEqual({ action: "text", step: 0, tone: "gentle" });
    expect(decideNextText({ ...base, daysOverdue: 40 })).toEqual({ action: "text", step: 3, tone: "last" });
    expect(decideNextText({ ...base, daysOverdue: 12, smsCount: 1, lastSmsDay: "2026-10-04" })).toEqual({ action: "text", step: 1, tone: "nudge" });
  });

  it("holds, same-day email, the 5-day gap, then the final notice a week after the last text", () => {
    expect(decideNextText({ ...base, daysOverdue: 12, holdUntil: "2026-10-16" }).action).toBe("none");
    expect(decideNextText({ ...base, daysOverdue: 12, holdUntil: "2026-10-12" }).action).toBe("text");
    expect(decideNextText({ ...base, daysOverdue: 12, lastReminderDay: "2026-10-13" })).toEqual({ action: "none", why: "reminded_today" });
    expect(decideNextText({ ...base, daysOverdue: 12, smsCount: 1, lastSmsDay: "2026-10-10" })).toEqual({ action: "none", why: "gap" });
    expect(decideNextText({ ...base, daysOverdue: 36, smsCount: 4, lastSmsDay: "2026-10-01" })).toEqual({ action: "none", why: "done" });
    expect(decideNextText({ ...base, daysOverdue: 37, smsCount: 4, lastSmsDay: "2026-10-01" })).toEqual({ action: "final_notice" });
    expect(decideNextText({ ...base, daysOverdue: 37, smsCount: 4, lastSmsDay: "2026-10-01", finalNoticeStatus: "skipped" }).action).toBe("none");
    expect(decideNextText({ ...base, daysOverdue: 37, smsCount: 4, lastSmsDay: "2026-10-01", finalNoticeEnabled: false }).action).toBe("none");
  });

  it("tone escalates gentle → firm; no text ever threatens anything", () => {
    expect([0, 1, 2, 3].map((i) => toneForStep(i, 4))).toEqual(["gentle", "nudge", "firm", "last"]);
    const input: ReminderInput = { businessName: "Northshore", firstName: "Jamie", invoiceNumber: "INV-1", owingCents: 124000, dueDate: "2026-10-01", daysOverdue: 12, link: "https://x.test/i/t" };
    const texts = [...(["gentle", "nudge", "firm", "last"] as const).map((t) => reminderText(input, t)), finalNoticeText({ ...input, daysOverdue: 37 }), reminderText({ ...input, daysOverdue: -3 }, "gentle")];
    for (const t of texts) {
      expect(t).toContain("Northshore");
      expect(t).toContain("https://x.test/i/t");
      expect(t).toContain("$1,240.00");
      expect(t).not.toMatch(/legal|lawyer|court|collection agency|credit (bureau|score)|late fee|interest|EmpireVu|CrankLeads/i);
      expect(t.length).toBeLessThanOrEqual(320);
    }
    expect(texts[0]).toMatch(/friendly reminder.*was due Oct 1/);
    expect(texts[3]).toMatch(/payment plan/);
    expect(texts[4]).toMatch(/final reminder from Northshore.*37 days past due/);
    expect(texts[5]).toMatch(/is due Oct 1/);
  });

  it("payment plans: equal payments, leftover cents on the last, months clamp", () => {
    expect(buildInstalments(120000, 3, "every_2_weeks", "2026-10-16")).toEqual([
      { n: 1, dueDate: "2026-10-16", amountCents: 40000 },
      { n: 2, dueDate: "2026-10-30", amountCents: 40000 },
      { n: 3, dueDate: "2026-11-13", amountCents: 40000 },
    ]);
    expect(buildInstalments(100001, 3, "monthly", "2027-01-31").map((i) => [i.dueDate, i.amountCents])).toEqual([
      ["2027-01-31", 33333],
      ["2027-02-28", 33333],
      ["2027-03-31", 33335],
    ]);
    expect(addMonths("2028-01-31", 1)).toBe("2028-02-29");
    const plan = { instalments: buildInstalments(120000, 3, "weekly", "2026-10-14"), starting_balance_cents: 120000 };
    expect(nextInstalmentToRemind(plan, 120000, "2026-10-13")?.n).toBe(1);
    expect(nextInstalmentToRemind(plan, 80000, "2026-10-20")?.n).toBe(2);
    expect(nextInstalmentToRemind(plan, 80000, "2026-10-18")).toBeNull();
    // A missed first payment doesn't silence the later ones.
    expect(nextInstalmentToRemind(plan, 120000, "2026-10-20")?.n).toBe(2);
    expect(nextInstalmentToRemind(plan, 120000, "2026-10-27")?.n).toBe(3);
    expect(missedInstalment(plan, 120000, "2026-10-17")?.n).toBe(1);
    expect(missedInstalment(plan, 80000, "2026-10-17")).toBeNull();
  });

  it("consent: an invoice is a business relationship dated when it went out; opt-out always wins", () => {
    const contact = { id: "c", organization_id: ORG, company_id: CO, first_name: null, last_name: null, phone: "+1", sms_opt_out_at: null, email_opt_out_at: null, sms_consent_at: null, consent_source: null };
    const now = Date.parse(TUE_10AM);
    expect(checkConsent(reminderConsent(contact, { sent_at: "2026-09-01T00:00:00Z", issue_date: null }), "sms", now).ok).toBe(true);
    expect(checkConsent(reminderConsent({ ...contact, sms_opt_out_at: "2026-10-01T00:00:00Z" }, { sent_at: "2026-09-01T00:00:00Z", issue_date: null }), "sms", now)).toEqual({ ok: false, reason: "opted_out" });
    expect(checkConsent(reminderConsent(contact, { sent_at: null, issue_date: null }), "sms", now)).toEqual({ ok: false, reason: "no_consent" });
  });
});

describe("aging and cash", () => {
  it("buckets by days late (0-30 includes not-yet-due) and ranks the top owing", () => {
    expect(bucketFor("2026-10-20", "2026-10-13")).toBe("0-30");
    expect(bucketFor("2026-09-13", "2026-10-13")).toBe("0-30");
    expect(bucketFor("2026-09-12", "2026-10-13")).toBe("31-60");
    expect(bucketFor("2026-07-01", "2026-10-13")).toBe("90+");
    const inv = (id: string, due: string, cents: number, extra: Record<string, unknown> = {}) => ({ ...invoice({ id, due_date: due, balance_due_cents: cents }), customer: id, ...extra }) as never;
    const s = agingSummary([inv("a", "2026-10-20", 10000), inv("b", "2026-09-01", 50000), inv("c", "2026-06-01", 20000), inv("d", "2026-08-01", 5000, { status: "paid" }), inv("e", "2026-10-01", 30000, { pending_payment_cents: 30000 })], "2026-10-13");
    expect(s.outstandingCents).toBe(80000);
    expect(s.overdueCents).toBe(70000);
    expect(s.overdueCount).toBe(2);
    expect(s.buckets["31-60"]).toEqual({ cents: 50000, count: 1 });
    expect(s.buckets["90+"]).toEqual({ cents: 20000, count: 1 });
    expect(s.top.map((l) => l.customer)).toEqual(["b", "c", "a"]);
  });

  it("collected this week (from local Monday) and month, plus deposits", () => {
    const snap = cashSnapshot(
      {
        payments: [
          { amount_cents: 10000, received_at: "2026-10-12T05:00:00Z", status: "succeeded" }, // Mon 01:00 local → this week
          { amount_cents: 20000, received_at: "2026-10-12T03:00:00Z", status: "succeeded" }, // Sun 23:00 local → last week, this month
          { amount_cents: 99900, received_at: "2026-10-05T12:00:00Z", status: "failed" },
          { amount_cents: 40000, received_at: "2026-09-30T12:00:00Z", status: "succeeded" },
        ],
        depositsPaid: [{ approved_deposit_cents: 5000, deposit_paid_at: "2026-10-13T13:00:00Z" }],
        depositsExpected: [{ approved_deposit_cents: 7500 }, { approved_deposit_cents: null }],
      },
      { outstandingCents: 1, overdueCents: 1, overdueCount: 1 },
      Date.parse(TUE_10AM),
      "America/Toronto",
    );
    expect(snap).toMatchObject({ collectedWeekCents: 15000, collectedMonthCents: 35000, depositsExpectedCents: 7500, depositsExpectedCount: 1, weekStart: "2026-10-12", monthStart: "2026-10-01" });
  });

  it("composes one short owner alert, grouped and capped", () => {
    const body = composeMoneyAlert(
      "Northshore",
      [
        { key: "a", kind: "overdue30", text: "Jamie Lee $1,240 (INV-12)" },
        { key: "b", kind: "payment_failed", text: "Sam $500 (INV-15)" },
        { key: "c", kind: "unsynced_payment", text: "a payment" },
        { key: "d", kind: "unsynced_payment", text: "a payment" },
      ],
      "quickbooks",
    )!;
    expect(body.split("\n")).toEqual(["Money check for Northshore:", "Payment failed: Sam $500 (INV-15).", "Now 30+ days overdue: Jamie Lee $1,240 (INV-12).", "2 payments are not in QuickBooks after a day.", 'Text "who owes me" for the full list.']);
    expect(composeMoneyAlert("x", [])).toBeNull();
  });
});

// ── The sweep against the fake DB ────────────────────────────────────────────────

describe("reminder text sweep", () => {
  it("texts the overdue customer once with the pay link, stamps the email schedule, and is idempotent", async () => {
    await Promise.all([runReminderSweep(h.db!.client, Date.now()), runReminderSweep(h.db!.client, Date.now())]);
    const texts = smsTo(JAMIE_PHONE);
    expect(texts).toHaveLength(1);
    expect(texts[0].body).toMatch(/^Hi Jamie, Northshore Snow & Lawn here\. Invoice INV-2026-0012 for \$1,240\.00 is now 12 days past due\. Please pay here: https:\/\/pay\.northshore\.test\/i\/tok-1/);
    expect(texts[0].from).toBe("+17055550111");
    expect(rows("invoice_reminder_texts")).toHaveLength(1);
    expect(rows("invoice_reminder_texts")[0]).toMatchObject({ reminder_key: "step:2", kind: "scheduled", status: "sent", balance_cents: 124000 });
    expect(rows("invoice_collections")[0]).toMatchObject({ invoice_id: "inv-1", sms_count: 2 });
    expect(rows("invoices")[0].last_reminder_at).toBe(new Date(TUE_10AM).toISOString());
    expect(rows("message_log").find((m) => m.to_addr === JAMIE_PHONE)).toMatchObject({ sent_by: "bookkeeper", status: "sent" });

    // Later the same day, and the next day (5-day gap): nothing more.
    at("2026-10-13T19:00:00Z");
    await runReminderSweep(h.db!.client, Date.now());
    at("2026-10-14T14:00:00Z");
    await runReminderSweep(h.db!.client, Date.now());
    expect(smsTo(JAMIE_PHONE)).toHaveLength(1);
    // Five days on, the next step.
    at("2026-10-21T14:00:00Z");
    await runReminderSweep(h.db!.client, Date.now());
    expect(smsTo(JAMIE_PHONE)).toHaveLength(2);
    expect(smsTo(JAMIE_PHONE)[1].body).toMatch(/20 days past due\. Please pay today/);
  });

  it("never before 9am, after 8pm or on a Sunday", async () => {
    for (const iso of ["2026-10-13T12:30:00Z", "2026-10-14T00:30:00Z", "2026-10-18T15:00:00Z"]) {
      at(iso);
      await runReminderSweep(h.db!.client, Date.now());
    }
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("respects opt-out, reminders paused, an email sent today, a promise, and the owner handling the customer", async () => {
    const cases: Array<() => void> = [
      () => (rows("contacts")[0].sms_opt_out_at = "2026-10-02T00:00:00Z"),
      () => (rows("invoices")[0].reminders_paused = true),
      () => (rows("invoices")[0].last_reminder_at = "2026-10-13T12:00:00Z"),
      () => rows("invoice_collections").push({ id: "col-1", organization_id: ORG, company_id: CO, invoice_id: "inv-1", sms_count: 0, final_notice_status: "none", hold_until: "2026-10-16", hold_reason: "promise", promise_status: "open", promise_date: "2026-10-16" }),
      () => rows("sms_conversations").push({ id: "conv-1", organization_id: ORG, company_id: CO, contact_id: JAMIE, state: "owner", owner_takeover_at: "2026-10-10T00:00:00Z" }),
    ];
    for (const apply of cases) {
      seed();
      apply();
      await runReminderSweep(h.db!.client, Date.now());
      expect(smsTo(JAMIE_PHONE)).toHaveLength(0);
    }
  });

  it("house orgs (A1) are off by default: no texts, no alerts", async () => {
    seed({
      invoices: [invoice({ id: "inv-a1", organization_id: A1_ORG, company_id: A1_CO, contact_id: A1_CONTACT, public_token: "tok-a1" })],
    });
    await runReminderSweep(h.db!.client, Date.now());
    at("2026-10-13T12:15:00Z");
    await runDailyMoneyAlerts(h.db!.client, Date.now());
    expect(sendSms).not.toHaveBeenCalled();
    expect(rows("money_alerts").filter((r) => r.company_id === A1_CO)).toHaveLength(0);
    // Switched on by the owner → it works for them too.
    rows("companies")[1].ai_settings = { collections: { enabled: true } };
    at(TUE_10AM);
    await runReminderSweep(h.db!.client, Date.now());
    expect(smsTo("+17055550777")).toHaveLength(1);
  });

  it("the email reminder sweep pauses for a Bookkeeper hold", async () => {
    rows("invoice_collections").push({ id: "col-1", organization_id: ORG, company_id: CO, invoice_id: "inv-1", hold_until: "2026-10-16" });
    expect(await isCollectionsHold(h.db!.client, ORG, "inv-1", "2026-10-13")).toBe(true);
    expect(await isCollectionsHold(h.db!.client, ORG, "inv-1", "2026-10-17")).toBe(false);
    expect(await isCollectionsHold(h.db!.client, ORG, "inv-other", "2026-10-13")).toBe(false);
    expect(await isCollectionsHold({ from: () => { throw new Error("no table"); } }, ORG, "inv-1", "2026-10-13")).toBe(false);
  });
});

// ── Approvals, end to end through the owner channel ─────────────────────────────

describe("final notice (collections_final_notice)", () => {
  function fortyDaysLate() {
    seed({
      invoices: [invoice({ due_date: "2026-09-03", issue_date: "2026-08-20", sent_at: "2026-08-20T14:00:00Z" })],
      invoice_collections: [{ id: "col-1", organization_id: ORG, company_id: CO, invoice_id: "inv-1", contact_id: JAMIE, sms_count: 4, last_sms_at: "2026-10-05T14:00:00Z", final_notice_status: "none", hold_until: null }],
    });
  }

  it("is proposed after the last text with the exact customer text; Y through decideApproval sends it", async () => {
    fortyDaysLate();
    await runReminderSweep(h.db!.client, Date.now());
    const approval = rows("owner_approvals")[0];
    expect(approval).toMatchObject({ kind: "collections_final_notice", status: "pending", requested_by: "bookkeeper", short_code: 1 });
    expect(approval.summary).toMatch(/^Final notice for Jamie Lee \(705-555-0123\): INV-2026-0012, \$1,240 owing, 40 days overdue, 4 reminder texts sent\. Y texts them exactly: "Hi Jamie, this is a final reminder from Northshore Snow & Lawn: invoice INV-2026-0012 for \$1,240\.00 is now 40 days past due\. Please pay here: https:\/\/pay\.northshore\.test\/i\/tok-1 or reply to arrange a payment plan\."$/);
    expect(String(approval.summary).length).toBeLessThanOrEqual(500);
    const ownerText = smsTo(OWNER);
    expect(ownerText).toHaveLength(1);
    expect(ownerText[0].from).toBe(PLATFORM);
    expect(ownerText[0].body).toMatch(/^CrankLeads: #1 Final notice for Jamie Lee.*Reply Y 1 to approve, N 1 to skip\.$/s);
    expect(smsTo(JAMIE_PHONE)).toHaveLength(0);
    expect(rows("invoice_collections")[0]).toMatchObject({ final_notice_status: "proposed", final_notice_approval_id: approval.id });

    // Not proposed twice.
    await runReminderSweep(h.db!.client, Date.now());
    expect(rows("owner_approvals")).toHaveLength(1);

    const out = await decideApproval(h.db!.client, String(approval.id), { approved: true, decidedVia: "sms", decidedBy: OWNER }, { organizationId: ORG });
    expect(out.outcome).toBe("done");
    expect(out.message).toBe("Sent the final notice to Jamie Lee.");
    expect(rows("owner_approvals")[0]).toMatchObject({ status: "executed" });
    const customer = smsTo(JAMIE_PHONE);
    expect(customer).toHaveLength(1);
    expect(customer[0].body.startsWith(String(approval.payload && (approval.payload as Record<string, unknown>).text))).toBe(true);
    expect(rows("invoice_collections")[0].final_notice_status).toBe("sent");
    expect(rows("invoice_reminder_texts")[0]).toMatchObject({ reminder_key: "final", kind: "final_notice", status: "sent" });

    // A second Y is "already", nothing re-sent.
    const again = await decideApproval(h.db!.client, String(approval.id), { approved: true, decidedVia: "app", decidedBy: "u-owner" });
    expect(again.outcome).toBe("already");
    expect(smsTo(JAMIE_PHONE)).toHaveLength(1);
  });

  it("approved in the evening → queued for 9am, sent by the next morning's sweep; N → skipped for good", async () => {
    fortyDaysLate();
    await runReminderSweep(h.db!.client, Date.now());
    const id = String(rows("owner_approvals")[0].id);
    at("2026-10-14T00:30:00Z"); // Tue 20:30
    const out = await decideApproval(h.db!.client, id, { approved: true, decidedVia: "sms", decidedBy: OWNER });
    expect(out.message).toBe("OK - the final notice goes to Jamie Lee at 9am tomorrow (customer texts go out 9am-8pm, Mon-Sat).");
    expect(rows("invoice_reminder_texts")[0]).toMatchObject({ status: "queued" });
    expect(smsTo(JAMIE_PHONE)).toHaveLength(0);
    at("2026-10-14T13:30:00Z"); // Wed 09:30
    await runReminderSweep(h.db!.client, Date.now());
    expect(smsTo(JAMIE_PHONE)).toHaveLength(1);
    expect(smsTo(JAMIE_PHONE)[0].body).toMatch(/final reminder/);

    fortyDaysLate();
    at(TUE_10AM);
    await runReminderSweep(h.db!.client, Date.now());
    const no = await decideApproval(h.db!.client, String(rows("owner_approvals")[0].id), { approved: false, decidedVia: "sms", decidedBy: OWNER });
    expect(no.message).toMatch(/no final notice for Jamie Lee/);
    expect(rows("invoice_collections")[0].final_notice_status).toBe("skipped");
    at("2026-10-20T14:00:00Z");
    await runReminderSweep(h.db!.client, Date.now());
    expect(smsTo(JAMIE_PHONE)).toHaveLength(0);
    expect(rows("owner_approvals")).toHaveLength(1);
  });

  it("a balance that changed since the owner OK'd it → nothing sent, owner told", async () => {
    fortyDaysLate();
    await runReminderSweep(h.db!.client, Date.now());
    const id = String(rows("owner_approvals")[0].id);
    rows("invoices")[0].balance_due_cents = 100000;
    rows("invoices")[0].status = "partially_paid";
    const out = await decideApproval(h.db!.client, id, { approved: true, decidedVia: "sms", decidedBy: OWNER });
    expect(out.result?.ok).toBe(false);
    expect(smsTo(JAMIE_PHONE)).toHaveLength(0);
    expect(smsTo(OWNER).some((m) => /balance changed to \$1,000/.test(m.body))).toBe(true);
  });
});

function turnState() {
  return {
    admin: h.db!.client,
    facts: { organizationId: ORG, companyId: CO, businessName: "Northshore Snow & Lawn", ownerFirstName: "Dana", timeZone: "America/Toronto", priceList: [] },
    settings: { enabled: true, autonomy: "standard", enabledIsDefault: true },
    contact: rows("contacts")[0],
    conversation: { id: "conv-1" },
    services: { now: () => new Date() },
    approvalDeps: {},
    effects: newTurnEffects(),
    customerText: "can I pay this off in 3 chunks?",
  };
}

describe("SMS agent tools", () => {
  it("my_invoices: this customer's balances, the pay link on request, amounts vouched for the reply guard", async () => {
    const state = turnState();
    const out = await tool("my_invoices").run(state, { send_link: true });
    expect(out).toMatchObject({ ok: true, total_owing: "$1,240.00", invoices: [{ invoice: "INV-2026-0012", owing: "$1,240.00", due: "Oct 1", days_past_due: 12, pay_link: "https://pay.northshore.test/i/tok-1" }] });
    expect(state.effects.links).toEqual(["https://pay.northshore.test/i/tok-1"]);
    expect(state.effects.allowedAmountsCents.has(124000)).toBe(true);
    // Off for a house org's assistant.
    const off = await tool("my_invoices").run({ ...turnState(), facts: { ...turnState().facts, organizationId: A1_ORG, companyId: A1_CO } }, {});
    expect(off.ok).toBe(false);
  });

  it("promise_to_pay: records the date and holds reminders (text and email) through it", async () => {
    expect((await tool("promise_to_pay").run(turnState(), { date: "2026-10-10" })).ok).toBe(false);
    expect((await tool("promise_to_pay").run(turnState(), { date: "2026-11-30" })).ok).toBe(false);
    const out = await tool("promise_to_pay").run(turnState(), { date: "2026-10-16" });
    expect(out).toMatchObject({ ok: true, recorded_for: ["INV-2026-0012"] });
    expect(rows("invoice_collections")[0]).toMatchObject({ hold_until: "2026-10-16", hold_reason: "promise", promise_status: "open", promise_date: "2026-10-16" });
    await runReminderSweep(h.db!.client, Date.now());
    expect(smsTo(JAMIE_PHONE)).toHaveLength(0);
    // The day after the promise, reminders resume.
    at("2026-10-17T14:00:00Z");
    await runReminderSweep(h.db!.client, Date.now());
    expect(smsTo(JAMIE_PHONE)).toHaveLength(1);
  });

  it("request_payment_plan → payment_plan approval → Y sets it up, texts the plan, then reminds before each payment", async () => {
    seed({ invoices: [invoice({ total_cents: 120000, balance_due_cents: 120000 })] });
    const state = turnState();
    const asked = await tool("request_payment_plan").run(state, { payments: 3, frequency: "every_2_weeks", first_payment_date: "2026-10-16" });
    expect(asked).toMatchObject({ ok: true, approval_requested: true, plan_asked_for: "3 payments of $400.00" });
    const approval = rows("owner_approvals")[0];
    expect(approval).toMatchObject({ kind: "payment_plan", contact_id: JAMIE, conversation_id: "conv-1" });
    expect(approval.summary).toBe(
      'Jamie Lee (705-555-0123) asks for a payment plan on INV-2026-0012 ($1,200.00 owing): 3 payments of $400.00 - Oct 16, Oct 30 and Nov 13. Y sets it up, texts them the plan and reminds them before each payment. Their text: "can I pay this off in 3 chunks?"',
    );
    expect(smsTo(OWNER)[0].body).toMatch(/Reply Y 1 to approve, N 1 to skip\.$/);
    // Asking again while it waits doesn't stack approvals.
    expect((await tool("request_payment_plan").run(turnState(), { payments: 3, frequency: "monthly" })).already_waiting).toBe(true);

    const out = await decideApproval(h.db!.client, String(approval.id), { approved: true, decidedVia: "sms", decidedBy: OWNER });
    expect(out.message).toBe("Set up Jamie Lee's plan: 3 payments of $400.00 (Oct 16, Oct 30 and Nov 13). Told them, and I'll remind them before each payment.");
    expect(rows("payment_plans")[0]).toMatchObject({ status: "active", total_cents: 120000, starting_balance_cents: 120000, approval_id: approval.id });
    expect(smsTo(JAMIE_PHONE)[0].body).toMatch(/^Hi Jamie, Dana OK'd your payment plan for invoice INV-2026-0012: 3 payments of \$400\.00, due Oct 16, Oct 30 and Nov 13\. We'll text a reminder before each one\. Pay here: https:\/\/pay\.northshore\.test\/i\/tok-1/);
    expect(rows("invoice_collections")[0]).toMatchObject({ hold_until: "2026-11-13", hold_reason: "payment_plan" });

    // Thu Oct 15: the day before the first payment.
    at("2026-10-15T14:00:00Z");
    await runReminderSweep(h.db!.client, Date.now());
    const jamie = smsTo(JAMIE_PHONE);
    expect(jamie).toHaveLength(2);
    expect(jamie[1].body).toMatch(/payment 1 of 3 on your plan \(\$400\.00\) is due Fri Oct 16/);
    await runReminderSweep(h.db!.client, Date.now());
    expect(smsTo(JAMIE_PHONE)).toHaveLength(2);
  });

  it("payment plan N → the customer hears the owner will be in touch and the conversation is the owner's; expiry → no customer text", async () => {
    seed({ invoices: [invoice({ total_cents: 120000, balance_due_cents: 120000 })] });
    await tool("request_payment_plan").run(turnState(), { payments: 2, frequency: "monthly" });
    const out = await decideApproval(h.db!.client, String(rows("owner_approvals")[0].id), { approved: false, ownerNote: null, decidedVia: "sms", decidedBy: OWNER });
    expect(out.message).toMatch(/told Jamie Lee you'll be in touch/);
    expect(smsTo(JAMIE_PHONE)[0].body).toBe("Hi Jamie, it's Northshore Snow & Lawn. Dana will be in touch with you directly about the payment. Thanks for your patience.\nReply STOP to opt out");
    expect(rows("sms_conversations")[0]).toMatchObject({ state: "owner" });
    expect(rows("payment_plans")).toHaveLength(0);

    seed({ invoices: [invoice({ total_cents: 120000, balance_due_cents: 120000 })] });
    await tool("request_payment_plan").run(turnState(), { payments: 2, frequency: "monthly" });
    const row = rows("owner_approvals")[0];
    const expired = await expireApproval(h.db!.client, row as never, Date.parse(String(row.expires_at)) + 1000);
    expect(expired.outcome).toBe("expired");
    expect(smsTo(JAMIE_PHONE)).toHaveLength(0);
    expect(rows("owner_approvals")[0].result).toMatchObject({ message: expect.stringMatching(/payment plan wasn't set up/) });
  });
});

function ownerState() {
  return { admin: h.db!.client, scope: { organizationId: ORG, companyId: CO, companyName: "Northshore Snow & Lawn", timeZone: "America/Toronto" }, ownerPhone: OWNER, nowMs: Date.now(), confirmation: null, actions: [] };
}

describe("owner tools", () => {
  it("record_offline_payment → record_payment approval asked inline → Y records it once", async () => {
    const out = await ownerTool("record_offline_payment").run(ownerState() as never, { customer: "jamie", amount: 500, method: "etransfer" });
    expect(out).toMatchObject({ ok: true, tell_owner: "#1 Record $500 e-Transfer from Jamie Lee on INV-2026-0012? $740 will still be owing. Reply Y 1 to record it, N 1 to skip." });
    expect(rows("owner_approvals")[0]).toMatchObject({ kind: "record_payment", notified_to: OWNER });
    expect(sendSms).not.toHaveBeenCalled(); // the agent's reply IS the question

    const res = await decideApproval(h.db!.client, String(rows("owner_approvals")[0].id), { approved: true, decidedVia: "sms", decidedBy: OWNER });
    expect(res.message).toBe("Recorded $500 e-Transfer from Jamie Lee on INV-2026-0012 - $740 still owing.");
    expect(rows("invoice_payments")).toHaveLength(1);
    expect(rows("invoice_payments")[0]).toMatchObject({ amount_cents: 50000, method: "etransfer", status: "succeeded", company_id: CO });
    expect(rows("invoices")[0]).toMatchObject({ balance_due_cents: 74000, status: "partially_paid" });

    // Executor retried for the same approval: no second payment.
    const { executeRecordPayment } = await import("@/server/services/staff/bookkeeper/approvals");
    const retry = await executeRecordPayment(h.db!.client, rows("owner_approvals")[0] as never, { approved: true, decidedVia: "sms", decidedBy: OWNER });
    expect(retry.message).toMatch(/Already recorded/);
    expect(rows("invoice_payments")).toHaveLength(1);
  });

  it("record_offline_payment refuses more than owing, and asks which invoice when several match", async () => {
    expect((await ownerTool("record_offline_payment").run(ownerState() as never, { customer: "jamie", amount: 5000, method: "cash" })).reason).toMatch(/more than the \$1,240 owing/);
    rows("invoices").push(invoice({ id: "inv-2", invoice_number: "INV-2026-0013", public_token: "tok-2" }));
    const out = await ownerTool("record_offline_payment").run(ownerState() as never, { customer: "Jamie Lee", amount: 50, method: "cash" });
    expect(out.reason).toMatch(/More than one/);
    expect((out.matches as unknown[]).length).toBe(2);
    expect(rows("owner_approvals")).toHaveLength(0);
  });

  it("remind_now → send_invoice_reminder with the exact text → Y sends it", async () => {
    const out = await ownerTool("remind_now").run(ownerState() as never, { invoice_number: "0012" });
    expect(out.tell_owner).toMatch(/^#1 Text Jamie Lee \(705-555-0123\) about INV-2026-0012 \(\$1,240, 12 days late\)\? They'll get exactly: "Hi Jamie, Northshore Snow & Lawn here\. Invoice INV-2026-0012 for \$1,240\.00 is now 12 days past due\./);
    expect(String(out.tell_owner).length).toBeLessThanOrEqual(470);
    const res = await decideApproval(h.db!.client, String(rows("owner_approvals")[0].id), { approved: true, decidedVia: "sms", decidedBy: OWNER });
    expect(res.message).toBe("Sent the reminder to Jamie Lee.");
    expect(smsTo(JAMIE_PHONE)).toHaveLength(1);
    expect(rows("invoice_reminder_texts")[0]).toMatchObject({ kind: "manual", status: "sent" });
  });

  it("who_owes_me and cash_snapshot; off for a house org", async () => {
    rows("invoices").push(invoice({ id: "inv-old", contact_id: null, invoice_number: "INV-2026-0001", due_date: "2026-07-01", balance_due_cents: 30000, bill_to: { name: "Bayview Marina" } }));
    rows("invoice_payments").push({ id: "p1", organization_id: ORG, company_id: CO, invoice_id: "x", amount_cents: 25000, status: "succeeded", received_at: "2026-10-12T15:00:00Z" });
    const owes = await ownerTool("who_owes_me").run(ownerState() as never, {});
    expect(owes).toMatchObject({ outstanding: "$1,540", overdue: "$1,540", overdue_invoices: 2, top_owing: [{ customer: "Jamie Lee", owing: "$1,240", days_late: 12 }, { customer: "Bayview Marina", owing: "$300", days_late: 104 }] });
    expect((owes.aging_days as Record<string, unknown>)["90+"]).toEqual({ owing: "$300", invoices: 1 });
    const cash = await ownerTool("cash_snapshot").run(ownerState() as never, {});
    expect(cash).toMatchObject({ collected_this_week: "$250", collected_this_month: "$250", outstanding: "$1,540" });
    const off = await ownerTool("who_owes_me").run({ ...ownerState(), scope: { ...ownerState().scope, organizationId: A1_ORG, companyId: A1_CO } } as never, {});
    expect(off.error).toMatch(/bookkeeper is off/);
  });
});

// ── Daily owner money alert ──────────────────────────────────────────────────────

describe("daily money alert", () => {
  const MORNING = "2026-10-13T12:15:00Z"; // Tue 08:15 Toronto

  function notable() {
    seed({
      invoices: [
        invoice({ id: "inv-30", invoice_number: "INV-30", due_date: "2026-09-12", public_token: "t30" }),
        invoice({ id: "inv-p", invoice_number: "INV-P", due_date: "2026-10-05", balance_due_cents: 30000, public_token: "tp" }),
        invoice({ id: "inv-paid", invoice_number: "INV-PAID", status: "paid", balance_due_cents: 0, paid_at: "2026-10-11T12:00:00Z", public_token: "tpaid" }),
      ],
      invoice_payments: [
        { id: "pay-f", organization_id: ORG, company_id: CO, invoice_id: "inv-30", amount_cents: 50000, method: "card", status: "failed", failure_reason: "card_declined", updated_at: "2026-10-13T11:00:00Z", created_at: "2026-10-13T11:00:00Z", received_at: "2026-10-13T11:00:00Z" },
        { id: "pay-r", organization_id: ORG, company_id: CO, invoice_id: "inv-30", amount_cents: 100, method: "cash", status: "failed", failure_reason: "Removed — recorded by mistake", updated_at: "2026-10-13T11:00:00Z", created_at: "2026-10-13T11:00:00Z", received_at: "2026-10-13T11:00:00Z" },
        { id: "pay-u", organization_id: ORG, company_id: CO, invoice_id: "inv-p", amount_cents: 1000, method: "cash", status: "succeeded", updated_at: "2026-10-10T11:00:00Z", created_at: "2026-10-10T11:00:00Z", received_at: "2026-10-10T11:00:00Z" },
      ],
      invoice_collections: [{ id: "col-p", organization_id: ORG, company_id: CO, invoice_id: "inv-p", promise_status: "open", promise_date: "2026-10-09", hold_until: "2026-10-09", hold_reason: "promise", sms_count: 0, final_notice_status: "none" }],
      accounting_connections: [{ organization_id: ORG, company_id: CO, provider: "quickbooks", status: "active", connected_at: "2026-09-01T00:00:00Z", sync_start_date: "2026-09-01" }],
      accounting_sync_jobs: [
        { id: "job-1", organization_id: ORG, company_id: CO, entity_type: "invoice", entity_id: "inv-30", status: "failed", attempts: 6 },
        { id: "job-2", organization_id: ORG, company_id: CO, entity_type: "invoice", entity_id: "inv-p", status: "pending", attempts: 1 },
      ],
    });
  }

  it("one 8am text with everything notable, once a day, never repeating an item", async () => {
    notable();
    at(MORNING);
    await Promise.all([runDailyMoneyAlerts(h.db!.client, Date.now()), runDailyMoneyAlerts(h.db!.client, Date.now())]);
    const owner = smsTo(OWNER);
    expect(owner).toHaveLength(1);
    expect(owner[0].from).toBe(PLATFORM);
    expect(owner[0].body.split("\n")).toEqual([
      "CrankLeads: Money check for Northshore Snow & Lawn:",
      "Payment failed: Jamie Lee $500 (INV-30).",
      "Missed promise to pay: Jamie Lee, $300 by Oct 9.",
      "Now 30+ days overdue: Jamie Lee $1,240 (INV-30).",
      "Not syncing to QuickBooks: INV-30. Check Settings > Accounting.",
      "1 payment is not in QuickBooks after a day.",
      "Marked paid with no payment recorded: INV-PAID.",
      'Text "who owes me" for the full list.',
    ]);
    expect(rows("invoice_collections")[0].promise_status).toBe("missed");
    expect(rows("money_alerts")).toHaveLength(1);
    expect(rows("money_alerts")[0]).toMatchObject({ status: "sent", alert_date: "2026-10-13" });

    // Later the same morning: claimed. Tomorrow: nothing new → no text.
    at("2026-10-13T14:00:00Z");
    await runDailyMoneyAlerts(h.db!.client, Date.now());
    at("2026-10-14T12:15:00Z");
    await runDailyMoneyAlerts(h.db!.client, Date.now());
    expect(smsTo(OWNER)).toHaveLength(1);
    expect(rows("money_alerts").find((r) => r.alert_date === "2026-10-14")).toMatchObject({ status: "skipped" });
  });

  it("defers to the Office manager's morning briefing on briefing days (it carries the items), and goes alone on other days", async () => {
    notable();
    rows("companies")[0].ai_settings = {}; // CrankLeads default: the briefing is on, Monday to Saturday
    at(MORNING); // Tuesday 08:15
    await runDailyMoneyAlerts(h.db!.client, Date.now());
    expect(smsTo(OWNER)).toHaveLength(0);
    expect(rows("money_alerts")).toHaveLength(0);
    expect(rows("money_alert_items")).toHaveLength(0);
    at("2026-10-18T12:15:00Z"); // Sunday 08:15: no briefing that day → the standalone alert
    await runDailyMoneyAlerts(h.db!.client, Date.now());
    expect(smsTo(OWNER)).toHaveLength(1);
    expect(smsTo(OWNER)[0].body).toContain("Money check for Northshore Snow & Lawn:");
  });

  it("leaves out overdue imported balances still on the import's hold, and lists them once released", async () => {
    seed({ invoices: [invoice({ id: "inv-imp", invoice_number: "INV-IMP", due_date: "2026-08-01", public_token: "timp", reminders_paused: true, import_hold: true })] });
    at(MORNING);
    await runDailyMoneyAlerts(h.db!.client, Date.now());
    expect(smsTo(OWNER)).toHaveLength(0);
    rows("invoices")[0].import_hold = false;
    at("2026-10-14T12:15:00Z");
    await runDailyMoneyAlerts(h.db!.client, Date.now());
    expect(smsTo(OWNER)).toHaveLength(1);
    expect(smsTo(OWNER)[0].body).toContain("Now 60+ days overdue: Jamie Lee $1,240 (INV-IMP).");
  });

  it("only between 8 and 11 local, and not when the alert is off or nothing is notable", async () => {
    notable();
    at("2026-10-13T11:30:00Z"); // 07:30
    await runDailyMoneyAlerts(h.db!.client, Date.now());
    at("2026-10-13T15:30:00Z"); // 11:30
    await runDailyMoneyAlerts(h.db!.client, Date.now());
    expect(sendSms).not.toHaveBeenCalled();
    rows("companies")[0].ai_settings = { collections: { dailyAlert: false } };
    at(MORNING);
    await runDailyMoneyAlerts(h.db!.client, Date.now());
    expect(sendSms).not.toHaveBeenCalled();
    seed();
    rows("invoices")[0].due_date = "2026-10-10";
    at(MORNING);
    await runDailyMoneyAlerts(h.db!.client, Date.now());
    expect(sendSms).not.toHaveBeenCalled();
  });
});

// ── Settings route ───────────────────────────────────────────────────────────────

describe("ai-settings/collections route", () => {
  const params = { params: { organizationId: ORG, companyId: CO } };
  const patch = (body: unknown) => new Request("http://localhost/x", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("GET shows the CrankLeads default and the email schedule it works around", async () => {
    const res = await GET(new Request("http://localhost/x"), params);
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data).toMatchObject({ settings: { enabled: true, enabledIsDefault: true, reminderDays: [3, 10, 20, 30] }, defaultEnabled: true, emailReminders: { enabled: true, days: [1, 7, 14] }, ownerPhoneOnFile: true });
    expect(data.stats).toMatchObject({ overdueCount: 1, overdueCents: 124000 });
  });

  it("PATCH (owner) merges only collections; members and unknown fields are refused", async () => {
    rows("companies")[0].ai_settings = { sms_agent: { enabled: true } };
    const res = await PATCH(patch({ textReminders: false, reminderDays: [5, 15] }), params);
    expect(res.status).toBe(200);
    expect(rows("companies")[0].ai_settings).toEqual({ sms_agent: { enabled: true }, collections: { textReminders: false, reminderDays: [5, 15] } });
    h.userId = "u-member";
    expect((await PATCH(patch({ enabled: false }), params)).status).toBe(403);
    h.userId = "u-owner";
    expect((await PATCH(patch({ enabled: false, lateFees: true }), params)).status).toBe(400);
    expect((await PATCH(patch({ reminderDays: [0] }), params)).status).toBe(400);
  });
});

// ── Weekly report AR line ─────────────────────────────────────────────────────────

describe("weekly report: what's still owed", () => {
  const range = { from: "2026-10-05T04:00:00.000Z", to: "2026-10-12T04:00:00.000Z" };
  const metrics = (openInvoices: Array<{ balanceCents: number; pendingCents: number; dueDate: string | null }>) =>
    computeWeeklyMetrics({ scorecard: emptyScorecardInputs(), frontDesk: { ...emptyFrontDeskInputs(), openInvoices }, range, weekStart: "2026-10-05", timeZone: "America/Toronto" });

  it("adds one line with the outstanding and overdue amounts as of the Monday", () => {
    const m = metrics([
      { balanceCents: 124000, pendingCents: 0, dueDate: "2026-10-01" },
      { balanceCents: 30000, pendingCents: 0, dueDate: "2026-10-12" },
      { balanceCents: 5000, pendingCents: 5000, dueDate: "2026-09-01" },
    ]);
    expect(m.receivable).toEqual({ outstandingCents: 154000, overdueCents: 124000, overdueCount: 1 });
    const email = renderWeeklyEmail(m, { companyName: "Northshore", platformBrand: "CrankLeads", reportUrl: "https://x.test/r" });
    expect(email.text).toMatch(/Still owed to you/);
    expect(email.text).toMatch(/\$1,240 overdue \(1 invoice\)/);
  });

  it("no line when nothing is owed (and older fixtures without the field are unchanged)", () => {
    expect(metrics([]).receivable).toBeUndefined();
    const email = renderWeeklyEmail(metrics([]), { companyName: "Northshore", platformBrand: "CrankLeads", reportUrl: "https://x.test/r" });
    expect(email.text).not.toMatch(/Still owed/);
  });
});

// ── Review fixes ──────────────────────────────────────────────────────────────────

describe("review fixes", () => {
  it("scans only companies with the Bookkeeper on, per company; house orgs are filtered at the query", async () => {
    expect((await loadActiveCompanies(h.db!.client)).map((c) => c.companyId)).toEqual([CO]);
    expect(await bookkeeperActiveFor(h.db!.client, { organizationId: ORG, companyId: CO })).toBe(true);
    expect(await bookkeeperActiveFor(h.db!.client, { organizationId: A1_ORG, companyId: A1_CO })).toBe(false);
    rows("invoices").push(invoice({ id: "inv-a1", organization_id: A1_ORG, company_id: A1_CO, contact_id: A1_CONTACT, public_token: "tok-a1" }));
    await runReminderSweep(h.db!.client, Date.now());
    const invoiceReads = h.db!.queries.filter((q) => q.table === "invoices" && q.op === "select" && q.filters.some((f) => f.column === "due_date"));
    expect(invoiceReads.length).toBeGreaterThan(0);
    for (const q of invoiceReads) expect(q.filters).toContainEqual({ kind: "eq", column: "company_id", value: CO });
    expect(smsTo("+17055550777")).toHaveLength(0);
    // Opted in → included; a CrankLeads company switched off → excluded.
    rows("companies")[1].ai_settings = { collections: { enabled: true } };
    rows("companies")[0].ai_settings = { collections: { enabled: false } };
    expect((await loadActiveCompanies(h.db!.client)).map((c) => c.companyId)).toEqual([A1_CO]);
    expect(await bookkeeperActiveFor(h.db!.client, { organizationId: ORG, companyId: CO })).toBe(false);
  });

  it("a failed read of the collections state skips the company this run (no text without its holds)", async () => {
    h.db!.failNext("invoice_collections", "select");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await runReminderSweep(h.db!.client, Date.now());
    err.mockRestore();
    expect(sendSms).not.toHaveBeenCalled();
    await runReminderSweep(h.db!.client, Date.now());
    expect(smsTo(JAMIE_PHONE)).toHaveLength(1);
  });

  it("a provider failure doesn't use up the step; the next step's day still texts", async () => {
    sendSms.mockImplementationOnce(() => Promise.reject(new Error("twilio 500")));
    await runReminderSweep(h.db!.client, Date.now());
    expect(rows("invoice_reminder_texts")[0]).toMatchObject({ reminder_key: "step:2", status: "failed" });
    expect(rows("invoice_collections")[0].sms_count ?? 0).toBe(0);
    at("2026-10-21T14:00:00Z");
    await runReminderSweep(h.db!.client, Date.now());
    expect(smsTo(JAMIE_PHONE).filter((m) => m.body.includes("20 days past due"))).toHaveLength(1);
    expect(rows("invoice_collections")[0].sms_count).toBe(3);
  });

  it("a final notice whose approval couldn't be created goes back to 'none' and is proposed next time", async () => {
    seed({
      invoices: [invoice({ due_date: "2026-09-03", issue_date: "2026-08-20", sent_at: "2026-08-20T14:00:00Z" })],
      invoice_collections: [{ id: "col-1", organization_id: ORG, company_id: CO, invoice_id: "inv-1", contact_id: JAMIE, sms_count: 4, last_sms_at: "2026-10-05T14:00:00Z", final_notice_status: "none", hold_until: null, final_notice_approval_id: null }],
    });
    h.db!.failNext("owner_approvals", "insert", { message: "db down" });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await runReminderSweep(h.db!.client, Date.now());
    err.mockRestore();
    expect(rows("invoice_collections")[0].final_notice_status).toBe("none");
    expect(rows("owner_approvals")).toHaveLength(0);
    await runReminderSweep(h.db!.client, Date.now());
    expect(rows("owner_approvals")).toHaveLength(1);
    expect(rows("invoice_collections")[0].final_notice_status).toBe("proposed");
  });

  it("promise_to_pay: real dates only, one promise per invoice, none after a missed one", async () => {
    expect(isDateKey("2026-02-30")).toBe(false);
    expect(isDateKey("2026-10-16")).toBe(true);
    expect((await tool("promise_to_pay").run(turnState(), { date: "2026-10-32" })).error).toMatch(/real date/);
    expect(rows("invoice_collections")).toHaveLength(0);
    expect((await tool("promise_to_pay").run(turnState(), { date: "2026-10-16" })).ok).toBe(true);
    const again = await tool("promise_to_pay").run(turnState(), { date: "2026-10-30" });
    expect(again).toMatchObject({ ok: false });
    expect(again.error).toMatch(/already promised to pay by Oct 16.*hand_off_to_owner/);
    expect(rows("invoice_collections")[0].hold_until).toBe("2026-10-16");
    // The date passes unpaid → a new promise is refused (the owner decides).
    at("2026-10-19T14:00:00Z");
    expect((await tool("promise_to_pay").run(turnState(), { date: "2026-10-23" })).error).toMatch(/date passed.*hand_off_to_owner/);
    expect(rows("invoice_collections")[0].hold_until).toBe("2026-10-16");
  });

  it("a payment plan that falls behind lifts its hold, so the normal reminders resume", async () => {
    seed({
      invoices: [invoice({ total_cents: 120000, balance_due_cents: 120000 })],
      payment_plans: [{
        id: "plan-1", organization_id: ORG, company_id: CO, invoice_id: "inv-1", contact_id: JAMIE, approval_id: null, status: "active",
        instalments: [{ n: 1, dueDate: "2026-10-05", amountCents: 40000 }, { n: 2, dueDate: "2026-10-19", amountCents: 40000 }, { n: 3, dueDate: "2026-11-02", amountCents: 40000 }],
        total_cents: 120000, starting_balance_cents: 120000, activated_at: "2026-10-01T00:00:00Z",
      }],
      invoice_collections: [{ id: "col-1", organization_id: ORG, company_id: CO, invoice_id: "inv-1", contact_id: JAMIE, sms_count: 0, final_notice_status: "none", hold_until: "2026-11-02", hold_reason: "payment_plan" }],
    });
    await runReminderSweep(h.db!.client, Date.now());
    expect(rows("invoice_collections")[0]).toMatchObject({ hold_until: null, hold_reason: null });
    expect(smsTo(JAMIE_PHONE)).toHaveLength(1);
    expect(smsTo(JAMIE_PHONE)[0].body).toMatch(/12 days past due/);
    // They catch up on payment 1 → back on track, the hold returns.
    rows("invoices")[0].balance_due_cents = 80000;
    rows("invoices")[0].status = "partially_paid";
    at("2026-10-14T14:00:00Z");
    await runReminderSweep(h.db!.client, Date.now());
    expect(rows("invoice_collections")[0]).toMatchObject({ hold_until: "2026-11-02", hold_reason: "payment_plan" });
  });

  it("a plan approved in the evening is texted to the customer at 9am, not at night", async () => {
    seed({ invoices: [invoice({ total_cents: 120000, balance_due_cents: 120000 })] });
    await tool("request_payment_plan").run(turnState(), { payments: 3, frequency: "monthly" });
    at("2026-10-14T00:30:00Z"); // Tue 20:30
    const out = await decideApproval(h.db!.client, String(rows("owner_approvals")[0].id), { approved: true, decidedVia: "sms", decidedBy: OWNER });
    expect(out.message).toMatch(/I'll text them the plan at 9am tomorrow/);
    expect(smsTo(JAMIE_PHONE)).toHaveLength(0);
    expect(rows("payment_plans")).toHaveLength(1);
    at("2026-10-14T13:15:00Z"); // Wed 09:15
    await runReminderSweep(h.db!.client, Date.now());
    expect(smsTo(JAMIE_PHONE)).toHaveLength(1);
    expect(smsTo(JAMIE_PHONE)[0].body).toMatch(/OK'd your payment plan/);
    expect(rows("invoice_reminder_texts")[0]).toMatchObject({ kind: "plan_notice", status: "sent" });
    // Not a reminder: the email schedule isn't touched.
    expect(rows("invoices")[0].last_reminder_at).toBeNull();
  });

  function missedPromise() {
    seed({
      invoices: [invoice({ id: "inv-p", invoice_number: "INV-P", due_date: "2026-10-05", balance_due_cents: 30000, public_token: "tp" })],
      invoice_collections: [{ id: "col-p", organization_id: ORG, company_id: CO, invoice_id: "inv-p", promise_status: "open", promise_date: "2026-10-09", hold_until: "2026-10-09", hold_reason: "promise", sms_count: 0, final_notice_status: "none" }],
    });
  }

  it("money alert: a failed read sends nothing and gives the day back for a later pass", async () => {
    missedPromise();
    at("2026-10-13T12:15:00Z");
    h.db!.failNext("money_alert_items", "select");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await runDailyMoneyAlerts(h.db!.client, Date.now());
    err.mockRestore();
    expect(sendSms).not.toHaveBeenCalled();
    expect(rows("money_alerts")).toHaveLength(0);
    expect(rows("invoice_collections")[0].promise_status).toBe("open");
    at("2026-10-13T13:15:00Z");
    await runDailyMoneyAlerts(h.db!.client, Date.now());
    expect(smsTo(OWNER)).toHaveLength(1);
    expect(rows("invoice_collections")[0].promise_status).toBe("missed");
  });

  it("money alert: a missed promise survives a failed send and is reported the next day", async () => {
    missedPromise();
    at("2026-10-13T12:15:00Z");
    sendSms.mockImplementationOnce(() => Promise.reject(new Error("twilio 500")));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await runDailyMoneyAlerts(h.db!.client, Date.now());
    err.mockRestore();
    expect(rows("money_alerts")[0]).toMatchObject({ status: "failed" });
    expect(rows("invoice_collections")[0].promise_status).toBe("open");
    expect(rows("money_alert_items")).toHaveLength(0);
    at("2026-10-14T12:15:00Z");
    await runDailyMoneyAlerts(h.db!.client, Date.now());
    // Two attempts: the failed one on Tuesday, then Wednesday's, which carries the missed promise.
    const attempts = smsTo(OWNER);
    expect(attempts).toHaveLength(2);
    expect(attempts[1].body).toMatch(/Missed promise to pay: Jamie Lee, \$300 by Oct 9/);
    expect(rows("money_alerts").find((r) => r.alert_date === "2026-10-14")).toMatchObject({ status: "sent" });
    expect(rows("invoice_collections")[0].promise_status).toBe("missed");
  });
});
