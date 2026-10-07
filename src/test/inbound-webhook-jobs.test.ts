import { describe, expect, it, vi } from "vitest";

// The worker dispatches by provider back into the existing handlers; mock those and
// assert the routing + the payload passed through (unchanged from the old sync path).
// vi.hoisted so the hoisted vi.mock factories below can close over the spies.
const h = vi.hoisted(() => ({
  ingestRetellCall: vi.fn(() => Promise.resolve({ handled: "inbound" as const })),
}));
vi.mock("@/server/services/retell/lead-adapter", () => ({ ingestRetellCall: h.ingestRetellCall }));

import {
  dispatchInboundWebhookJob,
  processInboundWebhookJobs,
  type InboundWebhookJob,
} from "@/server/services/inbound-webhook-jobs";

type AdminParam = Parameters<typeof processInboundWebhookJobs>[0];

// Reused from retell-lead-adapter.test.ts — the same call_analyzed payload the old
// synchronous webhook handed to ingestRetellCall.
const callAnalyzed = {
  event: "call_analyzed",
  call: {
    call_id: "call_9f2c1e7b4a3d8e60",
    direction: "inbound",
    from_number: "+17055550188",
    call_analysis: { call_summary: "Winterization", custom_analysis_data: { caller_name: "Paul" } },
  },
};

function makeJob(over: Partial<InboundWebhookJob>): InboundWebhookJob {
  return {
    id: "job-1",
    provider: "retell",
    external_id: "call_9f2c1e7b4a3d8e60",
    organization_id: null,
    company_id: null,
    payload: {},
    status: "running",
    attempts: 1,
    max_attempts: 5,
    claimed_at: null,
    claimed_by: null,
    last_error: null,
    run_at: "2026-09-04T00:00:00.000Z",
    created_at: "2026-09-04T00:00:00.000Z",
    updated_at: "2026-09-04T00:00:00.000Z",
    ...over,
  };
}

describe("dispatchInboundWebhookJob", () => {
  it("routes a retell job to ingestRetellCall with the same payload the sync path used", async () => {
    h.ingestRetellCall.mockClear();
    await dispatchInboundWebhookJob(makeJob({ provider: "retell", payload: callAnalyzed as InboundWebhookJob["payload"] }));
    expect(h.ingestRetellCall).toHaveBeenCalledWith(callAnalyzed);
  });

  it("a leftover jobber job dead-letters (Jobber was removed)", async () => {
    await expect(dispatchInboundWebhookJob(makeJob({ provider: "jobber" }))).rejects.toThrow(/Unknown inbound webhook provider: jobber/);
  });

  it("throws on an unknown provider so the job dead-letters", async () => {
    await expect(dispatchInboundWebhookJob(makeJob({ provider: "mystery" }))).rejects.toThrow(/Unknown/);
  });
});

describe("processInboundWebhookJobs (worker tick)", () => {
  it("claims a retell job, runs the full ingest, and marks it completed", async () => {
    h.ingestRetellCall.mockClear();
    const job = makeJob({ provider: "retell", payload: callAnalyzed as InboundWebhookJob["payload"] });
    const updates: Array<{ patch: Record<string, unknown>; id: string }> = [];

    const admin = {
      rpc: (name: string) =>
        Promise.resolve({ data: name === "claim_inbound_webhook_jobs" ? [job] : null, error: null }),
      from: () => ({
        update: (patch: Record<string, unknown>) => ({
          eq: (_column: string, value: string) => {
            updates.push({ patch, id: value });
            return Promise.resolve({ error: null });
          },
        }),
      }),
    } as unknown as AdminParam;

    const processed = await processInboundWebhookJobs(admin, { workerId: "test-worker" });

    expect(processed).toBe(1);
    expect(h.ingestRetellCall).toHaveBeenCalledWith(callAnalyzed);
    // Completed (not failed): status set to 'completed' for this job id.
    expect(updates).toContainEqual(
      expect.objectContaining({ id: "job-1", patch: expect.objectContaining({ status: "completed" }) }),
    );
  });
});
