import { beforeEach, describe, expect, it, vi } from "vitest";

// Recipe "run-test" = a dry-run of the actions. Mock the two boundaries a dry-run still
// touches (template data + owner lookup); no real send happens on dryRun.
const buildMessageTemplateData = vi.fn((..._args: unknown[]) =>
  Promise.resolve({
    contact: { id: "contact-1", first_name: "Jane", last_name: "Doe", phone: "+17055550123", email: "jane@example.com" },
    company: { id: "co-1", name: "A1 Marine", review_url: "https://g.page/a1/review", booking_url: "https://book.a1" },
    booking: { id: "bk-1", scheduled_for: "2026-09-20T15:00:00.000Z", status: "confirmed" },
    quote: null,
    fields: {},
  }),
);
vi.mock("@/server/services/workflow-engine/context", () => ({
  buildMessageTemplateData: (...a: unknown[]) => buildMessageTemplateData(...a),
}));
vi.mock("@/server/services/workflow-engine/messaging", () => ({
  resolveOwnerContacts: (..._a: unknown[]) => Promise.resolve({ email: "owner@a1.test", phone: "+17055550100" }),
  deliverMessage: (..._a: unknown[]) => Promise.resolve({ status: "sent" }),
}));

import type { Json } from "@/server/db/database.types";
import { executeWorkflowActions } from "@/server/services/workflow-engine/actions";
import { isSupportedWorkflowTrigger, parseWorkflowDefinition } from "@/server/services/workflow-engine/definitions";
import { ALL_RECIPES } from "@/server/services/workflow-engine/recipes";
import type { Tables } from "@/server/db/database.types";
import type { WorkflowEventContext } from "@/server/services/workflow-engine/types";
import { suggestedWorkflowSchema } from "@/server/ai/workflow-author";

const workflow = { id: "wf-1" } as Tables<"workflows">;
const context = { organizationId: "org-1", actorProfileId: null, supabase: {} } as never;

function eventContext(): WorkflowEventContext {
  const ts = "2026-09-15T12:00:00.000Z";
  return {
    activityEvent: {
      actor_user_id: null, company_id: "co-1", created_at: ts, entity_id: "contact-1", entity_type: "contact",
      event_type: "contact.created", id: "evt-1", metadata_json: {}, occurred_at: ts, organization_id: "org-1",
      related_entity_id: null, related_entity_type: null, updated_at: ts,
    },
    companyId: "co-1", entity: {}, entityId: "contact-1", entityType: "contact", fields: {},
    metadata: {}, relatedEntity: {}, relatedEntityId: null, relatedEntityType: null,
  };
}

beforeEach(() => {
  buildMessageTemplateData.mockClear();
});

describe("recipe catalog integrity", () => {
  it("has unique slugs", () => {
    const slugs = ALL_RECIPES.map((r) => r.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it.each(ALL_RECIPES.map((r) => [r.slug, r] as const))(
    "%s compiles, has a supported trigger, and dry-runs cleanly (run-test)",
    async (_slug, recipe) => {
      // Compiles against the engine's own parser (what the worker runs).
      expect(() => parseWorkflowDefinition(recipe.definition as unknown as Json)).not.toThrow();
      expect(isSupportedWorkflowTrigger(recipe.trigger_event)).toBe(true);
      expect(recipe.definition.estimated_time_saved_seconds).toBeGreaterThan(0);

      // Dry-run every step against a fixture event — no send, just projection.
      const result = await executeWorkflowActions(context, eventContext(), recipe.definition.actions, {
        dryRun: true,
        workflow,
      });
      expect(result.projectedActions).toHaveLength(recipe.definition.actions.length);
      expect(result.pause).toBeNull();
    },
  );

  it("interpolates the review link for review-request", async () => {
    const reviewRequest = ALL_RECIPES.find((r) => r.slug === "review-request");
    if (!reviewRequest) throw new Error("review-request recipe missing");
    const result = await executeWorkflowActions(context, eventContext(), reviewRequest.definition.actions, {
      dryRun: true,
      workflow,
    });
    const sms = result.projectedActions.find((p) => p.action.type === "send_sms");
    expect(String((sms?.resolvedPayload as { body?: string })?.body)).toContain("https://g.page/a1/review");
  });
});

describe("AI author output validates against the v2 schema", () => {
  it("accepts a v2 proposal (wait + send_sms)", () => {
    const parsed = suggestedWorkflowSchema.safeParse({
      name: "Quote nudge",
      rationale: "Leads with sent quotes aren't being followed up.",
      triggerEvent: "quote.sent",
      actions: [
        { type: "wait", duration: "2d" },
        { type: "send_sms", to: "contact", body: "Just checking in on your quote." },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an unknown action type", () => {
    const parsed = suggestedWorkflowSchema.safeParse({
      name: "x",
      rationale: "y",
      triggerEvent: "contact.created",
      actions: [{ type: "delete_everything" }],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects an unsupported trigger", () => {
    const parsed = suggestedWorkflowSchema.safeParse({
      name: "x",
      rationale: "y",
      triggerEvent: "contact.deleted",
      actions: [{ type: "ai_analyze" }],
    });
    expect(parsed.success).toBe(false);
  });
});
