import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the I/O boundaries around resumeWorkflowRun; let conditions + definition parsing run real.
const getWorkflowById = vi.fn((..._a: unknown[]) =>
  Promise.resolve({
    id: "wf-1",
    trigger_event: "contact.created",
    definition: { version: 1, conditions: [], actions: [{ type: "create_task", title: "x" }] },
  }),
);
const getActivityEventById = vi.fn((..._a: unknown[]) =>
  Promise.resolve({ id: "evt-1", event_type: "contact.created", company_id: "co-1" }),
);
const buildWorkflowEventContext = vi.fn((..._a: unknown[]) => Promise.resolve(makeEventContext({ stage: "lead" })));
const executeWorkflowActions = vi.fn((..._a: unknown[]) =>
  Promise.resolve({ actionsExecutedCount: 0, createdTasksCount: 0, projectedActions: [], timeSavedSeconds: 0, pause: null }),
);
const updateWorkflowRun = vi.fn((..._a: unknown[]) => Promise.resolve({}));
let templateBooking: Record<string, unknown> | null = null;

vi.mock("@/server/services/workflows", () => ({ getWorkflowById: (...a: unknown[]) => getWorkflowById(...a) }));
vi.mock("@/server/services/activity-events", () => ({
  getActivityEventById: (...a: unknown[]) => getActivityEventById(...a),
  createActivityEvent: (..._a: unknown[]) => Promise.resolve({ id: "evt-x" }),
}));
vi.mock("@/server/services/workflow-engine/context", () => ({
  buildWorkflowEventContext: (...a: unknown[]) => buildWorkflowEventContext(...a),
  buildMessageTemplateData: () =>
    Promise.resolve({ contact: null, company: { timezone: "America/Toronto" }, booking: templateBooking, quote: null, invoice: null, call: null, fields: {} }),
}));
vi.mock("@/server/services/workflow-engine/actions", () => ({
  executeWorkflowActions: (...a: unknown[]) => executeWorkflowActions(...a),
}));
vi.mock("@/server/services/workflow-runs", () => ({
  updateWorkflowRun: (...a: unknown[]) => updateWorkflowRun(...a),
  createWorkflowRun: (..._a: unknown[]) => Promise.resolve({}),
  findWorkflowRunByTriggerEvent: (..._a: unknown[]) => Promise.resolve(null),
}));

import { resumeWorkflowRun } from "@/server/services/workflow-engine/processor";
import type { WorkflowEventContext } from "@/server/services/workflow-engine/types";
import type { Json, Tables } from "@/server/db/database.types";

function makeEventContext(fields: Record<string, Json>): WorkflowEventContext {
  const ts = "2026-09-15T12:00:00.000Z";
  return {
    activityEvent: {
      actor_user_id: null, company_id: "co-1", created_at: ts, entity_id: "contact-1", entity_type: "contact",
      event_type: "contact.created", id: "evt-1", metadata_json: {}, occurred_at: ts, organization_id: "org-1",
      related_entity_id: null, related_entity_type: null, updated_at: ts,
    },
    companyId: "co-1", entity: {}, entityId: "contact-1", entityType: "contact", fields,
    metadata: {}, relatedEntity: {}, relatedEntityId: null, relatedEntityType: null,
  };
}

function waitingRun(over: Partial<Tables<"workflow_runs">> = {}): Tables<"workflow_runs"> {
  return {
    actions_executed_count: 1,
    company_id: "co-1",
    completed_at: null,
    context_json: {},
    created_at: "2026-09-15T12:00:00.000Z",
    created_tasks_count: 0,
    current_step_index: 1,
    failure_reason: null,
    id: "run-1",
    logs_json: [],
    organization_id: "org-1",
    resume_at: "2026-09-15T12:00:00.000Z",
    started_at: "2026-09-15T12:00:00.000Z",
    status: "waiting",
    time_saved_seconds: 0,
    trigger_event_id: "evt-1",
    updated_at: "2026-09-15T12:00:00.000Z",
    workflow_id: "wf-1",
    ...over,
  } as Tables<"workflow_runs">;
}

const context = { organizationId: "org-1", actorProfileId: null, supabase: {} } as never;
const lastPatch = () => updateWorkflowRun.mock.calls.at(-1)?.[2] as Record<string, unknown>;

