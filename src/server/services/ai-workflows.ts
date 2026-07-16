import {
  proposeWorkflows,
  type BusinessSnapshot,
  type SuggestedWorkflow,
} from "@/server/ai/workflow-author";
import { isAIConfigured } from "@/server/ai/claude";
import type { Json, Tables } from "@/server/db/database.types";
import { ValidationError } from "@/server/organizations/context";
import { parseWorkflowDefinition } from "@/server/services/workflow-engine/definitions";
import type { TenantServiceContext } from "@/server/services/shared";

/** A suggestion plus the engine-ready definition it compiles to. */
export interface WorkflowSuggestion extends SuggestedWorkflow {
  definition: Json;
}

function tally(rows: Array<{ [key: string]: unknown }>, column: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const key = String(row[column] ?? "unknown");
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

async function selectAll<T>(
  context: TenantServiceContext,
  table: "companies" | "contacts" | "bookings" | "tasks" | "workflows",
  columns: string,
): Promise<T[]> {
  const { data, error } = await context.supabase
    .from(table)
    .select(columns)
    .eq("organization_id", context.organizationId);

  if (error) {
    throw error;
  }

  return (data ?? []) as T[];
}

export async function loadBusinessSnapshot(
  context: TenantServiceContext,
): Promise<BusinessSnapshot> {
  const { data: orgData, error: orgError } = await context.supabase
    .from("organizations")
    .select("name")
    .eq("id", context.organizationId)
    .maybeSingle();

  if (orgError) {
    throw orgError;
  }

  const [companies, contacts, bookings, tasks, workflows] = await Promise.all([
    selectAll<Pick<Tables<"companies">, "name" | "stage">>(context, "companies", "name, stage"),
    selectAll<Pick<Tables<"contacts">, "stage">>(context, "contacts", "stage"),
    selectAll<Pick<Tables<"bookings">, "status">>(context, "bookings", "status"),
    selectAll<Pick<Tables<"tasks">, "status">>(context, "tasks", "status"),
    selectAll<Pick<Tables<"workflows">, "name" | "trigger_event" | "status">>(
      context,
      "workflows",
      "name, trigger_event, status",
    ),
  ]);

  return {
    organizationName: (orgData as { name: string } | null)?.name ?? "this organization",
    companies: companies.map((company) => ({ name: company.name, stage: String(company.stage) })),
    contactsByStage: tally(contacts, "stage"),
    bookingsByStatus: tally(bookings, "status"),
    tasksByStatus: tally(tasks, "status"),
    existingWorkflows: workflows.map((workflow) => ({
      name: workflow.name,
      triggerEvent: workflow.trigger_event,
      status: String(workflow.status),
    })),
    aiConfigured: isAIConfigured(),
  };
}

/**
 * Ask Claude for automations that fit the current business, then keep only the
 * ones that survive the engine's OWN parser.
 *
 * parseWorkflowDefinition is what the worker runs against at execution time, so
 * validating here means a suggestion the owner accepts is a suggestion that will
 * actually fire. A proposal that doesn't compile is dropped rather than shown —
 * same reasoning as sanitizeProposedSlots: don't put model output in front of
 * someone until it's been checked against reality.
 */
export async function suggestWorkflows(
  context: TenantServiceContext,
): Promise<WorkflowSuggestion[]> {
  if (!isAIConfigured()) {
    throw new ValidationError(
      "AI is not configured. Set ANTHROPIC_API_KEY on the server to enable AI features.",
    );
  }

  const snapshot = await loadBusinessSnapshot(context);
  const suggestions = await proposeWorkflows(snapshot);

  const compiled: WorkflowSuggestion[] = [];
  for (const suggestion of suggestions) {
    const definition = {
      version: 1,
      conditions: [],
      actions: suggestion.actions,
    } as unknown as Json;

    try {
      parseWorkflowDefinition(definition);
    } catch {
      console.warn(`[ai-workflows] dropped un-compilable suggestion: ${suggestion.name}`);
      continue;
    }

    compiled.push({ ...suggestion, definition });
  }

  return compiled;
}
