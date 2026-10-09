import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "./fake-supabase";

// Front Desk receptionist: tools wired at provisioning (and on every re-sync), the disclosure
// prompt, Canadian numbers, and an idempotent re-sync.
vi.mock("@/server/services/company-voice-profiles", () => ({ upsertCompanyVoiceProfile: async () => ({}) }));

import { provisionPhoneForCompany, isMarineCompany } from "@/server/services/onboarding-provision";
import { buildReceptionistPrompt, provisionRetellAgent, receptionistBeginMessage, type RetellClient } from "@/server/services/retell/provision";
import { buildReceptionistTools, RECEPTIONIST_TOOL_PATHS } from "@/server/services/retell/receptionist-tools";
import { retellCountryFor } from "@/server/services/voice/canada";
import { resyncReceptionistAgent } from "@/server/services/voice/resync";

const ORG = "11111111-1111-4111-8111-111111111111";
const COMPANY = "22222222-2222-4222-8222-222222222222";
const BASE = "https://app.crankleads.test";
const SECRET = "fn-secret";

const env = { ...process.env };
afterAll(() => {
  process.env = env;
});

interface Recorded {
  calls: string[];
  bodies: Record<string, Record<string, unknown>>;
}

function mockRetell(rec: Recorded): RetellClient {
  const log = (name: string, body: Record<string, unknown>) => {
    rec.calls.push(name);
    rec.bodies[name.split(":")[0]] = body;
  };
  return {
    createLlm: async (b) => (log("createLlm", b), { llm_id: "llm_1" }),
    updateLlm: async (id, b) => (log(`updateLlm:${id}`, b), { llm_id: id }),
    createAgent: async (b) => (log("createAgent", b), { agent_id: "agent_1" }),
    updateAgent: async (id, b) => (log(`updateAgent:${id}`, b), { agent_id: id }),
    createPhoneNumber: async (b) => (log("createPhoneNumber", b), { phone_number: "+17055551234" }),
    updatePhoneNumber: async (n, b) => (log(`updatePhoneNumber:${n}`, b), { phone_number: n }),
    listPhoneNumbers: async () => [],
  };
}

let db: FakeDb;

function seed(opts: { pack?: string; keys?: string[]; phoneStep?: Record<string, unknown> | null } = {}): FakeDb {
  return createFakeDb({
    companies: [
      {
        id: COMPANY,
        organization_id: ORG,
        name: "Northshore Plumbing",
        slug: "northshore",
        hours: { summary: "Mon–Fri 8–5" },
        service_area: "Barrie",
        quote_public_base_url: null,
        industry_pack: opts.pack ? { id: opts.pack, version: 1 } : null,
        owner_phone_e164: "+17055550111",
        brand_reply_phone: null,
      },
    ],
    service_catalog_items: (opts.keys ?? ["furnace_tune_up"]).map((key, i) => ({
      id: `sci-${i}`,
      organization_id: ORG,
      company_id: COMPANY,
      service_key: key,
      label: key.replace(/_/g, " "),
      pricing_type: "flat",
      rate_cents: 14900,
      minimum_cents: 0,
      sort_order: i,
      active: true,
    })),
    onboarding_progress:
      opts.phoneStep === null
        ? []
        : [{ id: "op-1", organization_id: ORG, company_id: COMPANY, step: "phone", data: opts.phoneStep ?? { llmId: "llm_1", agentId: "agent_1", phoneNumber: "+17055551234" } }],
    voice_numbers: [],
  });
}

beforeEach(() => {
  process.env.APP_BASE_URL = BASE;
  process.env.RETELL_FUNCTION_SECRET = SECRET;
  process.env.RETELL_API_KEY = "key_test";
  db = seed();
});

describe("buildReceptionistTools", () => {
  it("wires every tool to our routes with the function secret; generic trades get quote_services", () => {
    const tools = buildReceptionistTools({ baseUrl: BASE, functionSecret: SECRET, marine: false });
    const names = tools.map((t) => t.name);
    expect(names).toEqual(["quote_services", "check_availability", "book_job", "send_deposit_link", "capture_lead", "alert_owner", "end_call"]);
    for (const t of tools.filter((t) => t.type === "custom")) {
      expect(t.headers).toEqual({ "x-empirevu-retell-secret": SECRET });
      expect(String(t.url).startsWith(`${BASE}/api/retell/functions/`)).toBe(true);
      expect(t.args_at_root).toBe(false);
    }
    expect(tools[0].url).toBe(`${BASE}${RECEPTIONIST_TOOL_PATHS.quote_services}`);
  });

  it("marine keeps the existing quote_shrink_wrap / book_wrap_date contract", () => {
    const tools = buildReceptionistTools({ baseUrl: BASE, functionSecret: SECRET, marine: true });
    expect(tools[0]).toMatchObject({ name: "quote_shrink_wrap", url: `${BASE}/api/retell/functions/quote` });
    expect(tools.map((t) => t.name)).toContain("book_wrap_date");
    expect(isMarineCompany("marine", [])).toBe(true);
    expect(isMarineCompany(null, ["shrink_wrap"])).toBe(true);
    expect(isMarineCompany("hvac-plumbing", ["furnace_tune_up"])).toBe(false);
  });
});

