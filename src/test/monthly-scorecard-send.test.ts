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

// Route test: the request's RLS client + membership are mocked.
const requireOrganizationContext = vi.fn();
vi.mock("@/server/organizations/context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/organizations/context")>()),
  requireOrganizationContext: (...a: unknown[]) => requireOrganizationContext(...a),
}));
const serverClient = { current: null as unknown };
vi.mock("@/server/supabase/server", () => ({ createSupabaseServerClient: () => serverClient.current }));

import { createFakeDb, type FakeDb } from "./helpers/fake-supabase";
import {
  parseScorecardArgs,
  runMonthlyScorecards,
  scorecardSkipReason,
} from "@/server/services/monthly-scorecard/send";
import { fetchScorecardInputs } from "@/server/services/monthly-scorecard/metrics";
import { getOperatorNote, setOperatorNote } from "@/server/services/monthly-scorecard/scorecard";
import { GET, PUT } from "@/app/api/organizations/[organizationId]/ui/monthly-scorecard/route";

const NOV_2 = Date.parse("2026-11-02T13:00:00.000Z");
const ORG_1 = "11111111-1111-4111-8111-111111111111";
const CO_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function company(over: Record<string, unknown>) {
  return {
    name: "Company",
    timezone: "America/Toronto",
    created_at: "2026-01-15T12:00:00.000Z",
    owner_email: "owner@example.test",
    owner_phone_e164: null,
    brand_primary_color: null,
    monthly_scorecard: null,
    stage: "active",
    ...over,
  };
}

function seed(): FakeDb {
  return createFakeDb(
    {
      companies: [
        company({ id: CO_1, organization_id: ORG_1, name: "Maple & Sons Plumbing", owner_email: "owner@maple.test" }),
        company({ id: "co-optout", organization_id: "org-2", name: "Opted Out HVAC", monthly_scorecard: { enabled: false } }),
        company({ id: "co-archived", organization_id: ORG_1, name: "Old Brand", stage: "archived" }),
        company({ id: "co-canceled", organization_id: "org-3", name: "Gone Roofing" }),
      ],
      organizations: [
        { id: ORG_1, subscription_status: "active", plan: "operate", slug: "maple" },
        { id: "org-2", subscription_status: "active", plan: "operate", slug: "optout" },
        { id: "org-3", subscription_status: "canceled", plan: "launch", slug: "gone" },
        { id: "org-a1", subscription_status: "active", plan: "front_desk", slug: "a1-group" },
      ],
      contacts: [
        { id: "c-1", organization_id: ORG_1, company_id: CO_1, created_at: "2026-10-10T15:00:00.000Z", metadata: { formType: "quote" }, consent_source: null },
        // Another tenant's lead in the same month — must never leak into Maple's numbers.
        { id: "c-other", organization_id: "org-2", company_id: "co-optout", created_at: "2026-10-11T15:00:00.000Z", metadata: {}, consent_source: null },
      ],
      bookings: [
        { id: "b-other", organization_id: "org-2", company_id: "co-optout", created_at: "2026-10-12T15:00:00.000Z", scheduled_for: "2026-10-20T15:00:00.000Z", status: "confirmed" },
      ],
    },
    { monthly_scorecard_sends: [["company_id", "month"]], monthly_scorecard_notes: [["company_id", "month"]] },
  );
}

function sends(db: FakeDb) {
  return db.tables.monthly_scorecard_sends ?? [];
}

