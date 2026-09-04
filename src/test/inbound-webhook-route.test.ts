import { describe, expect, it, vi } from "vitest";

// Shared recorder for the mocked admin client. vi.hoisted so the vi.mock factories
// below (which are hoisted above the imports) can close over it.
const h = vi.hoisted(() => {
  const fromCalls: string[] = [];
  const upserts: Array<{ table: string; row: Record<string, unknown>; options: unknown }> = [];
  const admin = {
    from(table: string) {
      fromCalls.push(table);
      return {
        upsert(row: Record<string, unknown>, options: unknown) {
          upserts.push({ table, row, options });
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  return { fromCalls, upserts, admin };
});

vi.mock("@/server/services/retell/tenant", () => ({
  createRetellAdminClient: () => h.admin,
}));
vi.mock("@/server/services/retell/signature", () => ({
  verifyRetellSignature: () => true,
}));
vi.mock("@/server/services/retell/config", () => ({
  getRetellConfig: () => ({
    enabled: true,
    outboundEnabled: false,
    apiKey: "test-key",
    toleranceMs: 300_000,
    sourceSite: "a1marinestorage",
    leadSource: "retell_voice_agent",
  }),
}));
vi.mock("@/server/services/retell/auth", () => ({ logRetellPayload: () => undefined }));

import { POST as retellWebhook } from "@/app/api/retell/webhook/route";

const callAnalyzed = {
  event: "call_analyzed",
  call: {
    call_id: "call_9f2c1e7b4a3d8e60",
    direction: "inbound",
    from_number: "+17055550188",
    transcript: "Agent: Hello...",
    call_analysis: { call_summary: "s", custom_analysis_data: { caller_name: "Paul" } },
  },
};

function postRetell(body: unknown): Promise<Response> {
  return retellWebhook(
    new Request("https://api.empirevu.com/api/retell/webhook", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "x-retell-signature": "sig" },
    }),
  );
}

describe("retell webhook — durable-first", () => {
  it("persists retell_calls, THEN enqueues inbound_webhook_jobs, THEN returns 200", async () => {
    h.fromCalls.length = 0;
    h.upserts.length = 0;

    const response = await postRetell(callAnalyzed);

    // 200 only after both writes.
    expect(response.status).toBe(200);
    // Order: the raw call lands in retell_calls before the job is enqueued.
    expect(h.fromCalls).toEqual(["retell_calls", "inbound_webhook_jobs"]);
    // The job row targets the call_id and carries the raw payload.
    const jobUpsert = h.upserts.find((u) => u.table === "inbound_webhook_jobs");
    expect(jobUpsert?.row.provider).toBe("retell");
    expect(jobUpsert?.row.external_id).toBe("call_9f2c1e7b4a3d8e60");
  });

  it("enqueues with on-conflict-do-nothing so a duplicate delivery is a no-op", async () => {
    h.fromCalls.length = 0;
    h.upserts.length = 0;

    await postRetell(callAnalyzed);

    const jobUpsert = h.upserts.find((u) => u.table === "inbound_webhook_jobs");
    expect(jobUpsert?.options).toEqual({ onConflict: "provider,external_id", ignoreDuplicates: true });
  });

  it("does not enqueue for non-analyzed events", async () => {
    h.fromCalls.length = 0;
    h.upserts.length = 0;

    const response = await postRetell({ event: "call_started", call: { call_id: "c-1" } });

    expect(response.status).toBe(200);
    expect(h.fromCalls).toEqual([]);
  });
});
