import { beforeEach, describe, expect, it, vi } from "vitest";

// Capture what the (real) recordUsage writes by handing ingest a fake admin client.
const h = vi.hoisted(() => {
  const usageUpserts: Array<{ row: Record<string, unknown>; options: unknown }> = [];
  const admin = {
    from(table: string) {
      const api = {
        select() {
          return api;
        },
        eq() {
          return api;
        },
        maybeSingle() {
          // raw_leads → contact link lookup; retell_calls → no existing lead for this call.
          return Promise.resolve({
            data: table === "raw_leads" ? { contact_id: null } : null,
            error: null,
          });
        },
        upsert(row: Record<string, unknown>, options: unknown) {
          if (table === "usage_events") usageUpserts.push({ row, options });
          return Promise.resolve({ error: null });
        },
        update() {
          return { eq: () => Promise.resolve({ error: null }) };
        },
      };
      return api;
    },
  };
  return { usageUpserts, admin };
});

vi.mock("@/server/services/retell/config", () => ({
  getRetellConfig: () => ({
    enabled: true,
    outboundEnabled: false,
    apiKey: "k",
    toleranceMs: 300_000,
    sourceSite: "a1marinestorage",
    leadSource: "retell_voice_agent",
  }),
}));
vi.mock("@/server/services/retell/tenant", () => ({
  createRetellAdminClient: () => h.admin,
  resolveRetellTenant: () =>
    Promise.resolve({ organizationId: "org-1", companyId: "co-1", sourceSite: "a1marinestorage" }),
}));
vi.mock("@/server/services/lead-intake/intake", () => ({
  handleLeadIntake: () => Promise.resolve({ leadId: "lead-1", duplicate: false, status: "ok" }),
}));

import { ingestRetellCall } from "@/server/services/retell/lead-adapter";

const inboundAnalyzed = {
  event: "call_analyzed",
  call: {
    call_id: "call_meter_1",
    direction: "inbound",
    from_number: "+17055550188",
    duration_ms: 90_000, // 1.5 minutes
    start_timestamp: 1_760_000_000_000,
    end_timestamp: 1_760_000_090_000,
    call_cost: { combined_cost: 42 },
    call_analysis: { call_summary: "Winterization", custom_analysis_data: { caller_name: "Paul" } },
  },
};

beforeEach(() => {
  h.usageUpserts.length = 0;
});

describe("retell voice metering", () => {
  it("records voice_minutes as duration_ms/60000, keyed on call_id, with the call cost", async () => {
    await ingestRetellCall(inboundAnalyzed);

    expect(h.usageUpserts).toHaveLength(1);
    const { row, options } = h.usageUpserts[0];
    expect(row).toMatchObject({
      organization_id: "org-1",
      company_id: "co-1",
      kind: "voice_minutes",
      quantity: 1.5, // 90000 ms → 1.5 minutes (fractional; rounded only for display)
      unit: "minutes",
      provider: "retell",
      provider_ref: "call_meter_1",
      cost_cents: 42,
    });
    // Idempotent: a duplicate delivery of the same call_id is a no-op insert.
    expect(options).toEqual({ onConflict: "provider,provider_ref,kind", ignoreDuplicates: true });
  });

  it("never refuses an inbound call, even implicitly — ingest resolves normally", async () => {
    // Inbound calls have no cap gate (a receptionist that stops answering is worse than
    // overage). The ingest just records usage and returns the lead.
    const result = await ingestRetellCall(inboundAnalyzed);
    expect(result).toEqual({ handled: "inbound", leadId: "lead-1" });
  });
});