beforeEach(() => {
  sendSms.mockReset().mockResolvedValue({ sid: "SM1" });
  sendEmail.mockReset().mockResolvedValue({ id: "re_1" });
  vi.stubEnv("OWNER_EMAIL", "");
  vi.stubEnv("PLATFORM_BRAND_NAME", "");
  vi.stubEnv("APP_BASE_URL", "https://app.test");
  requireOrganizationContext.mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("runMonthlyScorecards — scheduled run on Nov 2", () => {
  it("sends last month's scorecard once per eligible company and respects opt-out", async () => {
    const db = seed();
    const outcomes = await runMonthlyScorecards(db.client, { nowMs: NOV_2 });

    const byCompany = Object.fromEntries(outcomes.map((o) => [o.companyId, [o.result, o.reason ?? null]]));
    expect(byCompany).toEqual({
      [CO_1]: ["sent", null],
      "co-optout": ["skipped", "opted_out"],
      "co-archived": ["skipped", "inactive_company"],
      "co-canceled": ["skipped", "org_canceled"],
    });

    // Exactly one email: to Maple's owner, from the platform brand, Maple's numbers only.
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const mail = sendEmail.mock.calls[0][0] as { to: string; subject: string; fromName: string; body: string; html: string };
    expect(mail.to).toBe("owner@maple.test");
    expect(mail.fromName).toBe("CrankLeads");
    expect(mail.subject).toBe("Your October results: 1 lead caught, 0 jobs booked");
    expect(mail.html).toContain("Maple &amp; Sons Plumbing");
    expect(mail.body).toContain("https://app.test/reports/monthly");

    const maple = sends(db).find((row) => row.company_id === CO_1);
    expect(maple).toMatchObject({ organization_id: ORG_1, month: "2026-10-01", status: "sent", email_status: "sent", send_count: 1, recipient: "owner@maple.test" });
    // Opt-out is recorded (so the in-app page can show it), and nothing was sent for it.
    expect(sends(db).find((row) => row.company_id === "co-optout")).toMatchObject({ organization_id: "org-2", status: "skipped", detail: { skipped: "opted_out" } });
  });

  it("is idempotent per (company, month): a second run sends nothing", async () => {
    const db = seed();
    await runMonthlyScorecards(db.client, { nowMs: NOV_2 });
    const again = await runMonthlyScorecards(db.client, { nowMs: NOV_2 + 3_600_000 });
    expect(again.find((o) => o.companyId === CO_1)).toMatchObject({ result: "skipped", reason: "already_sent" });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sends(db).filter((row) => row.company_id === CO_1)).toHaveLength(1);
  });

  it("does not send while another run holds the claim", async () => {
    const db = seed();
    db.tables.monthly_scorecard_sends = [{ id: "s1", organization_id: ORG_1, company_id: CO_1, month: "2026-10-01", status: "claimed", send_count: 0 }];
    const outcomes = await runMonthlyScorecards(db.client, { nowMs: NOV_2, companyId: CO_1 });
    expect(outcomes[0]).toMatchObject({ result: "skipped", reason: "already_sent" });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("retries a failed send on the next run, and --force re-sends a sent month", async () => {
    const db = seed();
    sendEmail.mockRejectedValueOnce(new Error("Resend down"));
    const first = await runMonthlyScorecards(db.client, { nowMs: NOV_2, companyId: CO_1 });
    expect(first[0]).toMatchObject({ result: "failed" });
    expect(sends(db)[0]).toMatchObject({ status: "failed", send_count: 0 });

    const retry = await runMonthlyScorecards(db.client, { nowMs: NOV_2, companyId: CO_1 });
    expect(retry[0]).toMatchObject({ result: "sent" });
    expect(sends(db)[0]).toMatchObject({ status: "sent", send_count: 1 });

    const forced = await runMonthlyScorecards(db.client, { nowMs: NOV_2, companyId: CO_1, month: "2026-10", force: true });
    expect(forced[0]).toMatchObject({ result: "sent" });
    expect(sends(db)).toHaveLength(1);
    expect(sends(db)[0]).toMatchObject({ status: "sent", send_count: 2 });
  });

  it("dry run previews (even an opted-out company) and writes nothing", async () => {
    const db = seed();
    const outcomes = await runMonthlyScorecards(db.client, { nowMs: NOV_2, dryRun: true });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(sends(db)).toHaveLength(0);
    expect(db.queries.some((q) => q.op !== "select" && q.table === "monthly_scorecard_sends")).toBe(false);
    const optOut = outcomes.find((o) => o.companyId === "co-optout");
    expect(optOut).toMatchObject({ result: "dry_run", reason: "opted_out", subject: "Your October results: 1 lead caught, 1 job booked" });
    expect(outcomes.find((o) => o.companyId === CO_1)?.email?.text).toContain("Maple & Sons Plumbing — October 2026 results");
  });

  it("skips a month that isn't over and a company with no owner email", async () => {
    const db = seed();
    const early = await runMonthlyScorecards(db.client, { nowMs: NOV_2, companyId: CO_1, month: "2026-11" });
    expect(early[0]).toMatchObject({ result: "skipped", reason: "month_not_over" });

    db.tables.companies[0].owner_email = null;
    const noEmail = await runMonthlyScorecards(db.client, { nowMs: NOV_2, companyId: CO_1 });
    expect(noEmail[0]).toMatchObject({ result: "skipped", reason: "no_email" });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("falls back to the org owner/admin — NEVER to the platform OWNER_EMAIL", async () => {
    vi.stubEnv("OWNER_EMAIL", "platform@crankleads.test");
    const db = seed();
    db.tables.companies[0].owner_email = null;
    db.tables.organization_memberships = [{ organization_id: ORG_1, profile_id: "p-admin", role: "admin" }];
    db.tables.profiles = [{ id: "p-admin", email: "admin@maple.test" }];
    const outcomes = await runMonthlyScorecards(db.client, { nowMs: NOV_2, companyId: CO_1 });
    expect(outcomes[0]).toMatchObject({ result: "sent", recipient: "admin@maple.test" });
    expect(sendEmail.mock.calls.map((c) => (c[0] as { to: string }).to)).toEqual(["admin@maple.test"]);
  });

  it("skips (no_email) instead of emailing OWNER_EMAIL — even for the house org", async () => {
    vi.stubEnv("OWNER_EMAIL", "platform@crankleads.test");
    const db = seed();
    db.tables.companies.push(company({ id: "co-a1", organization_id: "org-a1", name: "A1 Marine Care", owner_email: null }));
    db.tables.companies[0].owner_email = null; // Maple: tenant, no owner/admin members either
    const outcomes = await runMonthlyScorecards(db.client, { nowMs: NOV_2 });
    expect(outcomes.find((o) => o.companyId === CO_1)).toMatchObject({ result: "skipped", reason: "no_email" });
    expect(outcomes.find((o) => o.companyId === "co-a1")).toMatchObject({ result: "skipped", reason: "no_email" });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(sends(db).find((row) => row.company_id === CO_1)).toMatchObject({ status: "skipped", detail: { skipped: "no_email" } });
  });

  it("keeps every scorecard read and write inside the company's tenant", async () => {
    const db = seed();
    await runMonthlyScorecards(db.client, { nowMs: NOV_2, companyId: CO_1 });
    const scoped = new Set([
      "contacts", "activity_events", "message_log", "retell_calls", "workflows", "workflow_runs",
      "quotes", "bookings", "usage_events", "raw_leads", "monthly_scorecard_sends", "monthly_scorecard_notes",
    ]);
    const tenantQueries = db.queries.filter((q) => scoped.has(q.table) && q.op !== "insert" && q.op !== "upsert");
    expect(tenantQueries.length).toBeGreaterThan(10);
    for (const query of tenantQueries) {
      const eqs = query.filters.filter((f) => f.kind === "eq");
      expect(eqs, `${query.op} ${query.table}`).toContainEqual({ kind: "eq", column: "organization_id", value: ORG_1 });
      expect(eqs, `${query.op} ${query.table}`).toContainEqual({ kind: "eq", column: "company_id", value: CO_1 });
    }
    for (const row of [...sends(db), ...(db.tables.message_log ?? [])]) {
      expect(row.organization_id).toBe(ORG_1);
      expect(row.company_id).toBe(CO_1);
    }
  });
});

describe("fetchScorecardInputs tenancy", () => {
  it("only returns the requested company's rows", async () => {
    const db = seed();
    const inputs = await fetchScorecardInputs(
      { organizationId: "org-2", actorProfileId: null, supabase: db.client },
      "co-optout",
      { from: "2026-10-01T04:00:00.000Z", to: "2026-11-01T04:00:00.000Z" },
    );
    expect(inputs.newContacts.map((c) => c.id)).toEqual(["c-other"]);
    expect(inputs.bookings).toHaveLength(1);
  });
});

describe("scorecardSkipReason", () => {
  const base = { orgSubscriptionStatus: "active", month: "2026-10", timeZone: "America/Toronto", nowMs: NOV_2 };
  it("skips companies created after the month ended", () => {
    expect(scorecardSkipReason({ ...base, company: { monthly_scorecard: null, stage: "active", created_at: "2026-11-01T12:00:00.000Z" } })).toBe("not_started");
    expect(scorecardSkipReason({ ...base, company: { monthly_scorecard: null, stage: "active", created_at: "2026-10-31T12:00:00.000Z" } })).toBeNull();
  });
});

describe("parseScorecardArgs (PowerShell-friendly flags)", () => {
  it("parses flags in both `--flag value` and `--flag=value` forms", () => {
    expect(parseScorecardArgs([])).toEqual({ dryRun: false, force: false, companyId: null, month: null });
    expect(parseScorecardArgs(["--dry-run", "--company", "co-1", "--month=2026-09"])).toEqual({
      dryRun: true,
      force: false,
      companyId: "co-1",
      month: "2026-09",
    });
  });

  it("rejects bad months, unknown flags, and --force without --company", () => {
    expect(() => parseScorecardArgs(["--month", "Sept"])).toThrow(/YYYY-MM/);
    expect(() => parseScorecardArgs(["--company"])).toThrow(/needs a value/);
    expect(() => parseScorecardArgs(["--everyone"])).toThrow(/Unknown argument/);
    expect(() => parseScorecardArgs(["--force"])).toThrow(/requires --company/);
  });
});

describe("operator note", () => {
  it("upserts, reads back, clears on empty, and caps length", async () => {
    const db = seed();
    const ctx = { organizationId: ORG_1, actorProfileId: "user-1", supabase: db.client };
    expect(await setOperatorNote(ctx, CO_1, "2026-10", "  Rewriting your quote follow-up.  ")).toBe("Rewriting your quote follow-up.");
    expect(await setOperatorNote(ctx, CO_1, "2026-10", "Updated note")).toBe("Updated note");
    expect(db.tables.monthly_scorecard_notes).toHaveLength(1);
    expect(db.tables.monthly_scorecard_notes[0]).toMatchObject({ organization_id: ORG_1, company_id: CO_1, month: "2026-10-01", updated_by: "user-1" });
    expect(await getOperatorNote(ctx, CO_1, "2026-10")).toBe("Updated note");
    expect(await setOperatorNote(ctx, CO_1, "2026-10", "")).toBeNull();
    expect(db.tables.monthly_scorecard_notes).toHaveLength(0);
    await expect(setOperatorNote(ctx, CO_1, "2026-10", "x".repeat(2001))).rejects.toThrow(/2000/);
  });
});

describe("monthly-scorecard route", () => {
  function membership(role: string) {
    return { organizationId: ORG_1, user: { id: "user-1" }, membership: { role }, profile: null };
  }

  it("PUT is owner/admin only", async () => {
    serverClient.current = seed().client;
    requireOrganizationContext.mockResolvedValue(membership("member"));
    const res = await PUT(
      new Request("http://test", { method: "PUT", body: JSON.stringify({ companyId: CO_1, month: "2026-10", operatorNote: "hi" }) }),
      { params: { organizationId: ORG_1 } },
    );
    expect(res.status).toBe(403);
  });

  it("PUT lets an admin set the note and opt the company out", async () => {
    const db = seed();
    serverClient.current = db.client;
    requireOrganizationContext.mockResolvedValue(membership("admin"));
    const res = await PUT(
      new Request("http://test", { method: "PUT", body: JSON.stringify({ companyId: CO_1, month: "2026-10", operatorNote: "Tuning quotes", enabled: false }) }),
      { params: { organizationId: ORG_1 } },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { operatorNote: "Tuning quotes", settings: { enabled: false } } });
    expect(db.tables.companies[0].monthly_scorecard).toEqual({ enabled: false });
  });

  it("GET requires a companyId", async () => {
    serverClient.current = seed().client;
    requireOrganizationContext.mockResolvedValue(membership("member"));
    const res = await GET(new Request("http://test/x"), { params: { organizationId: ORG_1 } });
    expect(res.status).toBe(400);
  });
});