describe("receptionist prompt + greeting", () => {
  it("discloses AI + recording up front, uses tools, never invents prices", () => {
    const prompt = buildReceptionistPrompt({ companyName: "Northshore Plumbing", services: ["Furnace tune-up — $149"], tools: "price_list" });
    expect(prompt.split("\n")[1]).toMatch(/automated assistant and that the call may be recorded/);
    expect(prompt).toContain("- quote_services:");
    expect(prompt).toContain("Only say a price that is listed above or that your quote tool returned");
    expect(receptionistBeginMessage("Northshore Plumbing")).toBe(
      "Thanks for calling Northshore Plumbing. You've reached our automated assistant, and this call may be recorded. How can I help you today?",
    );
  });
});

describe("provisioning payload", () => {
  it("a first provision sends the tools, the analysis fields, and buys a CA number for a Canadian area code", async () => {
    const rec: Recorded = { calls: [], bodies: {} };
    db = seed({ phoneStep: null });
    const ctx = { organizationId: ORG, actorProfileId: null, supabase: db.client as never };
    await provisionPhoneForCompany(ctx, { companyId: COMPANY, areaCode: 705 }, mockRetell(rec));
    expect(rec.calls).toEqual(["createLlm", "createAgent", "createPhoneNumber"]);
    const llm = rec.bodies.createLlm;
    expect((llm.general_tools as Array<{ name: string }>).map((t) => t.name)).toContain("quote_services");
    expect(String(llm.general_prompt)).toContain("automated assistant");
    expect(String(llm.begin_message)).toContain("this call may be recorded");
    expect((rec.bodies.createAgent.post_call_analysis_data as Array<{ name: string }>).map((f) => f.name)).toContain("caller_name");
    expect(rec.bodies.createPhoneNumber).toMatchObject({ country_code: "CA", area_code: 705 });
  });

  it("no function secret → provisioned without tools (and says so), prompt has no tool lines", async () => {
    delete process.env.RETELL_FUNCTION_SECRET;
    const rec: Recorded = { calls: [], bodies: {} };
    const ctx = { organizationId: ORG, actorProfileId: null, supabase: db.client as never };
    await provisionPhoneForCompany(ctx, { companyId: COMPANY, existing: { llmId: "llm_1", agentId: "agent_1", phoneNumber: "+17055551234" } }, mockRetell(rec));
    expect(rec.bodies.updateLlm.general_tools).toBeUndefined();
    expect(String(rec.bodies.updateLlm.general_prompt)).not.toContain("quote_services");
  });

  it("country for the number", () => {
    expect(retellCountryFor(705)).toBe("CA");
    expect(retellCountryFor(416)).toBe("CA");
    expect(retellCountryFor(212)).toBe("US");
    expect(retellCountryFor(null, "+17055550111")).toBe("CA");
    expect(retellCountryFor(null, null)).toBe("US");
  });

  it("provisionRetellAgent forwards tools on UPDATE too", async () => {
    const rec: Recorded = { calls: [], bodies: {} };
    await provisionRetellAgent(mockRetell(rec), {
      companyName: "X",
      prompt: "p",
      generalTools: [{ type: "end_call", name: "end_call" }],
      existing: { llmId: "llm_9", agentId: "agent_9", phoneNumber: "+17055550000" },
    });
    expect(rec.bodies.updateLlm.general_tools).toEqual([{ type: "end_call", name: "end_call" }]);
  });
});

describe("resyncReceptionistAgent", () => {
  it("only UPDATEs the stored LLM / agent / number — run twice, identical, never a purchase", async () => {
    const first: Recorded = { calls: [], bodies: {} };
    const a = await resyncReceptionistAgent(db.client as never, COMPANY, { retell: mockRetell(first) });
    const second: Recorded = { calls: [], bodies: {} };
    const b = await resyncReceptionistAgent(db.client as never, COMPANY, { retell: mockRetell(second) });
    expect(a).toEqual({ status: "resynced", llmId: "llm_1", agentId: "agent_1", phoneNumber: "+17055551234" });
    expect(b).toEqual(a);
    expect(first.calls).toEqual(["updateLlm:llm_1", "updateAgent:agent_1", "updatePhoneNumber:+17055551234"]);
    expect(second.calls).toEqual(first.calls);
    expect(second.bodies.updateLlm).toEqual(first.bodies.updateLlm);
    expect((first.bodies.updateLlm.general_tools as unknown[]).length).toBeGreaterThan(0);
    // voice_numbers row is upserted once (no duplicates on re-run).
    expect(db.tables.voice_numbers).toHaveLength(1);
  });

  it("never provisioned → not_provisioned, no Retell calls", async () => {
    db = seed({ phoneStep: null });
    const rec: Recorded = { calls: [], bodies: {} };
    expect(await resyncReceptionistAgent(db.client as never, COMPANY, { retell: mockRetell(rec) })).toEqual({ status: "not_provisioned" });
    expect(rec.calls).toEqual([]);
  });

  it("unknown company", async () => {
    expect(await resyncReceptionistAgent(db.client as never, "99999999-9999-4999-8999-999999999999")).toEqual({ status: "company_not_found" });
  });
});
