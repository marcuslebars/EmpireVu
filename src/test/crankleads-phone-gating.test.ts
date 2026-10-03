/**
 * Server-side phone-step gating with the REAL orgCan (billing/gating.ts) over an in-memory
 * DB: only a CrankLeads Catch/Close org is refused the AI receptionist. A self-serve
 * trial `operate` org, an existing operate org, Front Desk and house orgs proceed exactly as
 * before; a marina_reception feature-flag override re-opens it for a Catch org.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "./helpers/fake-supabase";

let db: FakeDb;
vi.mock("@/server/supabase/server", () => ({ createSupabaseServerClient: () => db.client }));

vi.mock("@/server/organizations/context", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/organizations/context")>();
  return {
    ...original,
    requireOrganizationContext: async (_s: unknown, organizationId: string) => ({ organizationId, user: { id: "user-1" } }),
  };
});

const provisionPhoneForCompany = vi.fn();
vi.mock("@/server/services/onboarding-provision", () => ({
  provisionPhoneForCompany: (...args: unknown[]) => provisionPhoneForCompany(...args),
}));

const recordOnboardingEvent = vi.fn();
vi.mock("@/server/services/onboarding", () => ({
  getOnboardingProgress: async () => [],
  recordOnboardingEvent: (...args: unknown[]) => recordOnboardingEvent(...args),
  upsertOnboardingStep: async () => ({}),
}));

import { POST } from "@/app/api/organizations/[organizationId]/onboarding/phone/route";
import { availablePhoneModes } from "@/lib/phone-modes";

const COMPANY = "00000000-0000-4000-8000-000000000001";
const future = new Date(Date.now() + 7 * 864e5).toISOString();

function org(overrides: Record<string, unknown>) {
  return { id: "org-1", name: "Org", plan: "operate", subscription_status: "active", trial_ends_at: null, crankleads_tier: null, ...overrides };
}

function call() {
  return POST(
    new Request("https://app.test/api/organizations/org-1/onboarding/phone", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ companyId: COMPANY, areaCode: 705 }),
    }),
    { params: { organizationId: "org-1" } },
  );
}

beforeEach(() => {
  provisionPhoneForCompany.mockReset().mockResolvedValue({
    llmId: "llm",
    agentId: "agent",
    phoneNumber: "+17055550000",
    phoneNumberPretty: "(705) 555-0000",
    purchasedNumber: true,
  });
  recordOnboardingEvent.mockReset();
});

function seed(orgRow: Record<string, unknown>, flags: Record<string, unknown>[] = []) {
  db = createFakeDb({ organizations: [orgRow], subscriptions: [], feature_flags: flags });
}

describe("POST /onboarding/phone (AI receptionist) — real orgCan", () => {
  it("allows a self-serve trial operate org (no CrankLeads tier) — unchanged behaviour", async () => {
    seed(org({ plan: "operate", subscription_status: "trialing", trial_ends_at: future }));
    expect((await call()).status).toBe(200);
    expect(provisionPhoneForCompany).toHaveBeenCalledTimes(1);
  });

  it("allows existing launch/operate orgs and house orgs", async () => {
    for (const row of [org({ plan: "launch" }), org({ plan: "operate" }), org({ plan: "internal", subscription_status: "none" })]) {
      seed(row);
      expect((await call()).status, String(row.plan)).toBe(200);
    }
  });

  it("refuses a CrankLeads Catch or Close org (operate, no marina_reception) — nothing provisioned", async () => {
    for (const tier of ["catch", "close"]) {
      seed(org({ crankleads_tier: tier }));
      const res = await call();
      expect(res.status, tier).toBe(403);
      expect((await res.json()).error).toMatch(/missed-call catcher/);
    }
    expect(provisionPhoneForCompany).not.toHaveBeenCalled();
  });

  it("allows CrankLeads Front Desk, and a Catch org with a marina_reception override", async () => {
    seed(org({ plan: "front_desk", crankleads_tier: "front_desk" }));
    expect((await call()).status).toBe(200);
    seed(org({ crankleads_tier: "catch" }), [{ organization_id: "org-1", feature: "marina_reception", enabled: true, limit_value: null }]);
    expect((await call()).status).toBe(200);
  });

  it("the wizard UI follows the same rule", () => {
    expect(availablePhoneModes({ crankleadsTier: null, aiReceptionistAllowed: false })).toEqual(["ai_receptionist", "missed_call_catcher"]);
    expect(availablePhoneModes({ crankleadsTier: "catch", aiReceptionistAllowed: false })).toEqual(["missed_call_catcher"]);
    expect(availablePhoneModes({ crankleadsTier: "close", aiReceptionistAllowed: true })).toEqual(["ai_receptionist", "missed_call_catcher"]);
    expect(availablePhoneModes({ crankleadsTier: "front_desk", aiReceptionistAllowed: true })).toEqual(["ai_receptionist", "missed_call_catcher"]);
  });
});
