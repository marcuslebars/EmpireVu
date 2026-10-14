/**
 * Service plans (docs/ai-staff.md → "Service plans"), against the in-memory fake DB with real
 * services underneath (deliverMessage, notifyOwnerOfApproval, the owner channel's decideApproval,
 * recurring/service.ts createRecurringJob / generateVisits / clearUntouchedFutureVisits). Only the
 * outside world is faked: Twilio (sendSms), Resend, and — where a test needs money — the billing
 * seam (Stripe readiness, the term invoice, Checkout).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "@/test/helpers/fake-supabase";

const sendSms = vi.fn((..._a: unknown[]) => Promise.resolve({ sid: `SM${Math.random().toString(36).slice(2, 8)}` }));
const sendEmail = vi.fn((..._a: unknown[]) => Promise.resolve({ id: "re_1" }));
vi.mock("@/server/outbound/sms", () => ({ sendSms: (...a: unknown[]) => sendSms(...a) }));
vi.mock("@/server/outbound/email", () => ({ sendEmail: (...a: unknown[]) => sendEmail(...a) }));
vi.mock("@/server/services/usage", () => ({ recordUsageSafe: vi.fn(), recordAiUsageSafe: vi.fn() }));
vi.mock("@/server/services/push/activity", () => ({ notifyActivityEvent: vi.fn() }));
vi.mock("@/server/services/workflow-engine/dispatch", () => ({ emitActivityEventAndDispatch: vi.fn(() => Promise.resolve({ activityEvent: {}, workflowEventJob: null })) }));

import { replyInstruction } from "@/server/services/front-desk/approval-text";
import { pagesRewritePath } from "@/server/services/dfy/site-host";
import { decideApproval, expireApproval } from "@/server/services/owner-channel/approvals";
import { runOwnerTool, type ToolRunState } from "@/server/services/owner-channel/tools";
import { explicitDatesToGenerate, explicitVisitDates, generateVisits } from "@/server/services/recurring/service";
import { activeRolesFor, roleApprovalExecutor, roleOwnerTools, staffRoles } from "@/server/services/staff/registry";
import { servicePlansRole } from "@/server/services/staff/service-plans";
import { offerServicePlan } from "@/server/services/staff/service-plans/agent-tool";
import { defaultPlanDeps, lapseAgreement, namesFit, onPlanCheckoutCompleted, onPlanInvoicePayment, publicSignup, type PlanDeps } from "@/server/services/staff/service-plans/agreements";
import { PLAN_RENEWALS_KIND, PLAN_SIGNUP_KIND } from "@/server/services/staff/service-plans/approval-kinds";
import type { IssuedInvoice, PlanBillingDeps, TermInvoiceInput } from "@/server/services/staff/service-plans/billing";
import { briefingItems } from "@/server/services/staff/service-plans/briefing-items";
import { isPrepaidPlanVisit } from "@/server/services/staff/service-plans/prepaid";
import { parseSignupForm, planPage, plansListPage, renewalPage, renewFromPage, signUpForPlan } from "@/server/services/staff/service-plans/public";
import { addYearsYmd, nthWeekday, termEndFor, termVisitDates, visitName } from "@/server/services/staff/service-plans/schedule";
import { loadPlanCompany, mergeServicePlansSettings, readServicePlansSettings, servicePlansActiveFor, type PlanCompany } from "@/server/services/staff/service-plans/settings";
import { sweepHeadsUp, sweepPayments, sweepQueue, sweepRenewals } from "@/server/services/staff/service-plans/sweeps";
import { confirmationText, headsUpText, renewalsSummary, renewalText, signupSummary } from "@/server/services/staff/service-plans/texts";
import { getServicePlansView, runServicePlansAction } from "@/server/services/staff/service-plans/view";

const TZ = "America/Toronto";
const ORG = "11111111-1111-4111-8111-111111111111";
const CO = "22222222-2222-4222-8222-222222222222";
const HOUSE_ORG = "33333333-3333-4333-8333-333333333333";
const HOUSE_CO = "44444444-4444-4444-8444-444444444444";
const PLAN_VISIT = "55555555-5555-4555-8555-555555555551";
const PLAN_YEAR = "55555555-5555-4555-8555-555555555552";
const HOUSE_PLAN = "55555555-5555-4555-8555-555555555553";
const DANA = "66666666-6666-4666-8666-666666666661";
const BOB = "66666666-6666-4666-8666-666666666662";
const A1_SERIES = "77777777-7777-4777-8777-777777777771";
const OWNER = "+17055559999";
const BUSINESS_NUMBER = "+17055550111";
const DANA_PHONE = "+17055550123";
const DAY = 86_400_000;

// Mon Oct 12 2026, 10:00 in Toronto (EDT, UTC-4).
const NOW = Date.parse("2026-10-12T14:00:00Z");

let db: FakeDb;

const SITE_CONTENT = {
  version: 1, mode: "full", factsUsed: [], copySource: "template", copyNotes: [], edits: {}, settings: { showPrices: true }, generatedAt: "2026-10-01",
  facts: { name: "Northshore Lawn", phoneE164: BUSINESS_NUMBER, phoneDisplay: "705-555-0111", brand: "crankleads", primaryColor: "#1f4e79", accentColor: null, logoUrl: null, tradeId: "landscaping" },
  copy: { faqs: [], serviceBlurbs: {} },
};

function company(over: Record<string, unknown> = {}) {
  return {
    id: CO, organization_id: ORG, name: "Northshore Lawn", brand_from_name: null, timezone: TZ, ai_settings: {}, stage: "active",
    owner_phone_e164: OWNER, owner_phone_verified_at: "2026-10-01T00:00:00Z", invoice_settings: {}, stripe_connected_account_id: "acct_1", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
    ...over,
  };
}

function plan(over: Record<string, unknown> = {}) {
  return {
    id: PLAN_VISIT, organization_id: ORG, company_id: CO, name: "Spring + Fall Lawn Care", description: "Two visits a year.", price_cents: 9500, billing: "per_visit",
    visit_months: [5, 10], weekday: 2, week_of_month: 1, time_of_day: "09:00", duration_minutes: 90, included: ["Aerate the lawn", "Fertilize"], active: true,
    created_by: null, created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
    ...over,
  };
}

function contact(id: string, first: string, last: string, phone: string) {
  return { id, organization_id: ORG, company_id: CO, first_name: first, last_name: last, phone, phone_last10: phone.slice(-10), email: null, sms_opt_out_at: null, email_opt_out_at: null, sms_consent_at: "2026-06-01T00:00:00Z", consent_source: "implied_inquiry", metadata: {}, created_at: "2026-06-01T00:00:00Z" };
}

/** A1-style series nobody but its owner may touch, with an upcoming visit. */
const A1_SERIES_ROW = {
  id: A1_SERIES, organization_id: HOUSE_ORG, company_id: HOUSE_CO, contact_id: null, title: "Weekly dock check", description: null, location: null, duration_minutes: 60,
  frequency: "weekly", interval_count: 1, weekdays: [2], start_date: "2026-01-06", time_of_day: "09:00", ends_on: null, max_occurrences: null,
  crew_profile_ids: [], checklist_template_id: null, line_items: [], status: "active", generated_through: "2026-12-01", created_by: null,
};
const A1_VISIT = { id: "a1-visit", organization_id: HOUSE_ORG, company_id: HOUSE_CO, recurring_job_id: A1_SERIES, occurrence_date: "2026-10-20", scheduled_for: "2026-10-20T13:00:00Z", status: "confirmed", recurrence_exception: false, en_route_at: null, started_at: null };

function seed(): FakeDb {
  return createFakeDb(
    {
      organizations: [
        { id: ORG, platform_brand: "crankleads", name: "Northshore" },
        { id: HOUSE_ORG, platform_brand: "empirevu", name: "A1 Group" },
      ],
      companies: [company(), company({ id: HOUSE_CO, organization_id: HOUSE_ORG, name: "A1 Marine Care", owner_phone_e164: "+17055558888" })],
      service_plans: [plan(), plan({ id: PLAN_YEAR, name: "Lawn Care Plus", billing: "annual", price_cents: 42000 }), plan({ id: HOUSE_PLAN, organization_id: HOUSE_ORG, company_id: HOUSE_CO, name: "Dock Plan" })],
      service_agreements: [],
      service_plan_messages: [],
      service_plan_runs: [],
      recurring_jobs: [{ ...A1_SERIES_ROW }],
      bookings: [{ ...A1_VISIT }],
      booking_assignments: [],
      contacts: [contact(DANA, "Dana", "Jones", DANA_PHONE), contact(BOB, "Bob", "Smith", "+17055550456")],
      owner_approvals: [],
      message_log: [],
      sms_conversations: [],
      invoices: [],
      workflows: [],
      company_sites: [{ id: "site-1", organization_id: ORG, company_id: CO, slug: "northshore-lawn", status: "published", content: SITE_CONTENT }],
      voice_numbers: [{ organization_id: ORG, company_id: CO, provider: "twilio", active: true, phone_e164: BUSINESS_NUMBER, mode: "missed_call_catcher" }],
      platform_sms_opt_outs: [],
      activity_events: [],
      organization_memberships: [],
    },
    {
      owner_approvals: [["company_id", "short_code"]],
      service_plan_messages: [["company_id", "kind", "dedupe_key"]],
      service_plan_runs: [["company_id", "kind", "run_key"]],
      bookings: [["recurring_job_id", "occurrence_date"]],
    },
  );
}

