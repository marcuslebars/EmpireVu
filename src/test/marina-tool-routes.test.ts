import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  enabled: true,
  signatureOk: true,
  runPhoneQuote: vi.fn(),
  lookupCaller: vi.fn(),
  resolveRetellTenant: vi.fn(),
}));

vi.mock("@/server/services/retell/config", () => ({
  getRetellConfig: () => ({
    enabled: h.enabled,
    outboundEnabled: false,
    apiKey: "test-key",
    toleranceMs: 300_000,
    sourceSite: "a1marinestorage",
    leadSource: "retell_voice_agent",
  }),
}));
vi.mock("@/server/services/retell/signature", () => ({ verifyRetellSignature: () => h.signatureOk }));
vi.mock("@/server/services/retell/tools/run-phone-quote", () => ({ runPhoneQuote: h.runPhoneQuote }));
vi.mock("@/server/services/retell/tenant", () => ({
  createRetellAdminClient: () => ({}),
  resolveRetellTenant: h.resolveRetellTenant,
}));
vi.mock("@/server/services/retell/caller-lookup", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/services/retell/caller-lookup")>();
  return {
    ...real,
    lookupCaller: h.lookupCaller,
    loadGreetingContext: async () => ({ companyName: "A1 Marine Care", agentName: "Marina", timeZone: "America/Toronto" }),
  };
});

import { POST as inbound } from "@/app/api/retell/inbound/route";
import { POST as quote } from "@/app/api/retell/functions/quote/route";

const SECRET = "s3cret-s3cret-s3cret";

function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(url, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });
}

beforeEach(() => {
  h.enabled = true;
  h.signatureOk = true;
  process.env.RETELL_FUNCTION_SECRET = SECRET;
  h.runPhoneQuote.mockReset();
  h.lookupCaller.mockReset();
  h.resolveRetellTenant.mockReset();
});

describe("POST /api/retell/functions/quote", () => {
  it("rejects a call without the shared secret", async () => {
    const res = await quote(post("https://x/api/retell/functions/quote", { args: {} }));
    expect(res.status).toBe(401);
    expect(h.runPhoneQuote).not.toHaveBeenCalled();
  });

  it("rejects a wrong secret", async () => {
    const res = await quote(post("https://x/q", { args: {} }, { "x-empirevu-retell-secret": "nope" }));
    expect(res.status).toBe(401);
  });

  it("gives Marina a line to say when the integration is switched off", async () => {
    h.enabled = false;
    const res = await quote(post("https://x/q", { args: {} }, { "x-empirevu-retell-secret": SECRET }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, reason: "not_enabled", say: expect.any(String) });
  });

  it("hands the parsed call to the quote tool", async () => {
    h.runPhoneQuote.mockResolvedValue({ ok: true, say: "The shrink wrap…" });
    const res = await quote(
      post(
        "https://x/q",
        { name: "quote_shrink_wrap", args: { name: "Dana Lee", boat_length_ft: 24 }, call: { call_id: "c1", to_number: "+17059961010" } },
        { "x-empirevu-retell-secret": SECRET },
      ),
    );
    expect(res.status).toBe(200);
    expect(h.runPhoneQuote.mock.calls[0][0]).toMatchObject({
      args: { name: "Dana Lee", boat_length_ft: 24 },
      call: { callId: "c1", toNumber: "+17059961010" },
    });
  });

  it("still answers with a line to say if the tool throws", async () => {
    h.runPhoneQuote.mockRejectedValue(new Error("boom"));
    const res = await quote(post("https://x/q", { args: {} }, { "x-empirevu-retell-secret": SECRET }));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ ok: false, say: expect.stringMatching(/within the hour/) });
  });
});

describe("POST /api/retell/inbound", () => {
  const ring = { event: "call_inbound", call_inbound: { from_number: "+17055551234", to_number: "+17059961010", agent_id: "a" } };

  it("answers as a new caller on a bad signature, without touching the database", async () => {
    h.signatureOk = false;
    const res = await inbound(post("https://x/api/retell/inbound", ring));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.call_inbound.dynamic_variables).toMatchObject({ caller_known: "false", greeting: "Hi, this is Marina. How can I help you today?" });
    expect(h.resolveRetellTenant).not.toHaveBeenCalled();
  });

  it("looks the caller up in the called company only", async () => {
    h.resolveRetellTenant.mockResolvedValue({ organizationId: "org_1", companyId: "co_care", sourceSite: "a1marinecare", resolvedBy: "number" });
    h.lookupCaller.mockResolvedValue({
      known: true,
      firstName: "Dana",
      fullName: "Dana Lee",
      boat: "24 ft bowrider",
      services: "shrink wrap",
      quoteId: "q1",
      quoteTotal: "$672",
      quoteAgeLabel: "yesterday",
      bookedWindow: "",
      depositPaid: false,
      depositLinkSent: false,
    });
    const res = await inbound(post("https://x/api/retell/inbound", ring, { "x-retell-signature": "v=1,d=2" }));
    const body = await res.json();
    expect(h.resolveRetellTenant.mock.calls[0][1]).toMatchObject({ toNumber: "+17059961010" });
    expect(h.lookupCaller.mock.calls[0][1]).toMatchObject({ companyId: "co_care", phone: "+17055551234" });
    expect(body.call_inbound).toMatchObject({
      dynamic_variables: {
        caller_known: "true",
        greeting: "Thanks for calling A1 Marine Care, this is Marina. Hi Dana — are you calling about the 24 ft bowrider?",
        quote_id: "q1",
      },
      metadata: { quoteId: "q1" },
    });
  });

  it("does not look anyone up while the integration is off, but still greets with the brand", async () => {
    h.enabled = false;
    h.resolveRetellTenant.mockResolvedValue({ organizationId: "org_1", companyId: "co_care", sourceSite: "a1marinecare", resolvedBy: "number" });
    const res = await inbound(post("https://x/api/retell/inbound", ring));
    const body = await res.json();
    expect(h.lookupCaller).not.toHaveBeenCalled();
    expect(body.call_inbound.dynamic_variables.greeting).toBe(
      "Thanks for calling A1 Marine Care, this is Marina. How can I help you today?",
    );
  });

  it("greets neutrally and skips the lookup when the number isn't mapped to a company", async () => {
    h.resolveRetellTenant.mockResolvedValue({
      organizationId: "org_1",
      companyId: "co_storage",
      sourceSite: "a1marinestorage",
      resolvedBy: "legacy",
    });
    const res = await inbound(post("https://x/api/retell/inbound", ring));
    const body = await res.json();
    expect(h.lookupCaller).not.toHaveBeenCalled();
    expect(body.call_inbound.dynamic_variables.greeting).toBe("Hi, this is Marina. How can I help you today?");
  });

  it("connects the call as a new caller when the lookup is too slow", async () => {
    vi.useFakeTimers();
    try {
      h.resolveRetellTenant.mockReturnValue(new Promise(() => undefined));
      const pending = inbound(post("https://x/api/retell/inbound", ring));
      await vi.advanceTimersByTimeAsync(1600);
      const body = await (await pending).json();
      expect(body.call_inbound.dynamic_variables.caller_known).toBe("false");
    } finally {
      vi.useRealTimers();
    }
  });
});
