import { beforeEach, describe, expect, it, vi } from "vitest";

// A mid-call tool (capture-lead, Marina's quote) files the lead while the caller is still on
// the line. The call.* automations must wait for the END of the call — and still fire then.

const h = vi.hoisted(() => {
  const state = {
    calls: new Map<string, Record<string, unknown>>(),
    emitted: [] as Array<{ eventType: string; metadata: Record<string, unknown> }>,
  };
  const admin = {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const b: Record<string, unknown> = {};
      for (const m of ["select", "in", "limit", "order"]) b[m] = () => b;
      b.eq = (k: string, v: unknown) => {
        filters[k] = v;
        return b;
      };
      b.maybeSingle = async () => {
        if (table === "retell_calls") return { data: state.calls.get(String(filters.call_id)) ?? null, error: null };
        if (table === "raw_leads") return { data: { contact_id: "contact_1" }, error: null };
        return { data: null, error: null };
      };
      b.then = (resolve: (v: unknown) => unknown) => {
        // activity_events lookup (awaited directly after .limit()).
        if (table === "activity_events") {
          const hit = state.emitted.some(
            (e) => ["call.missed", "call.completed"].includes(e.eventType) && e.metadata.callId === filters["metadata_json->>callId"],
          );
          return Promise.resolve({ data: hit ? [{ id: "ev" }] : [], error: null }).then(resolve);
        }
        return Promise.resolve({ data: [], error: null }).then(resolve);
      };
      b.upsert = async (row: Record<string, unknown>) => {
        const prev = state.calls.get(String(row.call_id)) ?? {};
        state.calls.set(String(row.call_id), { ...prev, ...row });
        return { error: null };
      };
      b.update = (patch: Record<string, unknown>) => ({
        eq: async (_k: string, id: string) => {
          state.calls.set(id, { ...(state.calls.get(id) ?? {}), ...patch });
          return { error: null };
        },
      });
      return b;
    },
  };
  return { state, admin };
});

vi.mock("@/server/services/retell/tenant", () => ({
  createRetellAdminClient: () => h.admin,
  resolveRetellTenant: async () => ({ organizationId: "org_1", companyId: "co_1", sourceSite: "a1marinecare", resolvedBy: "number" }),
}));
vi.mock("@/server/services/retell/config", () => ({
  getRetellConfig: () => ({ enabled: true, outboundEnabled: false, apiKey: "k", toleranceMs: 1, sourceSite: "x", leadSource: "retell_voice_agent" }),
}));
vi.mock("@/server/services/lead-intake/intake", () => ({
  handleLeadIntake: async () => ({ leadId: "lead_1", duplicate: false }),
}));
vi.mock("@/server/services/usage", () => ({ recordUsage: async () => undefined }));
vi.mock("@/server/services/workflow-engine/dispatch", () => ({
  emitActivityEventAndDispatch: async (_ctx: unknown, input: { eventType: string; metadata: Record<string, unknown> }) => {
    h.state.emitted.push({ eventType: input.eventType, metadata: input.metadata });
    return { activityEvent: null, workflowEventJob: null };
  },
}));

import { captureRetellLead, ingestRetellCall } from "@/server/services/retell/lead-adapter";

const CALL = { call_id: "call_42", from_number: "+17055551234", to_number: "+17059961010", agent_id: "agent_care", direction: "inbound" };
const captured = { call: CALL, args: { caller_name: "Dana Lee", boat_length_ft: 24 } };
const analyzed = {
  event: "call_analyzed",
  call: {
    ...CALL,
    duration_ms: 185_000,
    call_analysis: { call_summary: "Quoted a wrap.", call_successful: true, in_voicemail: false, custom_analysis_data: { caller_name: "Dana Lee" } },
  },
};

beforeEach(() => {
  h.state.calls.clear();
  h.state.emitted.length = 0;
});

describe("call.* triggers fire at the end of the call, once", () => {
  it("a mid-call capture files the lead but fires no call automation", async () => {
    await captureRetellLead(captured);
    expect(h.state.calls.get("call_42")?.lead_id).toBe("lead_1");
    expect(h.state.emitted).toEqual([]);
  });

  it("the post-call payload then fires call.completed — once, with the linked contact", async () => {
    await captureRetellLead(captured);
    await ingestRetellCall(analyzed);
    expect(h.state.emitted.map((e) => e.eventType)).toEqual(["call.completed"]);
    expect(h.state.emitted[0].metadata).toMatchObject({ callId: "call_42", contactId: "contact_1", durationMs: 185_000 });

    await ingestRetellCall(analyzed); // a redelivery
    expect(h.state.emitted).toHaveLength(1);
  });

  it("a call with no mid-call capture still fires on the post-call payload", async () => {
    await ingestRetellCall(analyzed);
    expect(h.state.emitted.map((e) => e.eventType)).toEqual(["call.completed"]);
  });
});