const texts = () => sendSms.mock.calls.map((c) => c[0] as { to: string; body: string; from?: string });
const textsTo = (phone: string) => texts().filter((t) => t.to === phone);
const rows = (t: string) => (db.tables[t] ?? []) as Array<Record<string, unknown>>;
const agreements = () => rows("service_agreements");

/** Billing seam: Stripe ready or not, invoices written straight into the fake DB. */
function fakeBilling(opts: { stripe: boolean }): PlanBillingDeps & { issued: TermInvoiceInput[]; drafts: TermInvoiceInput[]; checkouts: string[] } {
  const issued: TermInvoiceInput[] = [];
  const drafts: TermInvoiceInput[] = [];
  const checkouts: string[] = [];
  let n = 0;
  return {
    issued,
    drafts,
    checkouts,
    draftTermInvoice: async (_admin, input) => {
      drafts.push(input);
      n += 1;
      const total = Math.round(input.priceCents * 1.13);
      const id = `inv-${n}`;
      db.tables.invoices.push({ id, organization_id: input.organizationId, company_id: input.companyId, contact_id: input.contactId, status: "draft", invoice_number: null, public_token: `${"cd".repeat(15)}${String(n).padStart(2, "0")}`, total_cents: total, balance_due_cents: total, pending_payment_cents: 0, amount_paid_cents: 0, reminders_paused: true });
      return { id, totalCents: total };
    },
    issueDraft: async (_admin, _org, invoiceId) => {
      const inv = rows("invoices").find((i) => i.id === invoiceId);
      if (inv && inv.status === "draft") Object.assign(inv, { status: "sent", invoice_number: `INV-${invoiceId}` });
    },
    planCheckoutUrl: async (_admin, input) => {
      checkouts.push(input.returnUrl);
      const inv = rows("invoices").find((i) => i.id === input.invoiceId);
      return inv?.status === "draft" ? `https://checkout.stripe.test/c/${input.invoiceId}` : null;
    },
    stripeReady: async () => opts.stripe,
    issueTermInvoice: async (_admin, input): Promise<IssuedInvoice> => {
      issued.push(input);
      n += 1;
      const token = `${"ab".repeat(15)}${String(n).padStart(2, "0")}`;
      const total = Math.round(input.priceCents * 1.13);
      const id = `inv-${n}`;
      db.tables.invoices.push({ id, organization_id: input.organizationId, company_id: input.companyId, contact_id: input.contactId, status: "sent", public_token: token, total_cents: total, balance_due_cents: total, pending_payment_cents: 0, amount_paid_cents: 0, reminders_paused: input.pauseReminders });
      return { id, token, totalCents: total, url: `https://pay.test/i/${token}` };
    },
    voidUnpaid: async (_admin, _org, invoiceId) => {
      const inv = rows("invoices").find((i) => i.id === invoiceId);
      if (inv) inv.status = "void";
      return true;
    },
  };
}

function depsWith(billing: PlanBillingDeps): PlanDeps {
  return { ...defaultPlanDeps, billing };
}

function payInvoice(id: string) {
  const inv = rows("invoices").find((i) => i.id === id)!;
  inv.status = inv.status === "draft" || inv.status === "void" ? inv.status : "paid";
  inv.amount_paid_cents = inv.total_cents;
  inv.balance_due_cents = 0;
}

/** The Connect webhook for OUR plan Checkout: issue the draft, record the payment, settle. */
async function stripePaid(invoiceId: string, deps: PlanDeps, nowMs = NOW + 60_000) {
  const agreement = agreements().find((a) => a.pending_invoice_id === invoiceId || ((a.invoice_ids as string[] | undefined) ?? []).includes(invoiceId))!;
  return onPlanCheckoutCompleted(db.client, { id: `cs_${invoiceId}`, metadata: { plan_agreement_id: String(agreement.id), invoice_id: invoiceId } }, "acct_1", async () => {
    payInvoice(invoiceId);
    return { outcome: "applied" };
  }, nowMs, deps);
}

async function crank(): Promise<PlanCompany> {
  return (await loadPlanCompany(db.client, ORG, CO)) as PlanCompany;
}

function ownerState(nowMs = NOW): ToolRunState {
  return { admin: db.client, scope: { organizationId: ORG, companyId: CO, companyName: "Northshore Lawn", timeZone: TZ }, ownerPhone: OWNER, nowMs, confirmation: null, actions: [] } as unknown as ToolRunState;
}

function signupParams(over: Record<string, string> = {}): URLSearchParams {
  return new URLSearchParams({ name: "Dana Jones", phone: "705-555-0123", email: "dana@example.com", address: "12 Bay St, Midland", smsConsent: "1", t: String(NOW - 60_000), ...over });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  sendSms.mockClear();
  sendEmail.mockClear();
  db = seed();
});

afterEach(() => {
  vi.useRealTimers();
});

/** A1's series and its visit are exactly as seeded. */
function expectA1Untouched() {
  expect(rows("recurring_jobs").find((r) => r.id === A1_SERIES)).toEqual(A1_SERIES_ROW);
  expect(rows("bookings").find((b) => b.id === "a1-visit")).toEqual(A1_VISIT);
}

// ── Pure ────────────────────────────────────────────────────────────────────

describe("schedule", () => {
  it("the Nth weekday of a month, and 12-month terms", () => {
    expect(nthWeekday(2027, 5, 2, 1)).toBe("2027-05-04");
    expect(nthWeekday(2027, 10, 2, 1)).toBe("2027-10-05");
    expect(nthWeekday(2026, 11, 1, 2)).toBe("2026-11-09");
    expect(termEndFor("2026-10-12")).toBe("2027-10-11");
    expect(addYearsYmd("2028-02-29", 1)).toBe("2029-02-28");
  });

  it("one visit per plan month per term; a month already passed this term waits for next year", () => {
    const s = { months: [5, 10], weekday: 2, week: 1 };
    expect(termVisitDates(s, "2026-10-12", "2027-10-11", "2026-10-15")).toEqual(["2027-05-04", "2027-10-05"]);
    expect(termVisitDates(s, "2026-04-01", "2027-03-31")).toEqual(["2026-05-05", "2026-10-06"]);
    // Too close to sign-up (inside the 3-day minimum) → that month waits until next term.
    expect(termVisitDates(s, "2026-05-03", "2027-05-02", "2026-05-06")).toEqual(["2026-10-06"]);
  });

  it("names a visit by season, or by month when the plan has two in one season", () => {
    expect(visitName("2027-05-04", [5, 10])).toBe("spring visit");
    expect(visitName("2027-10-05", [5, 10])).toBe("fall visit");
    expect(visitName("2027-06-01", [6, 7, 8])).toBe("June visit");
  });
});

