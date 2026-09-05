import { beforeEach, describe, expect, it, vi } from "vitest";

// Only the two I/O boundaries this path touches are mocked; the wait logic runs for real.
const buildMessageTemplateData = vi.fn((..._args: unknown[]) =>
  Promise.resolve({ contact: null, company: null, booking: null, quote: null, fields: {} }),
);
const createTask = vi.fn((..._args: unknown[]) => Promise.resolve({ id: "task-1" }));

vi.mock("@/server/services/workflow-engine/context", () => ({
  buildMessageTemplateData: (...a: unknown[]) => buildMessageTemplateData(...a),
}));
vi.mock("@/server/services/tasks", () => ({
  createTask: (...a: unknown[]) => createTask(...a),
  assignTaskUser: (..._a: unknown[]) => Promise.resolve(),
  updateTaskStatus: (..._a: unknown[]) => Promise.resolve(),
}));

import { executeWorkflowActions } from "@/server/services/workflow-engine/actions";
import type { WorkflowAction, WorkflowEventContext } from "@/server/services/workflow-engine/types";
import type { Tables } from "@/server/db/database.types";

const NOW = Date.parse("2026-09-15T12:00:00.000Z");

function eventContext(): WorkflowEventContext {
  const ts = "2026-09-15T12:00:00.000Z";
  return {
    activityEvent: {
      actor_user_id: null,
      company_id: "co-1",
      created_at: ts,
      entity_id: "contact-1",
      entity_type: "contact",
      event_type: "contact.created",
      id: "evt-1",
      metadata_json: {},
      occurred_at: ts,
      organization_id: "org-1",
      related_entity_id: null,
      related_entity_type: null,
      updated_at: ts,
    },
    companyId: "co-1",
    entity: {},
    entityId: "contact-1",
    entityType: "contact",
    fields: {},
    metadata: {},
    relatedEntity: {},
    relatedEntityId: null,
    relatedEntityType: null,
  };
}

const workflow = { id: "wf-1" } as Tables<"workflows">;

// executeWorkflowActions(context, eventContext, actions, options) — first arg is the tenant context.
function exec(actions: WorkflowAction[], opts: { dryRun?: boolean; startIndex?: number } = {}) {
  const context = { organizationId: "org-1", actorProfileId: null, supabase: {} } as never;
  return executeWorkflowActions(context, eventContext(), actions, {
    dryRun: opts.dryRun ?? false,
    workflow,
    startIndex: opts.startIndex,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  buildMessageTemplateData.mockClear().mockResolvedValue({
    contact: null,
    company: null,
    booking: null,
    quote: null,
    fields: {},
  });
  createTask.mockClear();
});

describe("wait action (durable pause)", () => {
  it("pauses at the wait and does NOT run later steps", async () => {
    const result = await exec([
      { type: "wait", duration: "2d" },
      { type: "create_task", title: "Follow up" },
    ] as WorkflowAction[]);

    expect(result.pause).not.toBeNull();
    expect(result.pause?.nextIndex).toBe(1);
    expect(result.pause?.resumeAt).toBe("2026-09-17T12:00:00.000Z");
    expect(result.actionsExecutedCount).toBe(1);
    // The step after the wait must not have executed.
    expect(createTask).not.toHaveBeenCalled();
  });

  it("resumes from startIndex and runs the remaining steps to completion", async () => {
    const result = await exec(
      [
        { type: "wait", duration: "2d" },
        { type: "create_task", title: "Follow up" },
      ] as WorkflowAction[],
      { startIndex: 1 },
    );

    expect(result.pause).toBeNull();
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(result.createdTasksCount).toBe(1);
  });

  it("resolves an `until` expression against the event's record", async () => {
    buildMessageTemplateData.mockResolvedValue({
      contact: null,
      company: null,
      booking: { scheduled_for: "2026-09-20T10:00:00.000Z" },
      quote: null,
      fields: {},
    });

    const result = await exec([{ type: "wait", until: "booking.scheduled_for - 24h" }] as WorkflowAction[]);

    expect(result.pause?.resumeAt).toBe("2026-09-19T10:00:00.000Z");
  });

  it("carries resume_conditions into the pause", async () => {
    const conditions = [{ field: "stage", operator: "equals", value: "lead" }];
    const result = await exec([
      { type: "wait", duration: "1d", resume_conditions: conditions },
    ] as WorkflowAction[]);

    expect(result.pause?.resumeConditions).toEqual(conditions);
  });

  it("dry-run previews the resume time without pausing", async () => {
    const result = await exec([{ type: "wait", duration: "2d" }] as WorkflowAction[], { dryRun: true });

    expect(result.pause).toBeNull();
    expect(result.projectedActions[0]?.resolvedPayload).toMatchObject({ resume_at: "2026-09-17T12:00:00.000Z" });
  });
});
