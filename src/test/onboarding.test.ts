import { describe, expect, it } from "vitest";

import { extractReadableText, parseCatalogResponse } from "@/server/ai/catalog-parser";
import {
  buildReceptionistPrompt,
  provisionRetellAgent,
  type ProvisionInput,
  type RetellClient,
} from "@/server/services/retell/provision";
import { nextOnboardingStep } from "@/server/services/onboarding";
import { buildTestLeadEnvelope } from "@/server/services/lead-intake/test-lead";
import { parseLeadEnvelope } from "@/server/services/lead-intake/envelope";
import { signIntakeBody, verifyIntakeSignature } from "@/server/services/lead-intake/hmac";

// ── URL → catalog parser (golden) ─────────────────────────────────────────────

const FIXTURE_HTML = `<!doctype html>
<html><head>
  <title>Bayside Boat Care</title>
  <style>.hero{color:red}</style>
  <script>window.track('pageview'); var secret = 42;</script>
</head><body>
  <nav>Home About Contact</nav>
  <h1>Bayside Boat Care</h1>
  <p>We offer full boat &amp; hull detailing from $150, plus shrink&nbsp;wrapping and winterization.</p>
  <!-- a comment that should vanish -->
</body></html>`;

describe("extractReadableText", () => {
  it("strips scripts, styles, comments, and tags but keeps readable copy (golden)", () => {
    const text = extractReadableText(FIXTURE_HTML);
    expect(text).toContain("Bayside Boat Care");
    expect(text).toContain("detailing from $150");
    expect(text).toContain("shrink wrapping"); // &nbsp; collapsed
    expect(text).toContain("boat & hull"); // &amp; decoded
    // none of the executable/style/comment content survives
    expect(text).not.toContain("window.track");
    expect(text).not.toContain("secret = 42");
    expect(text).not.toContain("color:red");
    expect(text).not.toContain("a comment that should vanish");
    expect(text).not.toMatch(/<[^>]+>/);
  });

  it("caps the output length", () => {
    const big = `<p>${"x".repeat(200_000)}</p>`;
    expect(extractReadableText(big, 1000).length).toBe(1000);
  });
});

describe("parseCatalogResponse", () => {
  it("parses fenced JSON into validated drafts, keeping null prices", () => {
    const raw = '```json\n{"services":[{"name":"Boat detailing","description":"Full detail","pricingType":"flat","baseCents":15000},{"name":"Shrink wrapping","pricingType":"per_measure","baseCents":null}]}\n```';
    const drafts = parseCatalogResponse(raw);
    expect(drafts).toHaveLength(2);
    expect(drafts[0]).toMatchObject({ name: "Boat detailing", pricingType: "flat", baseCents: 15000 });
    expect(drafts[1]).toMatchObject({ name: "Shrink wrapping", pricingType: "per_measure", baseCents: null });
  });

  it("throws on non-JSON output", () => {
    expect(() => parseCatalogResponse("sorry, I can't do that")).toThrow();
  });
});

// ── Retell provisioning (idempotent, mocked client) ───────────────────────────

function mockRetell(calls: string[]): RetellClient {
  return {
    createLlm: () => { calls.push("createLlm"); return Promise.resolve({ llm_id: "llm_1" }); },
    updateLlm: (id) => { calls.push(`updateLlm:${id}`); return Promise.resolve({ llm_id: id }); },
    createAgent: () => { calls.push("createAgent"); return Promise.resolve({ agent_id: "agent_1" }); },
    updateAgent: (id) => { calls.push(`updateAgent:${id}`); return Promise.resolve({ agent_id: id }); },
    createPhoneNumber: () => { calls.push("createPhoneNumber"); return Promise.resolve({ phone_number: "+17055551234", phone_number_pretty: "+1 (705) 555-1234" }); },
    updatePhoneNumber: (num) => { calls.push(`updatePhoneNumber:${num}`); return Promise.resolve({ phone_number: num }); },
    listPhoneNumbers: () => Promise.resolve([]),
  };
}

const baseInput: ProvisionInput = { companyName: "A1 Marine", prompt: "You are Marina." };

describe("buildReceptionistPrompt", () => {
  it("includes the company, services, and booking link", () => {
    const prompt = buildReceptionistPrompt({
      companyName: "A1 Marine",
      services: ["Detailing", "Shrink wrap"],
      bookingUrl: "https://app/book/co-1",
    });
    expect(prompt).toContain("A1 Marine");
    expect(prompt).toContain("Detailing");
    expect(prompt).toContain("Shrink wrap");
    expect(prompt).toContain("https://app/book/co-1");
  });
});

