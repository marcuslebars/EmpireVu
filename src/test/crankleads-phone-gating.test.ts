/**
 * Server-side phone-step gating: the AI-receptionist provisioning route refuses an org whose
 * plan lacks `marina_reception` (CrankLeads Catch / Close on `operate`) before touching
 * Retell or a phone number. Front Desk / house orgs proceed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const orgCan = vi.fn();
vi.mock("@/server/services/billing/gating", () => ({
  orgCan: (...args: unknown[]) => orgCan(...args),
}));

vi.mock("@/server/supabase/server", () => ({ createSupabaseServerClient: () => ({}) }));

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

const COMPANY = "00000000-0000-4000-8000-000000000001";

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
  orgCan.mockReset();
  provisionPhoneForCompany.mockReset().mockResolvedValue({
    llmId: "llm",
    agentId: "agent",
    phoneNumber: "+17055550000",
    phoneNumberPretty: "(705) 555-0000",
    purchasedNumber: true,
  });
  recordOnboardingEvent.mockReset();
});

describe("POST /onboarding/phone (AI receptionist)", () => {
  it("403 for a plan without marina_reception (Catch / Close) — nothing provisioned", async () => {
    orgCan.mockResolvedValue(false);
    const res = await call();
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/missed-call catcher/);
    expect(orgCan).toHaveBeenCalledWith(expect.anything(), "org-1", "marina_reception");
    expect(provisionPhoneForCompany).not.toHaveBeenCalled();
  });

  it("proceeds for Front Desk / house orgs", async () => {
    orgCan.mockResolvedValue(true);
    const res = await call();
    expect(res.status).toBe(200);
    expect(provisionPhoneForCompany).toHaveBeenCalledTimes(1);
  });
});
