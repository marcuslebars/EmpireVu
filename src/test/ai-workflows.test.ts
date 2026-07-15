/**
 * AI workflow authoring — the guarantee is that a suggestion the owner can click
 * "Create" on is one the engine will actually run. Anything the model returns that
 * doesn't compile against parseWorkflowDefinition is dropped before it's shown.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, any>;

const { proposeWorkflowsMock } = vi.hoisted(() => ({ proposeWorkflowsMock: vi.fn() }));

vi.mock("@/server/ai/workflow-author", async () => {
  const actual = await vi.importActual<typeof import("@/server/ai/workflow-author")>(
    "@/server/ai/workflow-author",
  );
  return { ...actual, proposeWorkflows: proposeWorkflowsMock };
});

import { loadBusinessSnapshot, suggestWorkflows } from "@/server/services/ai-workflows";
import type { TenantServiceContext } from "@/server/services/shared";

function createFakeClient(seed: Record<string, Row[]>) {
  const store: Record<string, Row[]> = {
    organizations: [], companies: [], contacts: [], bookings: [], tasks: [], workflows: [], ...seed,
  };
  function from(table: string) {
    const filters: Array<[string, unknown]> = [];
    const rows = () => (store[table] ??= []);
    const applyFilters = () => rows().filter((r) => filters.every(([c, v]) => r[c] === v));
    const b: Row = {
      select() { return b; },
      eq(c: string, v: unknown) { filters.push([c, v]); return b; },
      maybeSingle: async () => ({ data: applyFilters()[0] ?? null, error: null }),
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve({ data: applyFilters(), error: null }).then(onF, onR),
    };
    return b;
  }
  return { store, client: { from } as unknown as TenantServiceContext["supabase"] };
}

function seed() {
  return {
    organizations: [{ id: "org-a1", name: "A1 Group" }],
    companies: [
      { id: "co-care", organization_id: "org-a1", name: "A1 Marine Care", stage: "active" },
      { id: "co-storage", organization_id: "org-a1", name: "A1 Marine Storage", stage: "active" },
    ],
    contacts: [
      { id: "c1", organization_id: "org-a1", stage: "lead" },
      { id: "c2", organization_id: "org-a1", stage: "lead" },
      { id: "c3", organization_id: "org-a1", stage: "qualified" },
    ],
    bookings: [{ id: "b1", organization_id: "org-a1", status: "confirmed" }],
    tasks: [{ id: "t1", organization_id: "org-a1", status: "todo" }],
    workflows: [
      { id: "w1", organization_id: "org-a1", name: "Greet new leads", trigger_event: "contact.created", status: "active" },
    ],
  };
}

let fake: ReturnType<typeof createFakeClient>;
let context: TenantServiceContext;

const VALID = {
  name: "Follow up after every job",
  rationale: "You complete bookings but nothing chases the review.",
  triggerEvent: "booking.completed",
  actions: [{ type: "create_task", title: "Ask for a review", priority: "medium" }],
};

beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
  proposeWorkflowsMock.mockReset();
  fake = createFakeClient(seed());
  context = { actorProfileId: "profile-1", organizationId: "org-a1", supabase: fake.client };
});

afterEach(() => vi.unstubAllEnvs());

describe("business snapshot", () => {
  it("tallies the org's real state for the model", async () => {
    const snapshot = await loadBusinessSnapshot(context);

    expect(snapshot.organizationName).toBe("A1 Group");
    expect(snapshot.companies).toHaveLength(2);
    expect(snapshot.contactsByStage).toEqual({ lead: 2, qualified: 1 });
    expect(snapshot.bookingsByStatus).toEqual({ confirmed: 1 });
    expect(snapshot.tasksByStatus).toEqual({ todo: 1 });
    expect(snapshot.existingWorkflows).toEqual([
      { name: "Greet new leads", triggerEvent: "contact.created", status: "active" },
    ]);
    expect(snapshot.aiConfigured).toBe(true);
  });

  it("reports AI as unconfigured so the model won't propose ai_analyze", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const snapshot = await loadBusinessSnapshot(context);
    expect(snapshot.aiConfigured).toBe(false);
  });
});

describe("suggestWorkflows", () => {
  it("compiles a valid suggestion into an engine-ready definition", async () => {
    proposeWorkflowsMock.mockResolvedValue([VALID]);

    const [suggestion] = await suggestWorkflows(context);

    expect(suggestion.name).toBe(VALID.name);
    expect(suggestion.definition).toEqual({
      version: 1,
      conditions: [],
      actions: VALID.actions,
    });
  });

  it("drops a suggestion whose actions don't compile against the engine schema", async () => {
    proposeWorkflowsMock.mockResolvedValue([
      VALID,
      // create_task with no title — the engine's schema requires one.
      { ...VALID, name: "Broken", actions: [{ type: "create_task" }] },
      // An action type the engine has never heard of.
      { ...VALID, name: "Invented", actions: [{ type: "send_carrier_pigeon", to: "jane" }] },
    ]);

    const result = await suggestWorkflows(context);

    expect(result.map((s) => s.name)).toEqual(["Follow up after every job"]);
  });

  it("returns an empty list when the model has nothing to add", async () => {
    proposeWorkflowsMock.mockResolvedValue([]);
    await expect(suggestWorkflows(context)).resolves.toEqual([]);
  });

  it("refuses to run when AI is not configured", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    await expect(suggestWorkflows(context)).rejects.toThrow(/AI is not configured/);
    expect(proposeWorkflowsMock).not.toHaveBeenCalled();
  });

  it("passes the real snapshot to the model rather than a canned one", async () => {
    proposeWorkflowsMock.mockResolvedValue([]);
    await suggestWorkflows(context);

    const snapshot = proposeWorkflowsMock.mock.calls[0][0];
    expect(snapshot.organizationName).toBe("A1 Group");
    expect(snapshot.contactsByStage.lead).toBe(2);
    // So it can avoid duplicating what already exists.
    expect(snapshot.existingWorkflows[0].name).toBe("Greet new leads");
  });
});
