import { describe, expect, it } from "vitest";

import { ValidationError } from "@/server/organizations/context";
import {
  assertSupportedWorkflowTrigger,
  manualWorkflowEventInputSchema,
  parseWorkflowDefinition,
} from "@/server/services/workflow-engine/definitions";
import { evaluateWorkflowConditions } from "@/server/services/workflow-engine/conditions";
import { shouldDispatchWorkflowEvent } from "@/server/services/workflow-engine/dispatch";
import type { WorkflowEventContext } from "@/server/services/workflow-engine/types";

function createEventContext(fields: WorkflowEventContext["fields"]): WorkflowEventContext {
  return {
    activityEvent: {
      actor_user_id: null,
      company_id: "11111111-1111-1111-1111-111111111111",
      created_at: "2026-03-22T00:00:00.000Z",
      entity_id: "22222222-2222-2222-2222-222222222222",
      entity_type: "contact",
      event_type: "contact.stage_changed",
      id: "33333333-3333-3333-3333-333333333333",
      metadata_json: {},
      occurred_at: "2026-03-22T00:00:00.000Z",
      organization_id: "44444444-4444-4444-4444-444444444444",
      related_entity_id: null,
      related_entity_type: null,
      updated_at: "2026-03-22T00:00:00.000Z",
    },
    companyId: "11111111-1111-1111-1111-111111111111",
    entity: {},
    entityId: "22222222-2222-2222-2222-222222222222",
    entityType: "contact",
    fields,
    metadata: {},
    relatedEntity: {},
    relatedEntityId: null,
    relatedEntityType: null,
  };
}

describe("workflow definitions", () => {
  it("normalizes legacy action and condition arrays from *_json fields", () => {
    const definition = parseWorkflowDefinition({
      actions_json: [
        {
          title: "Call {{stage_changed_to}} lead",
          type: "create_task",
        },
      ],
      conditions_json: [
        {
          field: "stage_changed_to",
          operator: "equals",
          value: "qualified",
        },
      ],
      estimated_time_saved_seconds: 120,
    });

    expect(definition.version).toBe(1);
    expect(definition.estimated_time_saved_seconds).toBe(120);
    expect(definition.actions).toHaveLength(1);
    expect(definition.conditions).toHaveLength(1);
    expect(definition.actions[0]).toMatchObject({ type: "create_task" });
    expect(definition.conditions[0]).toMatchObject({ operator: "equals" });
  });

  it("accepts supported manual workflow event input", () => {
    const result = manualWorkflowEventInputSchema.parse({
      companyId: "11111111-1111-1111-1111-111111111111",
      entityId: "22222222-2222-2222-2222-222222222222",
      entityType: "contact",
      eventType: "contact.created",
      metadata: {
        source: "test",
      },
    });

    expect(result.eventType).toBe("contact.created");
  });

  it("rejects unsupported triggers", () => {
    expect(() => assertSupportedWorkflowTrigger("contact.deleted")).toThrow(ValidationError);
  });

  it("only marks supported trigger events for async dispatch", () => {
    expect(shouldDispatchWorkflowEvent("contact.created")).toBe(true);
    expect(shouldDispatchWorkflowEvent("task.completed")).toBe(true);
    expect(shouldDispatchWorkflowEvent("workflow.executed")).toBe(false);
  });
});

describe("workflow conditions", () => {
  it("matches equals, changed_to, greater_than, in, and exists conditions", () => {
    const context = createEventContext({
      assigned_user_id: "55555555-5555-5555-5555-555555555555",
      priority: "high",
      stage: "qualified",
      stage_changed_to: "qualified",
      value_cents: 25000,
    });

    const result = evaluateWorkflowConditions(
      [
        { field: "stage", operator: "equals", value: "qualified" },
        { field: "stage_changed_to", operator: "changed_to", value: "qualified" },
        { field: "value_cents", operator: "greater_than", value: 10000 },
        { field: "priority", operator: "in", value: ["high", "urgent"] },
        { field: "assigned_user_id", operator: "exists" },
      ],
      context,
    );

    expect(result.matched).toBe(true);
    expect(result.results.every((entry) => entry.matched)).toBe(true);
  });

  it("fails less_than and exists checks when data is missing or over threshold", () => {
    const context = createEventContext({
      notes: "",
      value_cents: 25000,
    });

    const result = evaluateWorkflowConditions(
      [
        { field: "value_cents", operator: "less_than", value: 20000 },
        { field: "assigned_user_id", operator: "exists" },
      ],
      context,
    );

    expect(result.matched).toBe(false);
    expect(result.results).toEqual([
      expect.objectContaining({ matched: false }),
      expect.objectContaining({ matched: false }),
    ]);
  });
});