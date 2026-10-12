import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "@/test/helpers/fake-supabase";

// Hiring & payroll routes: Settings (GET members / PATCH owners+admins, merging ONLY
// ai_settings.recruiter), pay period lock/unlock + CSV download (owners/admins), and the public
// jobs pages + apply form (slug-scoped, bot checks).
const h = vi.hoisted(() => ({ db: null as FakeDb | null, role: "owner", limited: false, phoneLimited: false }));
const sendSms = vi.fn((..._a: unknown[]) => Promise.resolve({ sid: "SM1" }));
vi.mock("@/server/supabase/admin", () => ({ createSupabaseAdminClient: () => h.db?.client }));
vi.mock("@/server/supabase/server", () => ({ createSupabaseServerClient: () => h.db?.client }));
vi.mock("@/server/outbound/sms", () => ({ sendSms: (...a: unknown[]) => sendSms(...a) }));
vi.mock("@/server/outbound/email", () => ({ sendEmail: vi.fn(() => Promise.resolve({ id: "re_1" })) }));
vi.mock("@/server/services/usage", () => ({ recordUsageSafe: vi.fn(), recordAiUsageSafe: vi.fn() }));
vi.mock("@/server/services/workflow-engine/dispatch", () => ({ emitActivityEventAndDispatch: vi.fn(() => Promise.resolve({})) }));
vi.mock("@/server/organizations/context", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/organizations/context")>();
  return {
    ...original,
    requireOrganizationContext: async (_s: unknown, organizationId: string) => ({ organizationId, user: { id: "user-1" }, membership: { role: h.role } }),
  };
});

import { GET, PATCH } from "@/app/api/organizations/[organizationId]/companies/[companyId]/ai-settings/recruiter/route";
import { POST as PERIOD } from "@/app/api/organizations/[organizationId]/companies/[companyId]/payroll/periods/[periodId]/route";
import { GET as CSV } from "@/app/api/organizations/[organizationId]/companies/[companyId]/payroll/periods/[periodId]/csv/route";
import { GET as JOBS } from "@/app/s/[slug]/jobs/route";
import { GET as JOB, POST as APPLY } from "@/app/s/[slug]/jobs/[jobId]/route";

const ORG = "11111111-1111-4111-8111-111111111111";
const COMPANY = "22222222-2222-4222-8222-222222222222";
const OTHER = "66666666-6666-4666-8666-666666666666";
const PERIOD_ID = "55555555-5555-4555-8555-555555555555";
const JOB_ID = "7a000000-0000-4000-8000-000000000001";
const ctx = { params: { organizationId: ORG, companyId: COMPANY } };
const periodCtx = { params: { organizationId: ORG, companyId: COMPANY, periodId: PERIOD_ID } };