describe("texts", () => {
  it("customer texts are short, plain and name the business", () => {
    expect(headsUpText({ firstName: "Dana", businessName: "Northshore Lawn", date: "2027-05-04", timeOfDay: "09:00", planMonths: [5, 10] })).toBe(
      "Hi Dana, it's Northshore Lawn. Your spring visit is booked for Tue May 4, morning. Reply to change.",
    );
    expect(confirmationText({ firstName: "Dana", businessName: "Northshore Lawn", planName: "Spring + Fall Lawn Care", firstVisit: "2027-05-04", timeOfDay: "13:30", planMonths: [5, 10] })).toBe(
      "Hi Dana, you're signed up for Spring + Fall Lawn Care with Northshore Lawn. Your spring visit is booked for Tue May 4, afternoon - we'll text you before each one. Questions? Just reply.",
    );
    expect(renewalText({ firstName: "Dana", businessName: "Northshore Lawn", planName: "Lawn Care Plus", billing: "annual", priceCents: 42000, renewsOn: "2026-11-01", nextVisit: "2027-05-04", planMonths: [5, 10], link: "https://x.test/r" })).toBe(
      "Hi Dana, it's Northshore Lawn. Your Lawn Care Plus plan renews Nov 1 ($420 + HST for the next year). Pay here to keep your spring visit: https://x.test/r",
    );
  });

  it("owner summaries: the sign-up and the renewal batch (folded to fit)", () => {
    expect(signupSummary({ customerName: "Dana Jones", customerPhone: DANA_PHONE, planName: "Spring + Fall Lawn Care", billing: "annual", priceCents: 42000, months: [5, 10], firstVisit: "2027-05-04" })).toBe(
      "New plan sign-up: Dana Jones (705-555-0123), Spring + Fall Lawn Care $420/yr (May + Oct). Y starts the plan, books the visits (first: Tue May 4) and texts them to confirm.",
    );
    const lines = Array.from({ length: 3 }, (_, i) => ({ name: ["Dana Jones", "Bob Smith", "Sam Lee"][i], renewsOn: "2026-11-01", priceCents: 42000, billing: "annual" as const, nextVisitName: "spring visit" }));
    expect(renewalsSummary(lines, 30)).toBe(
      "3 plans renew in the next 30 days ($1,260): Dana Jones Nov 1 $420/yr; Bob Smith Nov 1 $420/yr; Sam Lee Nov 1 $420/yr. Y texts each customer their renewal link (pay now to keep their spring visit).",
    );
    const many = Array.from({ length: 40 }, (_, i) => ({ name: `Customer Number${i}`, renewsOn: "2026-11-01", priceCents: 42000, billing: "annual" as const }));
    const folded = renewalsSummary(many, 30);
    expect(folded.length).toBeLessThanOrEqual(500);
    expect(folded).toMatch(/\+\d+ more\. Y texts each customer/);
  });

  it("reply lines for both kinds", () => {
    expect(replyInstruction(PLAN_SIGNUP_KIND, 12)).toBe("Reply Y 12 to start it, N 12 to skip.");
    expect(replyInstruction(PLAN_RENEWALS_KIND, 4)).toBe("Reply Y 4 to text them, N 4 to skip.");
  });
});

describe("settings and gating", () => {
  it("CrankLeads on by default; house orgs always off, whatever is stored", () => {
    expect(readServicePlansSettings({}, { crankleads: true })).toMatchObject({ enabled: true, headsUp: { enabled: true }, renewals: { enabled: true } });
    expect(readServicePlansSettings({ service_plans: { enabled: true } }, { crankleads: false }).enabled).toBe(false);
    expect(mergeServicePlansSettings({ sms_agent: { enabled: true } }, { renewals: { enabled: false } })).toEqual({ sms_agent: { enabled: true }, service_plans: { renewals: { enabled: false } } });
  });

  it("active only with an active plan, never for a house org", async () => {
    expect(await servicePlansActiveFor(db.client, { organizationId: ORG, companyId: CO })).toBe(true);
    expect(await servicePlansActiveFor(db.client, { organizationId: HOUSE_ORG, companyId: HOUSE_CO })).toBe(false);
    for (const p of rows("service_plans")) p.active = false;
    expect(await servicePlansActiveFor(db.client, { organizationId: ORG, companyId: CO })).toBe(false);
    const roles = await activeRolesFor(db.client, { organizationId: HOUSE_ORG, companyId: HOUSE_CO });
    expect(roles.map((r) => r.role)).not.toContain("service_plans");
  });

  it("registers its kinds, tools and sweeps", () => {
    expect(staffRoles()).toContain(servicePlansRole);
    expect(roleApprovalExecutor(PLAN_SIGNUP_KIND)).toBeTypeOf("function");
    expect(roleApprovalExecutor(PLAN_RENEWALS_KIND)).toBeTypeOf("function");
    expect(roleOwnerTools().map((t) => t.tool.name)).toEqual(expect.arrayContaining(["plans_summary", "enroll_customer"]));
    expect(servicePlansRole.agentTools.map((t) => t.name)).toEqual(["offer_service_plan"]);
    expect(servicePlansRole.sweeps.map((s) => s.name)).toEqual(["service-plans:payments", "service-plans:renewals", "service-plans:heads-up", "service-plans:queue"]);
  });
});

// ── The recurring generator: explicit dates, rules unchanged ────────────────

describe("recurring series with explicit visit dates", () => {
  it("a series without visit_dates (A1's) still follows its rule; explicit dates book only those", async () => {
    expect(explicitVisitDates(A1_SERIES_ROW)).toBeNull();
    expect(explicitVisitDates({ visit_dates: ["2027-10-05", "2027-05-04", "2027-05-04"] })).toEqual(["2027-05-04", "2027-10-05"]);
    expect(explicitDatesToGenerate(["2027-05-04", "2027-10-05"], "2026-10-12")).toEqual({ dates: ["2027-05-04"], through: "2027-05-04" });
    expect(explicitDatesToGenerate(["2026-11-03", "2026-11-24", "2027-05-04"], "2026-10-12")).toEqual({ dates: ["2026-11-03", "2026-11-24"], through: "2026-12-11" });
    // The rule path is unchanged: A1's weekly series books every Tuesday in the horizon.
    const ctx = { organizationId: HOUSE_ORG, actorProfileId: null, supabase: db.client } as never;
    const created = await generateVisits(ctx, { ...A1_SERIES_ROW, generated_through: null } as never, new Date(NOW));
    expect(created.length).toBeGreaterThan(5);
    expect(rows("bookings").filter((b) => b.recurring_job_id === A1_SERIES).every((b) => new Date(String(b.scheduled_for)).getUTCDay() === 2)).toBe(true);
  });
});

// ── Public pages + sign-up ──────────────────────────────────────────────────

describe("public plans pages", () => {
  it("lists active plans; a house org or an unknown slug is the neutral 404", async () => {
    const list = await plansListPage(db.client, "northshore-lawn");
    expect(list.status).toBe(200);
    expect(list.html).toContain("Spring + Fall Lawn Care");
    expect(list.html).toContain("$95/visit + HST");
    expect(list.html).toContain("the first Tuesday of May, Oct, mornings");
    db.tables.company_sites.push({ id: "site-2", organization_id: HOUSE_ORG, company_id: HOUSE_CO, slug: "a1-marine", status: "published", content: SITE_CONTENT });
    expect((await plansListPage(db.client, "a1-marine")).status).toBe(404);
    expect((await plansListPage(db.client, "nope")).status).toBe(404);
    const page = await planPage(db.client, "northshore-lawn", PLAN_VISIT, depsWith(fakeBilling({ stripe: false })));
    expect(page.html).toContain("may text me about my service plan");
    expect(page.html).toContain("will confirm your plan and your first visit by text");
  });

  it("checks the form", () => {
    expect(parseSignupForm(signupParams())).toMatchObject({ form: { name: "Dana Jones", phone: DANA_PHONE, email: "dana@example.com", address: "12 Bay St, Midland", smsConsent: true } });
    expect(parseSignupForm(signupParams({ phone: "123" }))).toMatchObject({ error: expect.stringContaining("cell") });
    expect(parseSignupForm(signupParams({ address: "" }))).toMatchObject({ error: expect.stringContaining("address") });
  });

  it("pages-host rewrites for the plans pages", () => {
    const host = "pages.crankleads.com";
    expect(pagesRewritePath(host, "/northshore-lawn/plans", "https://pages.crankleads.com")).toBe("/s/northshore-lawn/plans");
    expect(pagesRewritePath(host, `/northshore-lawn/plans/${PLAN_VISIT}`, "https://pages.crankleads.com")).toBe(`/s/northshore-lawn/plans/${PLAN_VISIT}`);
    expect(pagesRewritePath(host, `/northshore-lawn/plans/renew/${"a".repeat(32)}`, "https://pages.crankleads.com")).toBe(`/s/northshore-lawn/plans/renew/${"a".repeat(32)}`);
    expect(pagesRewritePath(host, "/northshore-lawn/plans/renew/xyz", "https://pages.crankleads.com")).toBe("/s/_");
  });
});

