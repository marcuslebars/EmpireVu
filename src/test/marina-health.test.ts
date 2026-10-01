import { describe, expect, it } from "vitest";

import { DEFAULT_BOOKING_POLICY } from "@/server/services/booking-windows";
import { getReceptionistBaseUrl, pointsHere, receptionistHealth, type HealthInput, type RetellReader } from "@/server/services/retell/health";

const BASE = "https://api.empirevu.com";
const ENV = { RETELL_INTAKE_ENABLED: "1", RETELL_API_KEY: "k", RETELL_FUNCTION_SECRET: "s" };

function reader(over: Partial<{ agent: object; llm: object; number: object }> = {}): RetellReader {
  return {
    getAgent: async () => ({
      agent_id: "agent_care",
      version: 7,
      is_published: true,
      webhook_url: `${BASE}/api/retell/webhook`,
      response_engine: { type: "retell-llm", llm_id: "llm_1" },
      ...over.agent,
    }),
    getLlm: async () => ({
      general_tools: [
        { type: "custom", name: "quote_shrink_wrap", url: `${BASE}/api/retell/functions/quote` },
        { type: "custom", name: "check_availability", url: `${BASE}/api/retell/functions/availability` },
        { type: "custom", name: "book_wrap_date", url: `${BASE}/api/retell/functions/book` },
        { type: "custom", name: "send_deposit_link", url: `${BASE}/api/retell/functions/deposit-link` },
        { type: "transfer_call", name: "transfer_call" },
        { type: "end_call", name: "end_call" },
      ],
      ...over.llm,
    }),
    getPhoneNumber: async () => ({
      phone_number: "+17059961010",
      inbound_agents: [{ agent_id: "agent_care" }],
      inbound_webhook_url: `${BASE}/api/retell/inbound`,
      ...over.number,
    }),
  };
}

function input(over: Partial<HealthInput> = {}): HealthInput {
  return {
    company: { name: "A1 Marine Care", owner_phone_e164: "+17055550000", stripe_charges_enabled: true, booking_policy: DEFAULT_BOOKING_POLICY },
    numbers: [{ phone_e164: "+17059961010", provider_agent_id: "agent_care" }],
    hasCatalog: true,
    baseUrl: BASE,
    env: ENV,
    smsConfigured: true,
    retell: reader(),
    ...over,
  };
}

describe("receptionist health", () => {
  it("is all green when everything points at EmpireVu", async () => {
    const r = await receptionistHealth(input());
    expect(r.warnings).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.checks.find((c) => c.name.endsWith("tools"))?.detail).toBe("4 tools → EmpireVu");
  });

  it("names every tool still pointing at the Care site (before cutover)", async () => {
    const r = await receptionistHealth(
      input({
        retell: reader({
          llm: {
            general_tools: [
              { name: "quote_shrink_wrap", url: "https://a1marinecare.ca/api/retell/functions/quote" },
              { name: "book_wrap_date", url: `${BASE}/api/retell/functions/book` },
            ],
          },
          agent: { webhook_url: "https://a1marinecare.ca/api/retell/webhook" },
          number: { inbound_webhook_url: "https://a1marinecare.ca/api/retell/inbound" },
        }),
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.warnings).toEqual([
      "+17059961010 returning callers: inbound webhook is https://a1marinecare.ca/api/retell/inbound — returning callers won't be recognised",
      "+17059961010 post-call webhook: goes to https://a1marinecare.ca/api/retell/webhook — EmpireVu only sees calls if that forwards them",
      "+17059961010 tools: quote_shrink_wrap → a1marinecare.ca — not EmpireVu",
    ]);
  });

  it("catches an unpublished agent and a number bound to a different agent", async () => {
    const r = await receptionistHealth(
      input({ retell: reader({ agent: { is_published: false }, number: { inbound_agents: [{ agent_id: "agent_old" }] } }) }),
    );
    expect(r.warnings).toContain("+17059961010 answers with the agent: the number's inbound agent isn't the one in Voice numbers");
    expect(r.warnings).toContain("+17059961010 agent published: v7 has unpublished changes — callers still get the previous version");
  });

  it("flags the business setup that silently breaks a call", async () => {
    const r = await receptionistHealth(
      input({
        env: { RETELL_API_KEY: "k" },
        smsConfigured: false,
        hasCatalog: false,
        company: { name: "X", owner_phone_e164: null, stripe_charges_enabled: false, booking_policy: null },
        numbers: [],
      }),
    );
    expect(r.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual([
      "receptionist switched on",
      "tool secret",
      "texting",
      "owner phone",
      "price list",
      "deposits",
      "booking windows",
      "phone number",
    ]);
  });

  it("reports Retell errors instead of throwing", async () => {
    const r = await receptionistHealth(
      input({
        retell: { ...reader(), getAgent: async () => ({ error: "404 not found" }), getPhoneNumber: async () => ({ error: "401" }) },
      }),
    );
    expect(r.warnings).toContain("+17059961010 number: couldn't load it from Retell: 401");
    expect(r.warnings).toContain("+17059961010 agent: couldn't load agent agent_care: 404 not found");
  });

  it("matches URLs by host and path, ignoring www and trailing slashes", () => {
    expect(pointsHere("https://www.api.empirevu.com/api/retell/inbound/", "/api/retell/inbound", BASE)).toBe(true);
    expect(pointsHere("https://api.empirevu.com/api/retell/webhook", "/api/retell/inbound", BASE)).toBe(false);
    expect(pointsHere("not a url", "/api/retell/inbound", BASE)).toBe(false);
  });
});

describe("receptionist API origin", () => {
  it("checks the API host when customer links use a separate app host", async () => {
    const env = { ...ENV, APP_BASE_URL: "https://app.empirevu.com", RETELL_PUBLIC_BASE_URL: BASE };
    const r = await receptionistHealth(input({ baseUrl: getReceptionistBaseUrl(env), env }));
    expect(r.ok).toBe(true);
    expect(env.APP_BASE_URL).toBe("https://app.empirevu.com");
    expect(pointsHere("https://a1marinecare.ca/api/retell/inbound", "/api/retell/inbound", getReceptionistBaseUrl(env))).toBe(false);
  });

  it("trims the API override and removes trailing slashes", () => {
    expect(getReceptionistBaseUrl({ RETELL_PUBLIC_BASE_URL: `  ${BASE}///  `, APP_BASE_URL: "https://app.empirevu.com" })).toBe(BASE);
  });

  it("preserves single-host deployments when the override is absent", () => {
    expect(getReceptionistBaseUrl({ APP_BASE_URL: "https://single.example/" })).toBe("https://single.example");
  });

  it("falls back to the app host for an empty override", () => {
    expect(getReceptionistBaseUrl({ RETELL_PUBLIC_BASE_URL: "  ", APP_BASE_URL: " https://single.example/ " })).toBe("https://single.example");
  });

  it("returns no origin when neither is configured", () => {
    expect(getReceptionistBaseUrl({})).toBeNull();
  });
});
