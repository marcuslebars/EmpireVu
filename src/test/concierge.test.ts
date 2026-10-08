/**
 * Concierge console (docs/done-for-you.md → "Concierge console") — security + behaviour:
 *   • operator identity: OPERATOR_EMAILS allowlist, case-insensitive, confirmed email only;
 *     everyone else gets a 404 from EVERY concierge route and nothing is read or written;
 *   • actions run only against the org named in the URL and that org's own company — a
 *     companyId from another tenant is a 404 with no write and no audit row;
 *   • every action writes an operator_actions row (before it runs) with the outcome;
 *   • zod rejects bad input with a 400 and nothing is written.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "./fake-supabase";

const h = vi.hoisted(() => ({
  db: null as FakeDb | null,
  user: null as Record<string, unknown> | null,
  provision: vi.fn(),
  forwardingTest: vi.fn(),
  resend: vi.fn(),
  dfy: {
    resendSetupIntake: vi.fn(),
    enrichCompany: vi.fn(),
    generateSite: vi.fn(),
    setSiteStatus: vi.fn(),
    resendForwardingText: vi.fn(),
    advanceDoneForYou: vi.fn(),
    ensureDfyNumber: vi.fn(),
  },
}));

vi.mock("@/server/supabase/admin", () => ({ createSupabaseAdminClient: () => h.db?.client }));
vi.mock("@/server/supabase/server", () => ({
  createSupabaseServerClient: () => ({
    auth: {
      getUser: async () => (h.user ? { data: { user: h.user }, error: null } : { data: { user: null }, error: { message: "no session" } }),
    },
    from: (table: string) => (h.db!.client.from as (t: string) => unknown)(table),
  }),
}));
vi.mock("@/server/services/twilio/provision", () => ({ provisionMissedCallCatcher: (...a: unknown[]) => h.provision(...a) }));
vi.mock("@/server/services/twilio/forwarding-test", () => ({ startOwnerForwardingTest: (...a: unknown[]) => h.forwardingTest(...a) }));
vi.mock("@/server/services/crankleads/provision", () => ({ resendWelcomeEmail: (...a: unknown[]) => h.resend(...a) }));
// The done-for-you actions call into the other parts — stubbed here; their own suites test them.
vi.mock("@/server/services/dfy/intake", () => ({ resendSetupIntake: (...a: unknown[]) => h.dfy.resendSetupIntake(...a) }));
vi.mock("@/server/services/dfy/enrich", () => ({ enrichCompany: (...a: unknown[]) => h.dfy.enrichCompany(...a) }));
vi.mock("@/server/services/dfy/site-generator", () => ({
  generateSite: (...a: unknown[]) => h.dfy.generateSite(...a),
  setSiteStatus: (...a: unknown[]) => h.dfy.setSiteStatus(...a),
}));
vi.mock("@/server/services/dfy/orchestrator", () => ({
  resendForwardingText: (...a: unknown[]) => h.dfy.resendForwardingText(...a),
  advanceDoneForYou: (...a: unknown[]) => h.dfy.advanceDoneForYou(...a),
}));
vi.mock("@/server/services/dfy/numbers", () => ({ ensureDfyNumber: (...a: unknown[]) => h.dfy.ensureDfyNumber(...a) }));

import { GET as listGET } from "@/app/api/concierge/accounts/route";
import { GET as detailGET } from "@/app/api/concierge/accounts/[organizationId]/route";
import { GET as actionsGET, POST as actionsPOST } from "@/app/api/concierge/accounts/[organizationId]/actions/route";
import { GET as sessionGET } from "@/app/api/session/context/route";
import { slaLevel } from "@/lib/concierge";
import { buildCallScript, listingCheckOf, numberStatus, summarizeAccount } from "@/server/services/concierge/accounts";
import { DFY_CONCIERGE_ACTIONS } from "@/server/services/concierge/dfy-actions";
import { areaCodeFor, normalizeUrl, registerConciergeAction } from "@/server/services/concierge/actions";
import { operatorIdentityFor, parseOperatorEmails } from "@/server/services/concierge/auth";
import { z } from "zod";

const ORG = "11111111-1111-4111-8111-111111111111";
const COMPANY = "22222222-2222-4222-8222-222222222222";
const OTHER_ORG = "33333333-3333-4333-8333-333333333333";
const OTHER_COMPANY = "44444444-4444-4444-8444-444444444444";
const SERVICE = "55555555-5555-4555-8555-555555555555";
const OTHER_SERVICE = "66666666-6666-4666-8666-666666666666";
const EV_ORG = "77777777-7777-4777-8777-777777777777";

const OPERATOR = { id: "op-1", email: "Marcus@Tilotto.com", email_confirmed_at: "2026-01-01T00:00:00Z" };
const env = { ...process.env };
afterAll(() => {
  process.env = env;
});

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

beforeEach(() => {
  process.env.OPERATOR_EMAILS = " someone@else.com, marcus@tilotto.com ";
  h.user = { ...OPERATOR };
  h.provision.mockReset();
  h.forwardingTest.mockReset();
  h.resend.mockReset();
  for (const fn of Object.values(h.dfy)) fn.mockReset();
  h.db = createFakeDb({
    organizations: [
      { id: ORG, name: "Smith Snow", crankleads_tier: "catch", platform_brand: "crankleads", created_at: hoursAgo(30) },
      { id: OTHER_ORG, name: "Other Roofing", crankleads_tier: "close", platform_brand: "crankleads", created_at: hoursAgo(2) },
      { id: EV_ORG, name: "EmpireVu Co", crankleads_tier: null, platform_brand: "empirevu", created_at: hoursAgo(1) },
    ],
    crankleads_purchases: [
      {
        id: "p-1", organization_id: ORG, company_id: COMPANY, tier: "catch", owner_name: "Dave Smith", owner_email: "dave@smithsnow.ca",
        owner_phone: "+17055551234", business_name: "Smith Snow", paid_at: hoursAgo(30), created_at: hoursAgo(30), live_at: null,
        stripe_checkout_session_id: "cs_test_1", status: "provisioned",
      },
    ],
    companies: [
      {
        id: COMPANY, organization_id: ORG, name: "Smith Snow", slug: "smith-snow", created_at: hoursAgo(30), website: null, hours: null,
        service_area: null, brand_logo_url: null, brand_review_url: null, owner_phone_e164: "+17055551234", brand_reply_phone: null,
        business_phone_kind: "cell", business_phone_carrier: "bell", profile: {}, owner_email: "dave@smithsnow.ca",
      },
      {
        id: OTHER_COMPANY, organization_id: OTHER_ORG, name: "Other Roofing", slug: "other", created_at: hoursAgo(2), website: "https://other.ca/",
        owner_phone_e164: "+16135550000", profile: {},
      },
    ],
    service_catalog_items: [
      { id: SERVICE, organization_id: ORG, company_id: COMPANY, label: "Driveway plow", service_key: "driveway-plow", rate_cents: 0, minimum_cents: 0, tiers: null, rate_bands: null, active: false, sort_order: 1, pricing_type: "flat" },
      { id: OTHER_SERVICE, organization_id: OTHER_ORG, company_id: OTHER_COMPANY, label: "Shingles", service_key: "shingles", rate_cents: 500, minimum_cents: 0, tiers: null, rate_bands: null, active: true, sort_order: 1, pricing_type: "flat" },
    ],
    voice_numbers: [],
    setup_intakes: [{ id: "i-1", organization_id: ORG, company_id: COMPANY, status: "failed", enrichment: {}, last_error: "site timed out" }],
    company_sites: [{ id: "site-1", organization_id: ORG, company_id: COMPANY, slug: "smith-snow", status: "published", mode: "full", published_at: hoursAgo(10) }],
    operator_actions: [],
    workflows: [],
    crankleads_setup_followups: [],
    dfy_progress: [
      {
        organization_id: ORG, company_id: COMPANY, number_attempts: 5, number_last_error: "no numbers in 705",
        number_flagged_at: hoursAgo(20), switched_on_at: hoursAgo(28), forward_text_sent_at: null, forward_opened_at: null,
        forward_tapped_at: null, forward_tests_started: 0, forward_last_test_at: null, forward_help_requested_at: null, escalated_at: null,
      },
    ],
  });
});

const db = (): FakeDb => h.db!;
const writes = () => db().ops.filter((o) => o.op !== "select");
const listReq = () => new Request("http://test/api/concierge/accounts");
const detailReq = (org = ORG, qs = "") => new Request(`http://test/api/concierge/accounts/${org}${qs}`);
const params = (organizationId = ORG) => ({ params: { organizationId } });
const post = (body: unknown, org = ORG) =>
  actionsPOST(
    new Request(`http://test/api/concierge/accounts/${org}/actions`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    params(org),
  );

describe("operator identity", () => {
  it("parses OPERATOR_EMAILS case-insensitively, ignoring blanks", () => {
    expect([...parseOperatorEmails(" A@B.com ,, c@d.ca ")]).toEqual(["a@b.com", "c@d.ca"]);
    expect(parseOperatorEmails("").size).toBe(0);
  });

  it("requires a confirmed email on the list", () => {
    const list = parseOperatorEmails("marcus@tilotto.com");
    expect(operatorIdentityFor({ id: "u", email: "MARCUS@tilotto.com", email_confirmed_at: "2026-01-01" }, list)).toEqual({ email: "marcus@tilotto.com", userId: "u" });
    expect(operatorIdentityFor({ id: "u", email: "marcus@tilotto.com", email_confirmed_at: null }, list)).toBeNull();
    expect(operatorIdentityFor({ id: "u", email: "marcus@tilotto.com.evil.com", email_confirmed_at: "2026-01-01" }, list)).toBeNull();
    expect(operatorIdentityFor({ id: "u", email: "marcus@tilotto.com", email_confirmed_at: "2026-01-01" }, new Set())).toBeNull();
  });
});

describe("session context exposes isOperator", () => {
  it("true for a confirmed allowlisted operator, false otherwise", async () => {
    expect((await (await sessionGET()).json()).data.isOperator).toBe(true);
    h.user = { ...OPERATOR, email_confirmed_at: null };
    expect((await (await sessionGET()).json()).data.isOperator).toBe(false);
    h.user = { id: "u2", email: "dave@smithsnow.ca", email_confirmed_at: "2026-01-01" };
    expect((await (await sessionGET()).json()).data.isOperator).toBe(false);
  });
});

describe("non-operators get 404 from every concierge route and nothing is touched", () => {
  const routes: Array<[string, () => Promise<Response>]> = [
    ["GET list", () => listGET(listReq())],
    ["GET detail", () => detailGET(detailReq(), params())],
    ["GET actions", () => actionsGET(detailReq(), params())],
    ["POST action", () => post({ action: "add_note", input: { note: "hi" } })],
  ];
  const callers: Array<[string, () => void]> = [
    ["signed out", () => (h.user = null)],
    ["unconfirmed operator email", () => (h.user = { ...OPERATOR, email_confirmed_at: null })],
    ["confirmed but not on the list", () => (h.user = { id: "u2", email: "dave@smithsnow.ca", email_confirmed_at: "2026-01-01" })],
    ["list unset", () => (process.env.OPERATOR_EMAILS = "")],
  ];
  for (const [who, setup] of callers) {
    for (const [name, call] of routes) {
      it(`${who}: ${name} → 404`, async () => {
        setup();
        const res = await call();
        expect(res.status).toBe(404);
        const body = await res.json();
        expect(body.data).toBeUndefined();
        expect(body.error).toBe("Not found.");
        expect(db().ops).toHaveLength(0);
      });
    }
  }
});

describe("GET /api/concierge/accounts (operator)", () => {
  it("lists only CrankLeads orgs, newest first, with setup state and a needs-a-call flag", async () => {
    const res = await listGET(listReq());
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.map((a: { organizationId: string }) => a.organizationId)).toEqual([OTHER_ORG, ORG]);
    const smith = data[1];
    expect(smith).toMatchObject({
      businessName: "Smith Snow",
      tier: "catch",
      owner: { name: "Dave Smith", email: "dave@smithsnow.ca", phone: "+17055551234" },
      intake: { status: "failed", lastError: "site timed out" },
      phone: { status: "failed", textBackNumber: null, lastError: "no numbers in 705" },
      setup: { switchedOnAt: expect.any(String), forwardTextSentAt: null },
      isLive: false,
      needsCall: true,
      stage: "needs_call",
      sla: "red",
    });
    expect(smith.needsCallReasons).toEqual(["Not live after 24 hours", "Quick setup failed", "Text-back number purchase failed"]);
    expect(smith.checklist.totalCount).toBeGreaterThan(0);
    expect(writes()).toHaveLength(0);
  });
});

describe("GET /api/concierge/accounts/:orgId (operator)", () => {
  it("returns facts, services, call script and registered actions", async () => {
    const res = await detailGET(detailReq(), params());
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.company).toMatchObject({ id: COMPANY, phoneKind: "cell", phoneCarrier: "bell" });
    expect(data.services).toEqual([expect.objectContaining({ id: SERVICE, needsPrice: true })]);
    expect(data.callScript.ownerFirstName).toBe("Dave");
    // Only REQUIRED steps (the live definition) are "missing"; the rest is one nice-to-have line.
    expect(data.callScript.missing.map((m: { key: string }) => m.key)).toEqual(["phone", "forwarding", "automations"]);
    expect(data.callScript.missing[0].text).toContain("no numbers in 705");
    expect(data.callScript.niceToHave).toBe("Nice to have: their website or Google listing (quick setup failed); prices for 1 service; the lead form on their own site.");
    expect(data.actions.map((a: { name: string }) => a.name)).toEqual(
      expect.arrayContaining(["update_business_facts", "set_service_price", "add_service", "provision_text_back_number", "run_forwarding_test", "resend_welcome_email", "add_note"]),
    );
  });

  it("an unknown org, or a companyId from another org, is a 404", async () => {
    expect((await detailGET(detailReq("99999999-9999-4999-8999-999999999999"), params("99999999-9999-4999-8999-999999999999"))).status).toBe(404);
    expect((await detailGET(detailReq(ORG, `?companyId=${OTHER_COMPANY}`), params())).status).toBe(404);
    expect((await detailGET(detailReq("not-a-uuid"), params("not-a-uuid"))).status).toBe(404);
  });
});

describe("POST actions — scoping, audit, validation", () => {
  it("update_business_facts writes only the named org's company and audits before/after", async () => {
    const res = await post({
      action: "update_business_facts",
      input: { website: "smithsnow.ca", serviceArea: "Barrie & Orillia", businessPhoneCarrier: "Rogers", hours: { summary: "Mon–Fri 7am–6pm" } },
    });
    expect(res.status).toBe(200);
    const company = db().tables.companies.find((c) => c.id === COMPANY)!;
    expect(company).toMatchObject({ website: "https://smithsnow.ca/", service_area: "Barrie & Orillia", business_phone_carrier: "rogers", hours: { summary: "Mon–Fri 7am–6pm" } });
    expect(db().tables.companies.find((c) => c.id === OTHER_COMPANY)!.website).toBe("https://other.ca/");

    const audit = db().tables.operator_actions;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ operator_email: "marcus@tilotto.com", organization_id: ORG, company_id: COMPANY, action: "update_business_facts" });
    expect(audit[0].detail).toMatchObject({
      status: "ok",
      before: { website: null, serviceArea: null, businessPhoneCarrier: "bell", hours: null },
      after: { website: "https://smithsnow.ca/", businessPhoneCarrier: "rogers" },
    });
  });

  it("a companyId belonging to another org is a 404: no write, no audit row", async () => {
    const res = await post({ action: "update_business_facts", companyId: OTHER_COMPANY, input: { website: "https://evil.example.com" } });
    expect(res.status).toBe(404);
    expect(writes()).toHaveLength(0);
    expect(db().tables.companies.find((c) => c.id === OTHER_COMPANY)!.website).toBe("https://other.ca/");
  });

  it("a service from another company can't be priced through this org (audited as failed, nothing changed)", async () => {
    const res = await post({ action: "set_service_price", input: { serviceId: OTHER_SERVICE, rateCents: 1 } });
    expect(res.status).toBe(400);
    expect(db().tables.service_catalog_items.find((s) => s.id === OTHER_SERVICE)).toMatchObject({ rate_cents: 500, active: true });
    expect(db().tables.operator_actions[0].detail).toMatchObject({ status: "failed" });
    expect(writes().filter((w) => w.table === "service_catalog_items")).toHaveLength(0);
  });

  it("set_service_price prices + switches on; clearing switches off; can't switch on unpriced", async () => {
    expect((await post({ action: "set_service_price", input: { serviceId: SERVICE, rateCents: 12500 } })).status).toBe(200);
    expect(db().tables.service_catalog_items[0]).toMatchObject({ rate_cents: 12500, active: true });
    expect(db().tables.operator_actions[0].detail).toMatchObject({ before: { rateCents: 0, active: false }, after: { rateCents: 12500, active: true } });

    expect((await post({ action: "set_service_price", input: { serviceId: SERVICE, rateCents: null } })).status).toBe(200);
    expect(db().tables.service_catalog_items[0]).toMatchObject({ rate_cents: 0, active: false });

    const res = await post({ action: "set_service_price", input: { serviceId: SERVICE, active: true } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Set a price/);
  });

  it("add_service inserts into the org's company with a unique key", async () => {
    const res = await post({ action: "add_service", input: { label: "Driveway Plow", rateCents: 6000 } });
    expect(res.status).toBe(200);
    const added = db().tables.service_catalog_items.find((s) => s.label === "Driveway Plow")!;
    expect(added).toMatchObject({ organization_id: ORG, company_id: COMPANY, service_key: "driveway-plow-2", active: true, sort_order: 2 });
  });

  it("provision_text_back_number reuses catcher provisioning, scoped to the org's company, area code from the owner phone", async () => {
    h.provision.mockResolvedValue({ phoneNumber: "+17055550100", phoneNumberPretty: "(705) 555-0100", purchased: true, instructions: { recommended: { activate: "**004*+17055550100#" } } });
    const res = await post({ action: "provision_text_back_number", input: {} });
    expect(res.status).toBe(200);
    const [ctx, input] = h.provision.mock.calls[0];
    expect(ctx.organizationId).toBe(ORG);
    expect(input).toEqual({ companyId: COMPANY, areaCode: 705 });
    expect(db().tables.operator_actions[0].detail).toMatchObject({ status: "ok", after: { phoneNumber: "+17055550100" } });
  });

  it("a failing action is audited as failed and its error surfaces", async () => {
    const { ValidationError } = await import("@/server/organizations/context");
    h.provision.mockRejectedValue(new ValidationError("No numbers available in area code 705 right now."));
    const res = await post({ action: "provision_text_back_number", input: { areaCode: 705 } });
    expect(res.status).toBe(400);
    expect(db().tables.operator_actions[0].detail).toMatchObject({ status: "failed", error: expect.stringMatching(/No numbers/) });
  });

  it("run_forwarding_test and resend_welcome_email reuse the existing services", async () => {
    h.forwardingTest.mockResolvedValue({ id: "t-1", status: "calling" });
    expect((await post({ action: "run_forwarding_test" })).status).toBe(200);
    expect(h.forwardingTest.mock.calls[0][0].organizationId).toBe(ORG);
    expect(h.forwardingTest.mock.calls[0][1]).toBe(COMPANY);

    h.resend.mockResolvedValue("sent");
    expect((await post({ action: "resend_welcome_email" })).status).toBe(200);
    expect(h.resend.mock.calls[0][1]).toBe("cs_test_1");

    h.resend.mockResolvedValue("use_forgot_password");
    expect((await post({ action: "resend_welcome_email" })).status).toBe(400);
    expect(db().tables.operator_actions.map((a) => (a.detail as { status: string }).status)).toEqual(["ok", "ok", "failed"]);
  });

  it("add_note writes only the audit row", async () => {
    expect((await post({ action: "add_note", input: { note: "Called, left voicemail" } })).status).toBe(200);
    expect(writes().map((w) => `${w.table}:${w.op}`)).toEqual(["operator_actions:insert", "operator_actions:update"]);
    expect(db().tables.operator_actions[0].detail).toMatchObject({ status: "ok", note: "Called, left voicemail" });
  });

  it("if the audit row can't be written, the action does not run", async () => {
    db().failNext("operator_actions", { message: "boom" }, "insert");
    h.forwardingTest.mockResolvedValue({ id: "t-1", status: "calling" });
    const res = await post({ action: "run_forwarding_test" });
    expect(res.status).toBe(500);
    expect(h.forwardingTest).not.toHaveBeenCalled();
  });

  const bad: Array<[string, unknown]> = [
    ["unknown action", { action: "drop_tables", input: {} }],
    ["bad website", { action: "update_business_facts", input: { website: "not a url" } }],
    ["http logo", { action: "update_business_facts", input: { logoUrl: "http://x.com/logo.png" } }],
    ["bad phone", { action: "update_business_facts", input: { ownerPhone: "12" } }],
    ["bad kind", { action: "update_business_facts", input: { businessPhoneKind: "satellite" } }],
    ["bad hours", { action: "update_business_facts", input: { hours: { mon: { open: "8am", close: "5pm" } } } }],
    ["unknown fact (strict)", { action: "update_business_facts", input: { organization_id: OTHER_ORG } }],
    ["empty facts", { action: "update_business_facts", input: {} }],
    ["negative price", { action: "set_service_price", input: { serviceId: SERVICE, rateCents: -5 } }],
    ["non-uuid service", { action: "set_service_price", input: { serviceId: "x", rateCents: 5 } }],
    ["empty note", { action: "add_note", input: { note: "   " } }],
    ["bad area code", { action: "provision_text_back_number", input: { areaCode: 12 } }],
    ["bad companyId", { action: "add_note", companyId: "nope", input: { note: "x" } }],
  ];
  for (const [name, body] of bad) {
    it(`zod rejects ${name} with 400 and writes nothing`, async () => {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(writes()).toHaveLength(0);
    });
  }

  it("actions registered later by other parts run through the same audit path", async () => {
    const run = vi.fn().mockResolvedValue({ message: "Link re-sent." });
    registerConciergeAction({ name: "test_resend_quick_setup", label: "Resend quick-setup link", schema: z.object({}).strict(), run });
    expect(() => registerConciergeAction({ name: "test_resend_quick_setup", label: "dup", schema: z.object({}), run })).toThrow();
    const res = await post({ action: "test_resend_quick_setup" });
    expect(res.status).toBe(200);
    expect(run.mock.calls[0][0]).toMatchObject({ organizationId: ORG, companyId: COMPANY });
    expect(db().tables.operator_actions[0]).toMatchObject({ action: "test_resend_quick_setup", detail: expect.objectContaining({ status: "ok" }) });
  });
});

describe("pure helpers", () => {
  it("SLA: green < 12h, amber 12–24h, red > 24h", () => {
    expect(slaLevel(0)).toBe("green");
    expect(slaLevel(11.9)).toBe("green");
    expect(slaLevel(12)).toBe("amber");
    expect(slaLevel(24)).toBe("amber");
    expect(slaLevel(24.1)).toBe("red");
  });

  it("normalizes URLs and area codes", () => {
    expect(normalizeUrl("smithsnow.ca")).toBe("https://smithsnow.ca/");
    expect(normalizeUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeUrl("http://x.ca", { httpsOnly: true })).toBeNull();
    expect(areaCodeFor(null, "(705) 555-1234")).toBe(705);
    expect(areaCodeFor("+441234567890")).toBeNull();
  });

  it("call script: Bell cell forwarding reads out the **004* code", () => {
    const account = summarizeAccount({
      org: { id: ORG, name: "Smith", crankleads_tier: "catch", created_at: hoursAgo(5), platform_brand: "crankleads" },
      purchase: null,
      company: { id: COMPANY, name: "Smith Snow", owner_email: null, owner_phone_e164: "+17055559999" },
      intake: null,
      numbers: [{ company_id: COMPANY, phone_e164: "+17055551234", mode: "missed_call_catcher", provider: "twilio", forwarding_verified_at: null, active: true }],
      site: null,
      progress: null,
      checklist: {
        organizationId: ORG, companyId: COMPANY, tier: "catch", phonePath: "missed_call_catcher", doneCount: 2, totalCount: 3, isLive: false, nextStep: null, extras: [],
        steps: [
          { key: "services", title: "Add your prices", action: "", done: true, required: false, wizardStep: "services", path: "", deepLink: "" },
          { key: "phone", title: "Number", action: "", done: true, required: true, wizardStep: "phone", path: "", deepLink: "" },
          { key: "forwarding", title: "Turn on call forwarding", action: "", done: false, required: true, wizardStep: "phone", path: "", deepLink: "" },
        ],
      },
      nowMs: Date.now(),
    });
    expect(account.stage).toBe("setting_up");
    const cell = buildCallScript({ account, phoneKind: "cell", phoneCarrier: "bell", servicesNeedingPrices: 0, pricedServices: 2 });
    expect(cell.missing).toEqual([{ key: "forwarding", text: "Forwarding not on yet — Bell cell: have them dial", code: "**004*+17055551234#" }]);
    const landline = buildCallScript({ account, phoneKind: "landline", phoneCarrier: "rogers", servicesNeedingPrices: 0, pricedServices: 2 });
    expect(landline.missing[0]).toMatchObject({ code: "(705) 555-1234" });
    expect(landline.missing[0].text).toMatch(/Rogers landline/);
    expect(cell.listingCheck).toBeNull();
    const flagged = buildCallScript({
      account,
      phoneKind: "cell",
      phoneCarrier: "bell",
      servicesNeedingPrices: 0,
      pricedServices: 2,
      listingCheck: listingCheckOf({ enrichment: { listingCheck: { needed: true, placeId: "p", reason: 'The Google listing they picked ("Bob\'s Bakery") doesn\'t match.' } } }),
    });
    expect(flagged.listingCheck).toContain("Listing needs a check");
    expect(flagged.listingCheck).toContain("Bob's Bakery");
  });
});

describe("done-for-you seams in the console", () => {
  it("number state comes from dfy_progress (no time heuristic): pending → retrying → failed (flagged) → active", () => {
    expect(numberStatus(false, null)).toBe("pending");
    expect(numberStatus(false, { number_flagged_at: null, number_last_error: "busy" })).toBe("retrying");
    expect(numberStatus(false, { number_flagged_at: hoursAgo(1), number_last_error: "busy" })).toBe("failed");
    expect(numberStatus(true, { number_flagged_at: hoursAgo(1), number_last_error: "busy" })).toBe("active");
  });

  it("list + detail show the page's PUBLIC url from siteUrl (PAGES_BASE_URL when set)", async () => {
    process.env.PAGES_BASE_URL = "https://pages.crankleads.test";
    try {
      const list = (await (await listGET(listReq())).json()).data;
      expect(list[1].site).toMatchObject({ slug: "smith-snow", url: "https://pages.crankleads.test/smith-snow", status: "published" });
      const detail = (await (await detailGET(detailReq(), params())).json()).data;
      expect(detail.account.site.url).toBe("https://pages.crankleads.test/smith-snow");
    } finally {
      delete process.env.PAGES_BASE_URL;
    }
    process.env.CRANKLEADS_APP_BASE_URL = "https://app.crankleads.test";
    try {
      const list = (await (await listGET(listReq())).json()).data;
      expect(list[1].site.url).toBe("https://app.crankleads.test/s/smith-snow");
    } finally {
      delete process.env.CRANKLEADS_APP_BASE_URL;
    }
  });

  it("every done-for-you action is registered where the routes load (detail + actions list)", async () => {
    const listed = (await (await actionsGET(detailReq(), params())).json()).data.map((a: { name: string }) => a.name);
    expect(listed).toEqual(expect.arrayContaining([...DFY_CONCIERGE_ACTIONS]));
    const detail = (await (await detailGET(detailReq(), params())).json()).data;
    expect(detail.actions.map((a: { name: string }) => a.name)).toEqual(expect.arrayContaining([...DFY_CONCIERGE_ACTIONS]));
    expect(detail.actions.find((a: { name: string }) => a.name === "resend_quick_setup_link").label).toBe("Resend quick-setup link");
  });

  it("each runs scoped to the named org's company and is audited (ok + failed)", async () => {
    h.dfy.resendSetupIntake.mockResolvedValue({ status: "sent", sms: true, email: true, url: "https://x/setup/t" });
    h.dfy.enrichCompany.mockResolvedValue({ sources: ["website"] });
    h.dfy.generateSite.mockResolvedValue({ created: false, url: "https://pages.x/smith-snow", site: { slug: "smith-snow" }, content: { copySource: "template" } });
    h.dfy.setSiteStatus.mockResolvedValue({ slug: "smith-snow" });
    h.dfy.resendForwardingText.mockResolvedValue("quiet_hours");
    h.dfy.advanceDoneForYou.mockResolvedValue({ companyId: COMPANY, steps: ["number_ready", "switched_on", "site_built"] });
    h.dfy.ensureDfyNumber.mockResolvedValue({ status: "ready", phoneNumber: "+17055550100", purchasedNow: true });

    const run = async (action: string) => {
      const res = await post({ action, input: {} });
      return { status: res.status, body: await res.json() };
    };
    expect((await run("resend_quick_setup_link")).body.data.message).toBe("Quick-setup link sent (text + email).");
    expect(h.dfy.resendSetupIntake.mock.calls[0][1]).toEqual({ organizationId: ORG, companyId: COMPANY });
    expect((await run("rerun_business_lookup")).status).toBe(200);
    expect(h.dfy.enrichCompany.mock.calls[0][1]).toBe(COMPANY);
    expect(db().tables.setup_intakes[0]).toMatchObject({ status: "enriched", last_error: null });
    expect((await run("build_website")).body.data.message).toContain("https://pages.x/smith-snow");
    expect(h.dfy.generateSite.mock.calls[0].slice(1)).toEqual([COMPANY, { publish: true }]);
    expect((await run("unpublish_website")).status).toBe(200);
    expect(h.dfy.setSiteStatus.mock.calls[0].slice(1, 3)).toEqual([COMPANY, "unpublished"]);
    const night = await run("send_forwarding_text");
    expect(night.status).toBe(400);
    expect(night.body.error).toMatch(/8am–9pm/);
    expect((await run("run_switch_on")).body.data.message).toBe("Switch-on ran: number_ready, switched_on, site_built.");
    expect(h.dfy.advanceDoneForYou.mock.calls[0][1]).toBe(COMPANY);
    expect(h.dfy.advanceDoneForYou.mock.calls[0][3]).toEqual({ force: true });

    // Retry number: clears the flag + attempts on THIS company's row, then buys.
    expect((await run("retry_dfy_number")).body.data.message).toBe("Number bought: +17055550100");
    expect(db().tables.dfy_progress[0]).toMatchObject({ number_flagged_at: null, number_attempts: 0 });
    expect(h.dfy.ensureDfyNumber.mock.calls[0][1]).toMatchObject({ organizationId: ORG, companyId: COMPANY, tier: "catch" });

    const audit = db().tables.operator_actions;
    expect(audit.map((a) => a.action)).toEqual([
      "resend_quick_setup_link",
      "rerun_business_lookup",
      "build_website",
      "unpublish_website",
      "send_forwarding_text",
      "run_switch_on",
      "retry_dfy_number",
    ]);
    expect(audit.every((a) => a.organization_id === ORG && a.company_id === COMPANY && a.operator_email === "marcus@tilotto.com")).toBe(true);
    expect(audit.map((a) => (a.detail as { status: string }).status)).toEqual(["ok", "ok", "ok", "ok", "failed", "ok", "ok"]);
  });

  it("a companyId from another org never reaches a done-for-you action (404, no audit)", async () => {
    const res = await post({ action: "build_website", companyId: OTHER_COMPANY, input: {} });
    expect(res.status).toBe(404);
    expect(h.dfy.generateSite).not.toHaveBeenCalled();
    expect(db().tables.operator_actions).toHaveLength(0);
  });
});
