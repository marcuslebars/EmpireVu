import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Errors an OWNER needs to see in words (handleRoute masks anything that isn't a
 * UserFacingError): number setup during onboarding, a duplicate company, opening the
 * billing portal before choosing a plan.
 */

import { createFakeDb, fakeTenantContext } from "./fake-supabase";

vi.mock("@/server/services/workflow-engine/recipes/install", () => ({ installRecipes: vi.fn(async () => ({ installed: [], skipped: [] })) }));
vi.mock("@/server/services/activity-events", () => ({ createActivityEvent: vi.fn(async () => undefined) }));

const { UserFacingError } = await import("@/server/errors");
const { handleRoute } = await import("@/server/api/route");
const { createTwilioNumbersClient, twilioErrorCode } = await import("@/server/services/twilio/provision");
const { createRetellClient } = await import("@/server/services/retell/provision");
const { createCompany } = await import("@/server/services/companies");
const { createBillingPortalSession } = await import("@/server/services/billing/checkout");
const { ValidationError } = await import("@/server/organizations/context");

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const failWith = (status: number, body: string) => fetchMock.mockResolvedValue({ ok: false, status, text: async () => body });

async function asResponse(fn: () => Promise<unknown>) {
  const res = await handleRoute(async () => {
    await fn();
    throw new Error("unreachable");
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("Twilio number purchase", () => {
  const twilio = () => createTwilioNumbersClient({ accountSid: "AC1", authToken: "t" });
  const buy = () => twilio().purchase({ phoneNumber: "+17055550100", friendlyName: "x", voiceUrl: "https://a", smsUrl: "https://b" });

  it("says the number was taken when Twilio's code means it's unavailable", async () => {
    failWith(400, JSON.stringify({ code: 21422, message: "PhoneNumber requested is not available", more_info: "https://www.twilio.com/docs/errors/21422" }));
    const { status, body } = await asResponse(buy);
    expect(status).toBe(502);
    expect(body).toMatchObject({ error: "That number was just taken — pick another.", code: "number_unavailable" });
  });

  it("gives a short generic message for anything else, with no Twilio JSON", async () => {
    failWith(401, JSON.stringify({ code: 20003, message: "Authenticate" }));
    const { body } = await asResponse(buy);
    expect(body.error).toBe("Couldn't set up that number. Try another or contact support.");
    expect(JSON.stringify(body)).not.toMatch(/20003|Authenticate|twilio\.com|AC1/);
  });

  it("reads Twilio's numeric error code safely", () => {
    expect(twilioErrorCode('{"code":21422}')).toBe(21422);
    expect(twilioErrorCode('{"code":"21452"}')).toBe(21452);
    expect(twilioErrorCode("<html>502</html>")).toBeNull();
  });
});

describe("Retell number setup (AI receptionist onboarding)", () => {
  it("maps a failed number request to the plain message", async () => {
    failWith(400, '{"error_message":"No phone numbers available for area code 705"}');
    const { status, body } = await asResponse(() => createRetellClient("key").createPhoneNumber({ area_code: 705 }));
    expect(status).toBe(502);
    expect(body.error).toBe("That number was just taken — pick another.");
  });

  it("is generic for other Retell failures", async () => {
    failWith(500, "internal");
    const { body } = await asResponse(() => createRetellClient("key").createAgent({}));
    expect(body.error).toBe("Couldn't set up that number. Try another or contact support.");
  });
});

describe("creating a company with a name that's taken", () => {
  it("is a ValidationError in words, not a raw unique-violation", async () => {
    const db = createFakeDb({ companies: [] });
    db.failNext("companies", { message: 'duplicate key value violates unique constraint "companies_organization_id_slug_key"', code: "23505" }, "insert");
    const err = await createCompany(fakeTenantContext(db, "org-1", "u1"), { name: "Bayview Plumbing" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toBe("You already have a company with that name. Use a different name, or edit the existing company.");
  });

  it("still throws other database errors (masked by handleRoute)", async () => {
    const db = createFakeDb({ companies: [] });
    db.failNext("companies", { message: "connection reset", code: "08006" }, "insert");
    const { status } = await asResponse(() => createCompany(fakeTenantContext(db, "org-1", "u1"), { name: "X" }));
    expect(status).toBe(500);
  });
});

describe("opening the billing portal with no plan yet", () => {
  it("says to choose a plan first", async () => {
    const db = createFakeDb({ organizations: [{ id: "org-1", stripe_customer_id: null }] });
    const err = await createBillingPortalSession(db.client as never, { organizationId: "org-1" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UserFacingError);
    expect((err as Error).message).toBe("Choose a plan first.");
    expect((err as Error).message).not.toContain("org-1");
  });
});