function seed(brand = "crankleads"): FakeDb {
  const db = createFakeDb({
    companies: [{ id: COMPANY, organization_id: ORG, name: "Northshore Roofing", timezone: "America/Toronto", stage: "active", ai_settings: { sms_agent: { autonomy: "ask_first" } }, owner_phone_e164: "+17055559999", owner_phone_verified_at: "2026-10-01T00:00:00Z", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" }],
    organizations: [{ id: ORG, platform_brand: brand }],
    organization_memberships: [{ organization_id: ORG, profile_id: "user-1", role: "owner" }],
    profiles: [{ id: "user-1", full_name: "Dana", email: "dana@x.test" }, { id: "mike", full_name: "Mike Dunn", email: "mike@x.test" }],
    member_pay_rates: [],
    time_entries: [{ id: "te-1", organization_id: ORG, company_id: COMPANY, booking_id: null, profile_id: "mike", started_at: "2026-09-29T12:00:00Z", ended_at: "2026-09-29T20:00:00Z", break_minutes: 0, created_at: "2026-09-29T12:00:00Z", updated_at: "2026-09-29T20:00:00Z" }],
    pay_periods: [{ id: PERIOD_ID, organization_id: ORG, company_id: COMPANY, frequency: "biweekly", start_date: "2026-09-28", end_date: "2026-10-11", starts_at: "2026-09-28T04:00:00.000Z", ends_at: "2026-10-12T04:00:00.000Z", status: "locked", csv_emailed_at: "2026-10-12T12:10:00Z" }],
    pay_period_events: [],
    job_postings: [{ id: JOB_ID, organization_id: ORG, company_id: COMPANY, title: "Labourer", pay_text: "$22/hr", duties: ["Carry shingles"], requirements: ["Lift 50 lbs"], nice_to_have: [], custom_questions: [], status: "open", created_at: "2026-10-10T00:00:00Z" }],
    job_applicants: [],
    contacts: [],
    sms_conversations: [],
    message_log: [],
    company_sites: [{ id: "s1", organization_id: ORG, company_id: COMPANY, slug: "northshore", status: "published", content: { version: 1, mode: "full", facts: { name: "Northshore Roofing", brand, tradeId: "roofing" }, copy: { faqs: [], serviceBlurbs: {} } } }],
    voice_numbers: [{ organization_id: ORG, company_id: COMPANY, provider: "twilio", active: true, phone_e164: "+17055550111", mode: "missed_call_catcher" }],
    platform_sms_opt_outs: [],
  });
  db.onRpc((_name, args) => ({ data: String(args.p_key).startsWith("job_apply_phone") ? !h.phoneLimited : !h.limited, error: null }));
  return db;
}

const patch = (body: unknown, companyId = COMPANY) => PATCH(new Request("http://x/api", { method: "PATCH", body: JSON.stringify(body) }), { params: { organizationId: ORG, companyId } });
const period = (body: unknown) => PERIOD(new Request("http://x/api", { method: "POST", body: JSON.stringify(body) }), periodCtx);

function applyRequest(fields: Record<string, string>): Request {
  return new Request(`http://x/s/northshore/jobs/${JOB_ID}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "203.0.113.9" },
    body: new URLSearchParams({ name: "Jo Park", phone: "705-555-0142", t: String(Date.now() - 60_000), ...fields }).toString(),
  });
}

beforeEach(() => {
  h.db = seed();
  h.role = "owner";
  h.limited = false;
  h.phoneLimited = false;
  sendSms.mockClear();
});

describe("/ai-settings/recruiter", () => {
  it("GET: members see the settings, not hours or applicants; owners see periods and jobs", async () => {
    h.role = "member";
    const member = (await (await GET(new Request("http://x/api"), ctx)).json()).data;
    expect(member).toMatchObject({ settings: { payroll: { enabled: true, frequency: "biweekly" }, hiring: { enabled: true } }, periods: null, jobs: null });
    h.role = "owner";
    const owner = (await (await GET(new Request("http://x/api"), ctx)).json()).data;
    expect(owner.periods[0]).toMatchObject({ id: PERIOD_ID, status: "locked" });
    expect(owner.jobs[0]).toMatchObject({ title: "Labourer", status: "open", applicants: 0 });
    h.db = seed("empirevu");
    expect((await (await GET(new Request("http://x/api"), ctx)).json()).data.settings).toMatchObject({ payroll: { enabled: false }, hiring: { enabled: false } });
  });

  it("PATCH (owner/admin) merges ONLY ai_settings.recruiter; refuses members, bad dates, unknown fields and other orgs", async () => {
    const res = await patch({ payroll: { frequency: "weekly", anchorDate: "2026-10-05", csvEmail: "books@acct.test" }, hiring: { enabled: false } });
    expect(res.status).toBe(200);
    expect(h.db!.tables.companies[0].ai_settings).toEqual({
      sms_agent: { autonomy: "ask_first" },
      recruiter: { payroll: { frequency: "weekly", anchor_date: "2026-10-05", csv_email: "books@acct.test" }, hiring: { enabled: false }, any_on: false },
    });
    expect((await patch({ payroll: { csvEmail: null } })).status).toBe(200);
    expect((h.db!.tables.companies[0].ai_settings as { recruiter: { payroll: Record<string, unknown> } }).recruiter.payroll.csv_email).toBeUndefined();
    expect((await patch({ payroll: { anchorDate: "2026-02-30" } })).status).toBe(400);
    expect((await patch({ payroll: { csvEmail: "nope" } })).status).toBe(400);
    expect((await patch({ payroll: { hourlyRate: 5 } })).status).toBe(400);
    h.role = "member";
    expect((await patch({ hiring: { enabled: true } })).status).toBe(403);
    h.role = "owner";
    expect((await patch({ hiring: { enabled: true } }, OTHER)).status).toBeGreaterThanOrEqual(400);
  });
});

describe("payroll period routes", () => {
  it("owners unlock (logged with who) and download the CSV; members can't", async () => {
    const res = await period({ action: "unlock", reason: "fix Tuesday" });
    expect(res.status).toBe(200);
    expect(h.db!.tables.pay_periods[0]).toMatchObject({ status: "unlocked", unlocked_by: "user-1", unlock_reason: "fix Tuesday" });
    expect(h.db!.tables.pay_period_events[0]).toMatchObject({ action: "unlocked", actor: "profile:user-1" });
    const csv = await CSV(new Request("http://x/api"), periodCtx);
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(csv.headers.get("content-disposition")).toBe('attachment; filename="northshore-roofing-payroll-2026-09-28-to-2026-10-11.csv"');
    expect(await csv.text()).toContain("Mike Dunn,mike@x.test,2026-09-28,2026-10-11,8.00,0.00,8.00,,,0,no pay rate on file");
    expect((await period({ action: "lock" })).status).toBe(200);
    expect(h.db!.tables.pay_periods[0].status).toBe("locked");
    h.role = "member";
    expect((await period({ action: "unlock" })).status).toBe(403);
    expect((await CSV(new Request("http://x/api"), periodCtx)).status).toBe(403);
    h.role = "owner";
    expect((await period({ action: "explode" })).status).toBe(400);
    expect((await CSV(new Request("http://x/api"), { params: { ...periodCtx.params, periodId: "77777777-7777-4777-8777-777777777777" } })).status).toBe(404);
  });
});

describe("public jobs pages", () => {
  it("GET lists and shows the job; unknown slugs are the neutral 404", async () => {
    const list = await JOBS(new Request("http://x"), { params: { slug: "northshore" } });
    expect(list.status).toBe(200);
    expect(await list.text()).toContain("Jobs at Northshore Roofing");
    const job = await JOB(new Request("http://x"), { params: { slug: "northshore", jobId: JOB_ID } });
    expect(job.status).toBe(200);
    expect(await job.text()).toMatch(/name="t" value="\d{13}"/); // render time, so the form works without JS
    expect((await JOBS(new Request("http://x"), { params: { slug: "nobody" } })).status).toBe(404);
  });

  it("POST applies; the honeypot, a too-fast submit and the rate limit are refused without saving", async () => {
    const ok = await APPLY(applyRequest({}), { params: { slug: "northshore", jobId: JOB_ID } });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("Thanks, Jo!");
    expect(h.db!.tables.job_applicants).toHaveLength(1);
    const bot = await APPLY(applyRequest({ phone: "705-555-0143", website: "spam.example" }), { params: { slug: "northshore", jobId: JOB_ID } });
    expect(bot.status).toBe(400);
    const fast = await APPLY(applyRequest({ phone: "705-555-0144", t: String(Date.now() - 500) }), { params: { slug: "northshore", jobId: JOB_ID } });
    expect(fast.status).toBe(400);
    h.limited = true;
    const limited = await APPLY(applyRequest({ phone: "705-555-0145" }), { params: { slug: "northshore", jobId: JOB_ID } });
    expect(limited.status).toBe(429);
    expect(await limited.text()).toContain("Too many tries");
    expect(h.db!.tables.job_applicants).toHaveLength(1);
    h.limited = false;
    const bad = await APPLY(applyRequest({ phone: "12" }), { params: { slug: "northshore", jobId: JOB_ID } });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("10-digit");
    // No render time at all (a bot posting the form directly) fails the timing check.
    const noT = await APPLY(applyRequest({ phone: "705-555-0146", t: "" }), { params: { slug: "northshore", jobId: JOB_ID } });
    expect(noT.status).toBe(400);
    // One phone: 5 applications a day across jobs and businesses.
    h.phoneLimited = true;
    const capped = await APPLY(applyRequest({ phone: "705-555-0147" }), { params: { slug: "northshore", jobId: JOB_ID } });
    expect(capped.status).toBe(429);
    expect(await capped.text()).toContain("a lot of applications today");
    expect(h.db!.tables.job_applicants).toHaveLength(1);
  });
});