beforeEach(() => {
  getWorkflowById.mockClear();
  getActivityEventById.mockClear();
  buildWorkflowEventContext.mockClear().mockResolvedValue(makeEventContext({ stage: "lead" }));
  executeWorkflowActions.mockClear().mockResolvedValue({
    actionsExecutedCount: 0, createdTasksCount: 0, projectedActions: [], timeSavedSeconds: 0, pause: null,
  });
  updateWorkflowRun.mockClear().mockResolvedValue({});
});

describe("resumeWorkflowRun", () => {
  it("aborts the sequence when resume_conditions no longer match", async () => {
    // The customer has moved on: stage is now 'won', but the sequence only continues while 'lead'.
    buildWorkflowEventContext.mockResolvedValue(makeEventContext({ stage: "won" }));
    const run = waitingRun({
      context_json: { _resume_conditions: [{ field: "stage", operator: "equals", value: "lead" }] },
    });

    await resumeWorkflowRun(context, run);

    expect(executeWorkflowActions).not.toHaveBeenCalled();
    expect(lastPatch()).toMatchObject({ status: "completed", resume_at: null });
  });

  it("resumes from current_step_index with the original event context when conditions still hold", async () => {
    const run = waitingRun({
      current_step_index: 1,
      context_json: { _resume_conditions: [{ field: "stage", operator: "equals", value: "lead" }] },
    });

    await resumeWorkflowRun(context, run);

    expect(executeWorkflowActions).toHaveBeenCalledTimes(1);
    // 4th arg carries the options — resume must start where the wait left off.
    const options = executeWorkflowActions.mock.calls[0][3] as { startIndex?: number };
    expect(options.startIndex).toBe(1);
    expect(lastPatch()).toMatchObject({ status: "completed", resume_at: null });
  });

  it("pauses again when a later step is another wait", async () => {
    executeWorkflowActions.mockResolvedValue({
      actionsExecutedCount: 0, createdTasksCount: 0, projectedActions: [], timeSavedSeconds: 0,
      pause: { nextIndex: 3, resumeAt: "2026-09-18T12:00:00.000Z", resumeConditions: null },
    });

    await resumeWorkflowRun(context, waitingRun({ current_step_index: 2 }));

    expect(lastPatch()).toMatchObject({
      status: "waiting",
      current_step_index: 3,
      resume_at: "2026-09-18T12:00:00.000Z",
    });
  });

  it("completes without an anchor event rather than looping forever", async () => {
    await resumeWorkflowRun(context, waitingRun({ trigger_event_id: null }));

    expect(getWorkflowById).not.toHaveBeenCalled();
    expect(lastPatch()).toMatchObject({ status: "completed", resume_at: null });
  });

  describe("waits timed against a booking", () => {
    const until = { _wait_until: { expr: "booking.scheduled_for - 2h", within_hours: null } };

    it("re-times instead of firing when the booking moved later", async () => {
      const later = new Date(Date.now() + 26 * 3_600_000).toISOString();
      templateBooking = { scheduled_for: later, status: "confirmed" };
      await resumeWorkflowRun(context, waitingRun({ context_json: until }));
      expect(executeWorkflowActions).not.toHaveBeenCalled();
      expect(lastPatch()).toMatchObject({ status: "waiting", resume_at: new Date(Date.parse(later) - 2 * 3_600_000).toISOString() });
    });

    it("fires when the time it waited for has come (booking unchanged or moved earlier)", async () => {
      templateBooking = { scheduled_for: new Date(Date.now() + 90 * 60_000).toISOString(), status: "confirmed" };
      await resumeWorkflowRun(context, waitingRun({ context_json: until }));
      expect(executeWorkflowActions).toHaveBeenCalledTimes(1);
    });

    it("leaves plain duration waits alone", async () => {
      templateBooking = { scheduled_for: new Date(Date.now() + 26 * 3_600_000).toISOString() };
      await resumeWorkflowRun(context, waitingRun({ context_json: { _wait_until: null } }));
      expect(executeWorkflowActions).toHaveBeenCalledTimes(1);
    });

    it("still stops on resume_conditions before re-timing", async () => {
      templateBooking = { scheduled_for: new Date(Date.now() + 26 * 3_600_000).toISOString() };
      buildWorkflowEventContext.mockResolvedValue(makeEventContext({ status: "cancelled" }));
      await resumeWorkflowRun(
        context,
        waitingRun({ context_json: { ...until, _resume_conditions: [{ field: "status", operator: "in", value: ["pending", "confirmed"] }] } }),
      );
      expect(lastPatch()).toMatchObject({ status: "completed" });
    });
  });
});