describe("plan_signup end to end (per-visit plan) through decideApproval", () => {
  it("public sign-up → owner OK → plan starts, visits on the calendar, customer texted", async () => {
    const page = await signUpForPlan(db.client, { slug: "northshore-lawn", planId: PLAN_VISIT, params: signupParams(), nowMs: NOW });
    expect(page.status).toBe(200);
    expect(page.html).toContain("will confirm it");
    const [agreement] = agreements();
    expect(agreement).toMatchObject({ status: "pending_owner", contact_id: DANA, plan_name: "Spring + Fall Lawn Care", price_cents: 9500, billing: "per_visit", source: "public", service_address: "12 Bay St, Midland" });
    const approval = rows("owner_approvals")[0];
    expect(approval).toMatchObject({ kind: PLAN_SIGNUP_KIND, requested_by: "service_plans" });
    expect(approval.summary).toBe(
      "New plan sign-up: Dana Jones (705-555-0123), Spring + Fall Lawn Care $95/visit (May + Oct). Y starts the plan, books the visits (first: Tue May 4) and texts them to confirm. At 12 Bay St, Midland.",
    );
    // The owner was asked from the platform number.
    expect(textsTo(OWNER)[0].body).toContain("New plan sign-up: Dana Jones");
    expect(textsTo(OWNER)[0].body).toContain("Reply Y");
    // A second tap makes nothing new.
    await signUpForPlan(db.client, { slug: "northshore-lawn", planId: PLAN_VISIT, params: signupParams(), nowMs: NOW });
    expect(agreements()).toHaveLength(1);
    expect(rows("owner_approvals")).toHaveLength(1);

    sendSms.mockClear();
    const out = await decideApproval(db.client, String(approval.id), { approved: true, decidedVia: "sms", decidedBy: OWNER }, { organizationId: ORG, nowMs: NOW });
    expect(out.result?.ok).toBe(true);
    expect(out.message).toBe("Started Dana Jones on Spring + Fall Lawn Care: 2 visits booked, first Tue May 4. Texted them to confirm.");
    const started = agreements()[0];
    expect(started).toMatchObject({ status: "active", term_start: "2026-10-12", term_end: "2027-10-11", visit_dates: ["2027-05-04", "2027-10-05"] });
    const series = rows("recurring_jobs").find((r) => r.id === started.recurring_job_id)!;
    expect(series).toMatchObject({ company_id: CO, contact_id: DANA, title: "Spring + Fall Lawn Care", visit_dates: ["2027-05-04", "2027-10-05"], time_of_day: "09:00", duration_minutes: 90, line_items: [{ label: "Spring + Fall Lawn Care visit", quantity: 1, unitPriceCents: 9500 }] });
    const visits = rows("bookings").filter((b) => b.recurring_job_id === series.id);
    expect(visits.map((v) => v.occurrence_date)).toEqual(["2027-05-04"]); // the next one; the rest within 60 days later
    expect(visits[0].scheduled_for).toBe("2027-05-04T13:00:00.000Z");
    const msg = textsTo(DANA_PHONE)[0];
    expect(msg.from).toBe(BUSINESS_NUMBER);
    expect(msg.body).toContain("Hi Dana, you're signed up for Spring + Fall Lawn Care with Northshore Lawn. Your spring visit is booked for Tue May 4, morning");
    expect(rows("message_log").find((m) => m.to_addr === DANA_PHONE)?.sent_by).toBe("service_plans");

    // Idempotent: a second Y is "already", nothing new.
    const again = await decideApproval(db.client, String(approval.id), { approved: true, decidedVia: "sms", decidedBy: OWNER }, { organizationId: ORG, nowMs: NOW });
    expect(again.outcome).toBe("already");
    expect(rows("recurring_jobs")).toHaveLength(2);
    expectA1Untouched();
  });

  it("N cancels it and the customer is told the owner will be in touch", async () => {
    await signUpForPlan(db.client, { slug: "northshore-lawn", planId: PLAN_VISIT, params: signupParams(), nowMs: NOW });
    const approval = rows("owner_approvals")[0];
    sendSms.mockClear();
    const out = await decideApproval(db.client, String(approval.id), { approved: false, decidedVia: "sms", decidedBy: OWNER }, { organizationId: ORG, nowMs: NOW });
    expect(out.message).toBe("OK - Dana Jones isn't on Spring + Fall Lawn Care. I told them you'll be in touch.");
    expect(agreements()[0]).toMatchObject({ status: "cancelled", cancel_reason: "owner said no" });
    expect(textsTo(DANA_PHONE)[0].body).toContain("Hi Dana, thanks for signing up for Spring + Fall Lawn Care. Northshore Lawn will be in touch with you directly about it.");
    expect(rows("recurring_jobs")).toHaveLength(1);
  });

  it("expiry: closed, the customer told, the owner texted", async () => {
    await signUpForPlan(db.client, { slug: "northshore-lawn", planId: PLAN_VISIT, params: signupParams(), nowMs: NOW });
    const approval = rows("owner_approvals")[0];
    sendSms.mockClear();
    await expireApproval(db.client, approval as never, NOW + 49 * 3_600_000);
    expect(agreements()[0].status).toBe("cancelled");
    expect(textsTo(OWNER).some((t) => t.body.includes("No answer on #"))).toBe(true);
  });

  it("a note isn't acted on: the same question comes back under a new code", async () => {
    await signUpForPlan(db.client, { slug: "northshore-lawn", planId: PLAN_VISIT, params: signupParams(), nowMs: NOW });
    const approval = rows("owner_approvals")[0];
    const out = await decideApproval(db.client, String(approval.id), { approved: true, ownerNote: "but make it $80", decidedVia: "sms", decidedBy: OWNER }, { organizationId: ORG, nowMs: NOW });
    expect(out.result?.ok).toBe(false);
    expect(out.message).toMatch(/^Nothing done yet - #\d+ starts the plan exactly as shown .* Reply Y \d+ to start it, N \d+ to skip\.$/);
    expect(agreements()[0].status).toBe("pending_owner");
    expect(agreements()[0].approval_id).toBe(rows("owner_approvals")[1].id);
  });
});

describe("annual plan paid online", () => {
  it("sign-up → our Checkout on a DRAFT invoice → the webhook issues it, records the payment, starts the plan", async () => {
    const billing = fakeBilling({ stripe: true });
    const deps = depsWith(billing);
    const page = await signUpForPlan(db.client, { slug: "northshore-lawn", planId: PLAN_YEAR, params: signupParams(), nowMs: NOW }, deps);
    expect(page.status).toBe(303);
    expect(page.redirect).toBe("https://checkout.stripe.test/c/inv-1");
    expect(billing.checkouts[0]).toBe(`http://localhost:3000/s/northshore-lawn/plans/${PLAN_YEAR}`);
    expect(billing.issued).toHaveLength(0); // nothing issued (no number, no invoice.sent, no owner copy) until it's paid
    expect(billing.drafts[0]).toMatchObject({ priceCents: 42000, lineLabel: "Lawn Care Plus - service plan, 12 months" });
    expect(rows("invoices")[0]).toMatchObject({ status: "draft", invoice_number: null, reminders_paused: true });
    const [pending] = agreements();
    expect(pending).toMatchObject({ status: "pending_payment", pending_invoice_id: "inv-1", invoice_ids: ["inv-1"] });
    expect(rows("owner_approvals")).toHaveLength(0);
    // Not paid yet: nothing starts.
    expect((await sweepPayments(db.client, NOW, deps)).settled).toBe(0);
    // Back from Checkout before the webhook: a neutral thank-you.
    expect((await planPage(db.client, "northshore-lawn", PLAN_YEAR, deps, { paid: true })).html).toContain("Thanks - you're signed up!");
    sendSms.mockClear();
    await stripePaid("inv-1", deps);
    expect(rows("invoices")[0]).toMatchObject({ status: "paid", invoice_number: "INV-inv-1", amount_paid_cents: 47460 });
    expect(agreements()[0]).toMatchObject({ status: "active", pending_invoice_id: null, invoice_ids: ["inv-1"] });
    const series = rows("recurring_jobs").find((r) => r.id === agreements()[0].recurring_job_id)!;
    expect(series.line_items).toEqual([]); // prepaid: visits carry no price
    // Dana is a matched customer (name fits) with no address on file: the typed address waits for the owner.
    expect(series.location).toBeNull();
    expect(textsTo(OWNER)[0].body).toBe("Everdoer: New plan: Dana Jones signed up for Lawn Care Plus and paid $474.60 online. First visit Tue May 4 is on the calendar.");
    expect(textsTo(DANA_PHONE)[0].body).toContain("you're signed up for Lawn Care Plus");
    // Retries are idempotent (webhook again, the hook, the sweep).
    await stripePaid("inv-1", deps, NOW + 120_000);
    await onPlanInvoicePayment(db.client, "inv-1", NOW + 120_000);
    await sweepPayments(db.client, NOW + 180_000, deps);
    expect(rows("recurring_jobs")).toHaveLength(2);
    expect(textsTo(DANA_PHONE)).toHaveLength(1);
  });

  it("paid, but the webhook couldn't issue the draft: the payments sweep issues it and starts the plan", async () => {
    const deps = depsWith(fakeBilling({ stripe: true }));
    await signUpForPlan(db.client, { slug: "northshore-lawn", planId: PLAN_YEAR, params: signupParams(), nowMs: NOW }, deps);
    payInvoice("inv-1"); // payment recorded on the still-draft invoice
    expect(rows("invoices")[0].status).toBe("draft");
    expect((await sweepPayments(db.client, NOW + 60_000, deps)).settled).toBe(1);
    expect(rows("invoices")[0].status).toBe("sent");
    expect(agreements()[0].status).toBe("active");
  });

  it("never paid → closed after 3 days, the draft voided (no invoice number used)", async () => {
    const deps = depsWith(fakeBilling({ stripe: true }));
    await signUpForPlan(db.client, { slug: "northshore-lawn", planId: PLAN_YEAR, params: signupParams(), nowMs: NOW }, deps);
    agreements()[0].created_at = new Date(NOW).toISOString();
    expect((await sweepPayments(db.client, NOW + 2 * DAY, deps)).abandoned).toBe(0);
    expect((await sweepPayments(db.client, NOW + 4 * DAY, deps)).abandoned).toBe(1);
    expect(agreements()[0]).toMatchObject({ status: "cancelled", cancel_reason: "never paid" });
    expect(rows("invoices")[0]).toMatchObject({ status: "void", invoice_number: null });
  });

  it("someone else's number: the owner is asked (never Checkout), shown both names; the typed address only after Y", async () => {
    const deps = depsWith(fakeBilling({ stripe: true }));
    expect(namesFit("Dana Jones", { first_name: "Dana", last_name: "Jones" })).toBe(true);
    expect(namesFit("dan", { first_name: "Dana", last_name: "Jones" })).toBe(true);
    expect(namesFit("Pat Lee", { first_name: "Dana", last_name: "Jones" })).toBe(false);
    const page = await signUpForPlan(db.client, { slug: "northshore-lawn", planId: PLAN_YEAR, params: signupParams({ name: "Pat Lee", address: "99 Other Rd, Midland" }), nowMs: NOW }, deps);
    expect(page.status).toBe(200);
    expect(page.html).toContain("will confirm it");
    const [agreement] = agreements();
    expect(agreement).toMatchObject({ status: "pending_owner", contact_id: DANA, customer_name: "Pat Lee" });
    const approval = rows("owner_approvals")[0];
    expect(approval.summary).toContain("New plan sign-up: signed up as Pat Lee, phone 705-555-0123 matches your customer Dana Jones - Lawn Care Plus $420/yr");
    expect(approval.summary).toContain("At 99 Other Rd, Midland.");
    // Dana's own details were not changed; the ticked box is kept only as evidence.
    const dana = rows("contacts").find((c) => c.id === DANA)!;
    expect(dana).toMatchObject({ first_name: "Dana", consent_source: "implied_inquiry", sms_consent_at: "2026-06-01T00:00:00Z" });
    expect((dana.metadata as Record<string, unknown>).plan_sms_consent).toMatchObject({ version: "plan-sms-v1", text: expect.stringContaining("may text me about my service plan") });
    expect(agreement.sms_consent_text).toMatch(/^plan-sms-v1: Yes, Northshore Lawn may text me/);
    // Y: the owner OK'd it, so the typed address goes on the calendar.
    const { executePlanSignup } = await import("@/server/services/staff/service-plans/approvals");
    db.tables.owner_approvals[0].status = "approved";
    await executePlanSignup(db.client, approval as never, { approved: true, decidedVia: "sms", decidedBy: OWNER }, deps, NOW);
    const series = rows("recurring_jobs").find((r) => r.id === agreements()[0].recurring_job_id)!;
    expect(series.location).toBe("99 Other Rd, Midland");
    // Signing up again with that number: the same neutral page, nothing revealed, nothing new.
    const again = await signUpForPlan(db.client, { slug: "northshore-lawn", planId: PLAN_YEAR, params: signupParams({ name: "Someone Else" }), nowMs: NOW }, deps);
    expect(again.html).toContain("will confirm it");
    expect(agreements()).toHaveLength(1);
    expect(rows("owner_approvals")).toHaveLength(1);
  });

  it("no online payments → the owner is asked, Y sends the first-year invoice", async () => {
    const billing = fakeBilling({ stripe: false });
    const deps = depsWith(billing);
    const r = await publicSignup(db.client, await crank(), rows("service_plans").find((p) => p.id === PLAN_YEAR) as never, { name: "Dana Jones", phone: DANA_PHONE, email: null, address: "12 Bay St", smsConsent: false }, NOW, deps);
    expect(r.kind).toBe("requested");
    const approval = rows("owner_approvals")[0];
    expect(approval.summary).toContain("Y starts the plan, books the visits (first: Tue May 4), sends their first-year invoice and texts them to confirm.");
    const { executePlanSignup } = await import("@/server/services/staff/service-plans/approvals");
    db.tables.owner_approvals[0].status = "approved";
    const out = await executePlanSignup(db.client, approval as never, { approved: true, decidedVia: "sms", decidedBy: OWNER }, deps, NOW);
    expect(out.message).toBe("Started Dana Jones on Lawn Care Plus: 2 visits booked, first Tue May 4. Texted them to confirm with their invoice ($474.60).");
    expect(billing.issued[0]).toMatchObject({ pauseReminders: false, dueDate: "2026-10-26" });
    // The owner said Y: the typed address is used.
    expect(rows("recurring_jobs").find((r) => r.id === agreements()[0].recurring_job_id)?.location).toBe("12 Bay St");
    expect(textsTo(DANA_PHONE)[0].body).toContain("Your invoice for the year ($474.60) is here: https://pay.test/i/");
  });
});

// ── Owner tools ─────────────────────────────────────────────────────────────

describe("owner tools", () => {
  it("enroll_customer asks inline; Y through decideApproval starts the plan", async () => {
    const out = (await runOwnerTool(ownerState(), "enroll_customer", { customer: "bob smith", plan: "spring fall" })) as Record<string, unknown>;
    expect(out.ok).toBe(true);
    expect(out.tell_owner_exactly).toMatch(/^#\d+ Sign Bob Smith \(705-555-0456\) up for Spring \+ Fall Lawn Care \$95\/visit \(May \+ Oct\)\. Y starts the plan, books the visits \(first: Tue May 4\) and texts them to confirm\. Reply Y \d+ to start it, N \d+ to skip\.$/);
    const approval = rows("owner_approvals")[0];
    expect(approval.notified_to).toBe(OWNER);
    const decided = await decideApproval(db.client, String(approval.id), { approved: true, decidedVia: "sms", decidedBy: OWNER }, { organizationId: ORG, nowMs: NOW });
    expect(decided.message).toContain("Started Bob Smith on Spring + Fall Lawn Care");
    // Already on it → refused.
    const again = (await runOwnerTool(ownerState(), "enroll_customer", { customer: "Bob Smith", plan: "Spring + Fall Lawn Care" })) as Record<string, unknown>;
    expect(again.reason).toBe("Bob Smith is already on Spring + Fall Lawn Care.");
    // Two plans match "lawn" → asks which.
    const ambiguous = (await runOwnerTool(ownerState(), "enroll_customer", { customer: "Dana", plan: "lawn" })) as Record<string, unknown>;
    expect(ambiguous.reason).toContain("More than one plan");
  });

  it("plans_summary", async () => {
    await runOwnerTool(ownerState(), "enroll_customer", { customer: "bob smith", plan: "spring fall" });
    const out = (await runOwnerTool(ownerState(), "plans_summary", {})) as Record<string, unknown>;
    expect(out).toMatchObject({ ok: true, sign_up_page: "http://localhost:3000/s/northshore-lawn/plans", active_customers: 0, waiting_sign_ups: [{ customer: '"Bob Smith"', plan: "Spring + Fall Lawn Care", waiting_on: "your OK" }] });
  });
});

// ── Renewals ────────────────────────────────────────────────────────────────

/** Dana on a plan whose term ends `endsIn` days from NOW, with its series and visits. */
async function activeAgreement(planId: string, termEnd: string, nowMs = NOW) {
  const deps = depsWith(fakeBilling({ stripe: false }));
  const p = rows("service_plans").find((x) => x.id === planId)!;
  const c = await crank();
  const { createAgreement, startAgreement } = await import("@/server/services/staff/service-plans/agreements");
  const { agreement } = await createAgreement(db.client, c, { plan: p as never, contactId: DANA, status: "pending_owner", source: "settings" }, nowMs);
  // Started a year back, so the term ends on `termEnd`.
  const start = new Date(Date.parse(`${termEnd}T12:00:00Z`) - 364 * DAY).getTime();
  await startAgreement(db.client, c, agreement, { nowMs: start, from: ["pending_owner"] }, deps);
  const row = agreements().find((a) => a.id === agreement.id)!;
  row.term_end = termEnd;
  sendSms.mockClear();
  return row;
}

describe("plan_renewals end to end through decideApproval", () => {
  it("Monday batch → Y texts each customer their own renewal link → per-visit kept on the page → renewed", async () => {
    const row = await activeAgreement(PLAN_VISIT, "2026-10-31");
    const out = await sweepRenewals(db.client, NOW);
    expect(out.batches).toBe(1);
    const approval = rows("owner_approvals").find((a) => a.kind === PLAN_RENEWALS_KIND)!;
    expect(approval.summary).toBe("1 plan renews in the next 30 days: Dana Jones Nov 1 $95/visit. Y texts each customer their renewal link (pay now to keep their spring visit).");
    // Once a week only.
    expect((await sweepRenewals(db.client, NOW + 3_600_000)).batches).toBe(0);

    sendSms.mockClear();
    const decided = await decideApproval(db.client, String(approval.id), { approved: true, decidedVia: "sms", decidedBy: OWNER }, { organizationId: ORG, nowMs: NOW });
    expect(decided.message).toBe("Texted 1 customer their renewal link.");
    const due = agreements().find((a) => a.id === row.id)!;
    expect(due).toMatchObject({ status: "renewal_due", renewal_price_cents: 9500 });
    const token = String(due.renewal_token);
    expect(token).toMatch(/^[a-f0-9]{32}$/);
    expect(textsTo(DANA_PHONE)[0].body).toContain(`Hi Dana, it's Northshore Lawn. Your Spring + Fall Lawn Care plan renews Nov 1 ($95 + HST a visit). Tap here to keep your spring visit: http://localhost:3000/s/northshore-lawn/plans/renew/${token}`);
    // The next term's visits are on the series ("keep your spring visit").
    const series = rows("recurring_jobs").find((r) => r.id === due.recurring_job_id)!;
    expect(series.visit_dates).toEqual(expect.arrayContaining(["2027-05-04", "2027-10-05"]));

    const page = await renewalPage(db.client, "northshore-lawn", token);
    expect(page.html).toContain("Keep my plan for another year");
    sendSms.mockClear();
    const kept = await renewFromPage(db.client, { slug: "northshore-lawn", token, nowMs: NOW }, depsWith(fakeBilling({ stripe: false })));
    expect(kept.html).toContain("You're renewed, Dana!");
    const old = agreements().find((a) => a.id === row.id)!;
    expect(old.status).toBe("renewed");
    const next = agreements().find((a) => a.previous_agreement_id === row.id)!;
    expect(next).toMatchObject({ status: "active", term_start: "2026-11-01", term_end: "2027-10-31", recurring_job_id: row.recurring_job_id, source: "renewal" });
    expect(textsTo(DANA_PHONE)[0].body).toContain("Thanks Dana - your Spring + Fall Lawn Care plan with Northshore Lawn is renewed through Oct 31, 2027.");
    expectA1Untouched();
  });

  it("annual: Y → the renewal page → Checkout → paid → renewed with the next term", async () => {
    const billing = fakeBilling({ stripe: true });
    const deps = depsWith(billing);
    const row = await activeAgreement(PLAN_YEAR, "2026-10-31");
    await sweepRenewals(db.client, NOW, deps);
    const approval = rows("owner_approvals").find((a) => a.kind === PLAN_RENEWALS_KIND)!;
    expect(approval.summary).toContain("($420)");
    await decideApproval(db.client, String(approval.id), { approved: true, decidedVia: "sms", decidedBy: OWNER }, { organizationId: ORG, nowMs: NOW });
    const token = String(agreements().find((a) => a.id === row.id)!.renewal_token);
    const go = await renewFromPage(db.client, { slug: "northshore-lawn", token, nowMs: NOW }, deps);
    expect(go.status).toBe(303);
    expect(go.redirect).toMatch(/^https:\/\/checkout\.stripe\.test\//);
    // A second tap reuses the same draft.
    await renewFromPage(db.client, { slug: "northshore-lawn", token, nowMs: NOW }, deps);
    expect(billing.drafts).toHaveLength(1);
    expect(billing.issued).toHaveLength(0);
    expect(billing.drafts[0]).toMatchObject({ priceCents: 42000, pauseReminders: true, dueDate: "2026-10-31" });
    expect(billing.checkouts[0]).toBe(`http://localhost:3000/s/northshore-lawn/plans/renew/${token}`);
    const invoiceId = String(agreements().find((a) => a.id === row.id)!.pending_invoice_id);
    sendSms.mockClear();
    await stripePaid(invoiceId, deps);
    expect(agreements().find((a) => a.id === row.id)!.status).toBe("renewed");
    const next = agreements().find((a) => a.previous_agreement_id === row.id)!;
    expect(next).toMatchObject({ status: "active", invoice_ids: [invoiceId], price_cents: 42000 });
    expect(textsTo(DANA_PHONE)[0].body).toContain("is renewed through Oct 31, 2027");
  });

  it("N: no texts, not asked again; expiry: asked again next week", async () => {
    await activeAgreement(PLAN_VISIT, "2026-10-31");
    await sweepRenewals(db.client, NOW);
    const first = rows("owner_approvals").find((a) => a.kind === PLAN_RENEWALS_KIND)!;
    await expireApproval(db.client, first as never, NOW + 7 * DAY);
    expect(agreements()[0].renewal_approval_id).toBeNull();
    sendSms.mockClear();
    expect((await sweepRenewals(db.client, NOW + 7 * DAY)).batches).toBe(1);
    const second = rows("owner_approvals").filter((a) => a.kind === PLAN_RENEWALS_KIND)[1];
    const no = await decideApproval(db.client, String(second.id), { approved: false, decidedVia: "sms", decidedBy: OWNER }, { organizationId: ORG, nowMs: NOW + 7 * DAY });
    expect(no.message).toBe("OK - no renewal texts. Those plans lapse 14 days after they end unless the customer pays you.");
    expect(textsTo(DANA_PHONE)).toHaveLength(0);
    expect(agreements()[0].renewal_declined_at).toBeTruthy();
  });

  it("approved at night: the texts wait for 9am (queue sweep)", async () => {
    await activeAgreement(PLAN_VISIT, "2026-10-31");
    await sweepRenewals(db.client, NOW);
    const approval = rows("owner_approvals").find((a) => a.kind === PLAN_RENEWALS_KIND)!;
    const night = Date.parse("2026-10-13T02:30:00Z"); // 22:30 EDT
    vi.setSystemTime(night); // executors run on the clock
    sendSms.mockClear();
    const out = await decideApproval(db.client, String(approval.id), { approved: true, decidedVia: "sms", decidedBy: OWNER }, { organizationId: ORG, nowMs: night });
    expect(out.message).toBe("Texted 1 customer their renewal link. They go out at 9am.");
    expect(textsTo(DANA_PHONE)).toHaveLength(0);
    expect(rows("service_plan_messages").find((m) => m.kind === "renewal")).toMatchObject({ kind: "renewal", status: "queued", not_before: "2026-10-13T13:00:00.000Z" });
    expect((await sweepQueue(db.client, Date.parse("2026-10-13T12:00:00Z"))).sent).toBe(0);
    expect((await sweepQueue(db.client, Date.parse("2026-10-13T13:05:00Z"))).sent).toBe(1);
    expect(textsTo(DANA_PHONE)[0].body).toContain("renews Nov 1");
  });
});

describe("lapse", () => {
  it("unpaid 14 days after the term: lapsed, only untouched later visits come off, the owner told; A1 untouched", async () => {
    const row = await activeAgreement(PLAN_VISIT, "2026-10-31");
    const series = String(row.recurring_job_id);
    row.status = "renewal_due";
    row.renewal_texted_at = new Date(NOW).toISOString();
    const seriesRow = rows("recurring_jobs").find((r) => r.id === series)!;
    seriesRow.visit_dates = [...(seriesRow.visit_dates as string[]), "2027-05-04"];
    const later = Date.parse("2026-11-16T14:00:00Z"); // Mon Nov 16, 09:00 EST
    db.tables.bookings.push(
      { id: "v-untouched", organization_id: ORG, company_id: CO, recurring_job_id: series, occurrence_date: "2026-12-01", scheduled_for: "2026-12-01T14:00:00Z", status: "confirmed", recurrence_exception: false, en_route_at: null, started_at: null },
      { id: "v-moved", organization_id: ORG, company_id: CO, recurring_job_id: series, occurrence_date: "2026-12-08", scheduled_for: "2026-12-09T14:00:00Z", status: "confirmed", recurrence_exception: true, en_route_at: null, started_at: null },
      { id: "v-done", organization_id: ORG, company_id: CO, recurring_job_id: series, occurrence_date: "2026-10-06", scheduled_for: "2026-10-06T13:00:00Z", status: "completed", recurrence_exception: false, en_route_at: null, started_at: "2026-10-06T13:00:00Z" },
    );
    sendSms.mockClear();
    const out = await sweepRenewals(db.client, later);
    expect(out.lapsed).toBe(1);
    expect(agreements().find((a) => a.id === row.id)).toMatchObject({ status: "lapsed" });
    const ids = rows("bookings").filter((b) => b.recurring_job_id === series).map((b) => b.id);
    expect(ids).toContain("v-moved");
    expect(ids).toContain("v-done");
    expect(ids).not.toContain("v-untouched");
    expect(rows("recurring_jobs").find((r) => r.id === series)).toMatchObject({ status: "ended" });
    expect(textsTo(OWNER)[0].body).toMatch(/^Everdoer: Dana Jones's Spring \+ Fall Lawn Care plan lapsed: the renewal wasn't paid by Nov 14, 2026\. I took \d+ upcoming visits? off the calendar\. If they pay in the next 60 days, I'll renew it\.$/);
    expectA1Untouched();
  });
});

describe("lapse safety", () => {
  /** An annual plan ending Oct 31 whose renewal link went out, with an ISSUED renewal invoice (no cards online). */
  async function renewalOut() {
    const billing = fakeBilling({ stripe: false });
    const deps = depsWith(billing);
    const row = await activeAgreement(PLAN_YEAR, "2026-10-31");
    Object.assign(row, { status: "renewal_due", renewal_texted_at: new Date(NOW).toISOString(), renewal_token: "e".repeat(32), renewal_price_cents: 42000 });
    const go = await renewFromPage(db.client, { slug: "northshore-lawn", token: "e".repeat(32), nowMs: NOW }, deps);
    expect(go.redirect).toMatch(/\/i\/[a-f0-9]{32}$/);
    const invoiceId = String(row.pending_invoice_id);
    expect(rows("invoices").find((i) => i.id === invoiceId)).toMatchObject({ status: "sent", reminders_paused: true });
    return { row, invoiceId, deps };
  }
  const day = (n: number) => Date.parse("2026-10-31T14:00:00Z") + n * DAY; // 10:00 EDT, n days after the term

  it("an e-Transfer recorded before the payments sweep ran: renewed, never lapsed", async () => {
    const { row, invoiceId, deps } = await renewalOut();
    payInvoice(invoiceId);
    sendSms.mockClear();
    const out = await sweepRenewals(db.client, day(16), deps);
    expect(out.lapsed).toBe(0);
    expect(agreements().find((a) => a.id === row.id)?.status).toBe("renewed");
    expect(textsTo(OWNER).some((t) => t.body.includes("lapsed"))).toBe(false);
  });

  it("a bank debit still clearing: not lapsed on grace day 13 or after it; renewed once it clears", async () => {
    const { row, invoiceId, deps } = await renewalOut();
    rows("invoices").find((i) => i.id === invoiceId)!.pending_payment_cents = 47460;
    expect((await sweepRenewals(db.client, day(13), deps)).lapsed).toBe(0);
    expect((await sweepRenewals(db.client, day(16), deps)).lapsed).toBe(0);
    expect(agreements().find((a) => a.id === row.id)?.status).toBe("renewal_due");
    const inv = rows("invoices").find((i) => i.id === invoiceId)!;
    inv.pending_payment_cents = 0;
    payInvoice(invoiceId);
    expect((await sweepPayments(db.client, day(17), deps)).settled).toBe(1);
    expect(agreements().find((a) => a.id === row.id)?.status).toBe("renewed");
  });

  it("paid after it lapsed: brought back (renewed, visits back on the calendar) and the owner told", async () => {
    const { row, invoiceId, deps } = await renewalOut();
    const series = String(row.recurring_job_id);
    expect((await sweepRenewals(db.client, day(16), deps)).lapsed).toBe(1);
    expect(rows("recurring_jobs").find((r) => r.id === series)?.status).toBe("ended");
    // The issued renewal invoice stays payable, and isn't "overdue".
    expect(rows("invoices").find((i) => i.id === invoiceId)?.status).toBe("sent");
    expect(agreements().find((a) => a.id === row.id)?.pending_invoice_id).toBe(invoiceId);
    payInvoice(invoiceId);
    sendSms.mockClear();
    expect((await sweepPayments(db.client, day(20), deps)).settled).toBe(1);
    expect(agreements().find((a) => a.id === row.id)?.status).toBe("renewed");
    const next = agreements().find((a) => a.previous_agreement_id === row.id)!;
    expect(next).toMatchObject({ status: "active", term_start: "2026-11-01", term_end: "2027-10-31" });
    expect(rows("recurring_jobs").find((r) => r.id === series)).toMatchObject({ status: "active" });
    expect(rows("bookings").some((b) => b.recurring_job_id === series && b.occurrence_date === "2027-05-04")).toBe(true);
    expect(textsTo(OWNER)[0].body).toBe("Everdoer: Dana Jones paid for Lawn Care Plus after it lapsed, so I renewed it and put their visits back on the calendar.");
    // Once only.
    await sweepPayments(db.client, day(21), deps);
    expect(textsTo(OWNER)).toHaveLength(1);
  });

  it("money for a cancelled plan isn't kept quietly: the owner is told once", async () => {
    const { row, invoiceId, deps } = await renewalOut();
    row.status = "cancelled";
    row.cancelled_at = new Date(NOW).toISOString();
    payInvoice(invoiceId);
    sendSms.mockClear();
    await sweepPayments(db.client, NOW + DAY, deps);
    await sweepPayments(db.client, NOW + 2 * DAY, deps);
    expect(textsTo(OWNER).map((t) => t.body)).toEqual(["Everdoer: Dana Jones paid $474.60 for Lawn Care Plus, but that plan is cancelled. Nothing was booked - restart it in Settings or refund them."]);
  });

  it("no renewal link ever went out (renewals off / the owner said no): no lapse, no \"wasn't paid\" text", async () => {
    db.tables.companies[0].ai_settings = { service_plans: { renewals: { enabled: false } } };
    const row = await activeAgreement(PLAN_VISIT, "2026-10-31");
    row.status = "renewal_due";
    expect((await sweepRenewals(db.client, day(20))).lapsed).toBe(0);
    expect((await lapseAgreement(db.client, await crank(), row as never, day(20))).reason).toBe("no renewal link sent");
    expect(textsTo(OWNER)).toHaveLength(0);
  });
});

describe("prepaid visits (job done → invoice)", () => {
  it("only a visit inside a started annual term counts; next term's and hand-moved post-lapse visits are invoiced; A1 always", async () => {
    const row = await activeAgreement(PLAN_YEAR, "2026-10-31"); // term 2025-11-01 .. 2026-10-31
    const series = String(row.recurring_job_id);
    expect(await isPrepaidPlanVisit(ORG, series, "2026-05-05", db.client)).toBe(true);
    expect(await isPrepaidPlanVisit(ORG, series, "2026-10-31T13:00:00Z", db.client)).toBe(true);
    // The renewal went out (next-term visits booked) but nobody paid yet.
    expect(await isPrepaidPlanVisit(ORG, series, "2027-05-04", db.client)).toBe(false);
    // Lapsed; a visit moved by hand to after the term survived the lapse.
    row.status = "lapsed";
    expect(await isPrepaidPlanVisit(ORG, series, "2026-12-09", db.client)).toBe(false);
    // A pending sign-up never started: nothing is prepaid.
    expect(await isPrepaidPlanVisit(ORG, series, null, db.client)).toBe(false);
    expect(await isPrepaidPlanVisit(HOUSE_ORG, A1_SERIES, "2026-10-20", db.client)).toBe(false);
  });
});

describe("double texts and consent", () => {
  it("no heads-up when the confirmation already named a visit within ~11 days", async () => {
    // Signed up Apr 27; the first visit (May 4, 7 days later) was in the confirmation.
    const start = Date.parse("2027-04-27T14:00:00Z");
    vi.setSystemTime(start);
    const deps = depsWith(fakeBilling({ stripe: false }));
    const { createAgreement, startAgreement } = await import("@/server/services/staff/service-plans/agreements");
    const c = await crank();
    const { agreement } = await createAgreement(db.client, c, { plan: rows("service_plans")[0] as never, contactId: DANA, status: "pending_owner", source: "settings" }, start);
    const started = await startAgreement(db.client, c, agreement, { nowMs: start, from: ["pending_owner"] }, deps);
    expect(started.firstVisit).toBe("2027-05-04");
    expect(textsTo(DANA_PHONE)[0].body).toContain("booked for Tue May 4");
    sendSms.mockClear();
    expect((await sweepHeadsUp(db.client, start + 60 * 60_000)).sent).toBe(0);
  });

  it("CASL: the purchase date only counts once the plan started", async () => {
    const { consentFor } = await import("@/server/services/staff/service-plans/messages");
    const contact = rows("contacts")[0] as never;
    expect(consentFor(contact, { activated_at: null })).not.toHaveProperty("last_purchase_at");
    expect(consentFor(contact, { activated_at: "2026-10-12T14:00:00Z" })).toMatchObject({ last_purchase_at: "2026-10-12T14:00:00Z" });
  });
});

// ── Visit heads-up ──────────────────────────────────────────────────────────

describe("visit heads-up", () => {
  it("one text ~10 days before a plan visit, never twice; quiet at night; skipped when an automation already texts that far ahead", async () => {
    await activeAgreement(PLAN_VISIT, "2027-10-11");
    const series = String(agreements()[0].recurring_job_id);
    // The series booked its next visit when the plan started.
    expect(rows("bookings").filter((b) => b.recurring_job_id === series).map((b) => b.scheduled_for)).toEqual(["2027-05-04T13:00:00.000Z"]);
    const night = Date.parse("2027-04-24T02:00:00Z"); // 22:00 EDT
    expect((await sweepHeadsUp(db.client, night)).sent).toBe(0);
    const morning = Date.parse("2027-04-24T14:00:00Z"); // 10:00 EDT, 9.96 days ahead
    expect((await sweepHeadsUp(db.client, morning)).sent).toBe(1);
    expect(textsTo(DANA_PHONE)[0].body).toContain("Hi Dana, it's Northshore Lawn. Your spring visit is booked for Tue May 4, morning. Reply to change.");
    expect(textsTo(DANA_PHONE)[0].from).toBe(BUSINESS_NUMBER);
    expect((await sweepHeadsUp(db.client, morning + 30 * 60_000)).sent).toBe(0);
    expect(textsTo(DANA_PHONE)).toHaveLength(1);

    db.tables.service_plan_messages = [];
    sendSms.mockClear();
    db.tables.workflows.push({ id: "wf", organization_id: ORG, company_id: null, trigger_event: "booking.upcoming", status: "active", definition: { schedule: { hours_before: 168 }, actions: [{ type: "send_sms" }] } });
    expect((await sweepHeadsUp(db.client, morning)).sent).toBe(0);
    // The default 24h reminder doesn't cover it.
    db.tables.workflows[0].definition = { schedule: { hours_before: 24 }, actions: [{ type: "send_sms" }] };
    expect((await sweepHeadsUp(db.client, morning)).sent).toBe(1);
  });

  it("switched off → nothing", async () => {
    await activeAgreement(PLAN_VISIT, "2027-10-11");
    db.tables.companies[0].ai_settings = { service_plans: { heads_up: { enabled: false } } };
    expect((await sweepHeadsUp(db.client, Date.parse("2027-04-24T14:00:00Z"))).sent).toBe(0);
  });
});

// ── SMS agent tool, briefing, Settings ──────────────────────────────────────

describe("offer_service_plan", () => {
  function turn(org: string, co: string) {
    return {
      admin: db.client,
      facts: { organizationId: org, companyId: co },
      effects: { links: [] as string[], allowedAmountsCents: new Set<number>() },
    } as never;
  }

  it("returns the active plans and adds the sign-up link; off for a house org", async () => {
    const state = turn(ORG, CO) as { effects: { links: string[]; allowedAmountsCents: Set<number> } };
    const out = (await offerServicePlan.run(state as never, {})) as Record<string, unknown>;
    expect(out.ok).toBe(true);
    expect((out.plans as Array<{ price: string }>).map((p) => p.price)).toEqual(["$95/visit + HST", "$420/yr + HST"]);
    expect(state.effects.links).toEqual(["http://localhost:3000/s/northshore-lawn/plans"]);
    expect(state.effects.allowedAmountsCents.has(42000)).toBe(true);
    const house = (await offerServicePlan.run(turn(HOUSE_ORG, HOUSE_CO), {})) as Record<string, unknown>;
    expect(house.ok).toBe(false);
  });
});

describe("briefing items", () => {
  it("unpaid renewals, with when they're due", async () => {
    expect(await briefingItems(db.client, { organizationId: ORG, companyId: CO }, "2026-10-12")).toEqual([]);
    db.tables.service_agreements.push(
      { id: "a1", organization_id: ORG, company_id: CO, status: "renewal_due", term_end: "2026-10-16", renewal_texted_at: "2026-10-05T14:00:00Z", renewed_by_agreement_id: null },
      { id: "a2", organization_id: ORG, company_id: CO, status: "renewal_due", term_end: "2026-10-30", renewal_texted_at: "2026-10-05T14:00:00Z", renewed_by_agreement_id: null },
    );
    expect(await briefingItems(db.client, { organizationId: ORG, companyId: CO }, "2026-10-12")).toEqual(["2 plan renewals unpaid (due Fri)"]);
    expect(await briefingItems(db.client, { organizationId: ORG, companyId: CO }, "2026-10-31")).toEqual(["2 plan renewals unpaid (due was Oct 16)", "1 plan lapses today if unpaid"]);
    expect(await briefingItems(db.client, { organizationId: HOUSE_ORG, companyId: HOUSE_CO }, "2026-10-12")).toEqual([]);
  });
});

describe("Settings", () => {
  it("the view, a new plan, an edit and a cancel (owners/admins); house orgs can't", async () => {
    const view = await getServicePlansView(db.client, ORG, CO, { manager: false, nowMs: NOW }, depsWith(fakeBilling({ stripe: true })));
    expect(view).toMatchObject({ available: true, stripeReady: true, plansUrl: "http://localhost:3000/s/northshore-lawn/plans", agreements: null });
    expect(view?.plans.map((p) => p.name)).toEqual(["Spring + Fall Lawn Care", "Lawn Care Plus"]);
    const created = await runServicePlansAction(db.client, ORG, CO, null, { action: "create_plan", plan: { name: "Gutter Care", priceCents: 18000, billing: "annual", months: [4, 11] } }, depsWith(fakeBilling({ stripe: false })), NOW);
    expect(created.message).toBe("Created Gutter Care.");
    const gutter = rows("service_plans").find((p) => p.name === "Gutter Care")!;
    expect(gutter).toMatchObject({ weekday: 1, week_of_month: 1, time_of_day: "09:00", visit_months: [4, 11], active: true });
    await runServicePlansAction(db.client, ORG, CO, null, { action: "update_plan", planId: String(gutter.id), plan: { active: false, priceCents: 20000 } }, depsWith(fakeBilling({ stripe: false })), NOW);
    expect(rows("service_plans").find((p) => p.id === gutter.id)).toMatchObject({ active: false, price_cents: 20000 });

    const row = await activeAgreement(PLAN_VISIT, "2027-10-11");
    const series = String(row.recurring_job_id);
    const cancelled = await runServicePlansAction(db.client, ORG, CO, null, { action: "cancel_agreement", agreementId: String(row.id) }, depsWith(fakeBilling({ stripe: false })), NOW);
    expect(cancelled.message).toMatch(/^Cancelled\./);
    expect(agreements().find((a) => a.id === row.id)?.status).toBe("cancelled");
    expect(rows("recurring_jobs").find((r) => r.id === series)?.status).toBe("ended");
    expect(rows("bookings").filter((b) => b.recurring_job_id === series && Date.parse(String(b.scheduled_for)) > NOW)).toHaveLength(0);
    expectA1Untouched();

    const house = await getServicePlansView(db.client, HOUSE_ORG, HOUSE_CO, { manager: true, nowMs: NOW });
    expect(house).toMatchObject({ available: false, plans: [], agreements: null });
    await expect(runServicePlansAction(db.client, HOUSE_ORG, HOUSE_CO, null, { action: "create_plan", plan: { name: "X Plan", priceCents: 1000, billing: "annual", months: [5] } })).rejects.toThrow("aren't available");
  });
});

describe("the real term invoice (invoices service)", () => {
  it("issues a numbered, HST-priced invoice with reminders paused, without emailing it", async () => {
    db.onRpc((name, args) => {
      if (name === "next_invoice_number") return { data: 1001, error: null };
      if (name === "refresh_invoice_balance") return { data: rows("invoices").filter((i) => i.id === args.p_invoice_id), error: null };
      return { data: [], error: null };
    });
    const { defaultPlanBillingDeps } = await import("@/server/services/staff/service-plans/billing");
    const issued = await defaultPlanBillingDeps.issueTermInvoice(db.client, {
      organizationId: ORG,
      companyId: CO,
      contactId: DANA,
      title: "Lawn Care Plus - service plan",
      lineLabel: "Lawn Care Plus - service plan, 12 months",
      lineDescription: "From Oct 12, 2026 to Oct 11, 2027.",
      priceCents: 42000,
      dueDate: "2026-10-12",
      pauseReminders: true,
      internalNote: "test",
    });
    const inv = rows("invoices").find((i) => i.id === issued.id)!;
    expect(inv).toMatchObject({ status: "sent", subtotal_cents: 42000, total_cents: 47460, reminders_paused: true, due_date: "2026-10-12" });
    expect(issued).toMatchObject({ totalCents: 47460, token: inv.public_token });
    expect(issued.url).toContain(`/i/${String(inv.public_token)}`);
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