describe("provisionRetellAgent", () => {
  it("creates the LLM, agent, and number on a first run", async () => {
    const calls: string[] = [];
    const result = await provisionRetellAgent(mockRetell(calls), { ...baseInput, areaCode: 705 });
    expect(result).toMatchObject({ llmId: "llm_1", agentId: "agent_1", phoneNumber: "+17055551234", purchasedNumber: true });
    expect(calls).toEqual(["createLlm", "createAgent", "createPhoneNumber"]);
  });

  it("is idempotent — a re-run with prior ids UPDATEs and never duplicates", async () => {
    const calls: string[] = [];
    const result = await provisionRetellAgent(mockRetell(calls), {
      ...baseInput,
      existing: { llmId: "llm_1", agentId: "agent_1", phoneNumber: "+17055551234" },
    });
    expect(result).toMatchObject({ llmId: "llm_1", agentId: "agent_1", phoneNumber: "+17055551234", purchasedNumber: false });
    expect(calls).toEqual(["updateLlm:llm_1", "updateAgent:agent_1", "updatePhoneNumber:+17055551234"]);
    expect(calls).not.toContain("createLlm");
    expect(calls).not.toContain("createPhoneNumber");
  });

  it("points the number's inbound webhook at the returning-caller lookup, and the agent's at post-call", async () => {
    const bodies: Record<string, Record<string, unknown>> = {};
    const client: RetellClient = {
      createLlm: async () => ({ llm_id: "llm_1" }),
      updateLlm: async () => ({ llm_id: "llm_1" }),
      createAgent: async (b) => ((bodies.agent = b), { agent_id: "agent_1" }),
      updateAgent: async () => ({ agent_id: "agent_1" }),
      createPhoneNumber: async (b) => ((bodies.number = b), { phone_number: "+17055551234" }),
      updatePhoneNumber: async () => ({ phone_number: "+17055551234" }),
      listPhoneNumbers: async () => [],
    };
    await provisionRetellAgent(client, {
      ...baseInput,
      webhookUrl: "https://api.empirevu.com/api/retell/webhook",
      inboundWebhookUrl: "https://api.empirevu.com/api/retell/inbound",
    });
    expect(bodies.agent.webhook_url).toBe("https://api.empirevu.com/api/retell/webhook");
    expect(bodies.number.inbound_webhook_url).toBe("https://api.empirevu.com/api/retell/inbound");
  });

  it("attaches a supplied existing number instead of purchasing", async () => {
    const calls: string[] = [];
    const result = await provisionRetellAgent(mockRetell(calls), { ...baseInput, attachNumber: "+14165550100" });
    expect(result.phoneNumber).toBe("+14165550100");
    expect(result.purchasedNumber).toBe(false);
    expect(calls).toContain("updatePhoneNumber:+14165550100");
    expect(calls).not.toContain("createPhoneNumber");
  });
});

// ── Intake test-lead round trip ───────────────────────────────────────────────

describe("test-lead envelope", () => {
  it("builds a valid canonical envelope", () => {
    const env = buildTestLeadEnvelope(new Date("2026-09-07T12:00:00.000Z"));
    const parsed = parseLeadEnvelope(env);
    expect(parsed.valid).toBe(true);
    expect(parsed.envelope?.formType).toBe("contact");
  });

  it("round-trips an HMAC signature over the raw body", () => {
    const env = buildTestLeadEnvelope();
    const raw = JSON.stringify(env);
    const key = "evk_0123456789abcdef";
    const sig = signIntakeBody(raw, key);
    expect(sig.startsWith("sha256=")).toBe(true);
    expect(verifyIntakeSignature(raw, sig, key)).toBe(true);
    expect(verifyIntakeSignature(raw, sig, "evk_wrongsecret")).toBe(false);
    expect(verifyIntakeSignature(`${raw} `, sig, key)).toBe(false); // tampered body
  });
});

// ── Progress resume ───────────────────────────────────────────────────────────

describe("nextOnboardingStep", () => {
  it("resumes at the first incomplete step", () => {
    expect(nextOnboardingStep([])).toBe("business");
    expect(nextOnboardingStep(["business"])).toBe("services");
    expect(nextOnboardingStep(["business", "services", "phone"])).toBe("payments");
  });
  it("skips completed steps even out of order", () => {
    expect(nextOnboardingStep(["business", "phone"])).toBe("services");
  });
  it("returns the last step once everything is done", () => {
    expect(nextOnboardingStep(["business", "services", "phone", "payments", "website", "test_call", "team", "recipes"])).toBe("recipes");
  });
});
