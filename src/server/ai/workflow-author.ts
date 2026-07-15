import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

import { supportedWorkflowTriggerEventTypes } from "@/server/services/workflow-engine/types";

/**
 * Claude proposes automations from the business's real state.
 *
 * Proposals only — nothing is created until a human clicks Create, mirroring the
 * draft-first rule the owner set for outbound replies.
 *
 * The action set offered to the model is deliberately narrower than the engine's:
 *  - assign_user is excluded — it needs a real profile uuid the model can't know,
 *    and a guessed one would fail at run time inside the worker.
 *  - create_activity_event is excluded — it writes timeline noise with no payoff.
 * That leaves the actions a suggestion can actually deliver on.
 */

const proposedActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("create_task"),
    title: z.string().min(1).max(200),
    description: z.string().max(1000).optional(),
    priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
    due_in_days: z.number().int().nonnegative().max(365).optional(),
  }),
  z.object({
    type: z.literal("ai_analyze"),
    create_review_task: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("update_status"),
    target_entity: z.enum(["contact", "booking", "task"]),
    status: z.string().min(1).max(40),
  }),
]);

export type ProposedAction = z.infer<typeof proposedActionSchema>;

export const suggestedWorkflowSchema = z.object({
  name: z.string().min(1).max(200),
  rationale: z.string().min(1).max(600),
  triggerEvent: z.enum(supportedWorkflowTriggerEventTypes),
  actions: z.array(proposedActionSchema).min(1).max(3),
});

export type SuggestedWorkflow = z.infer<typeof suggestedWorkflowSchema>;

const suggestionsResponseSchema = z.object({
  suggestions: z.array(suggestedWorkflowSchema).default([]),
});

export interface ExistingWorkflowSummary {
  name: string;
  triggerEvent: string;
  status: string;
}

export interface BusinessSnapshot {
  organizationName: string;
  companies: Array<{ name: string; stage: string }>;
  contactsByStage: Record<string, number>;
  bookingsByStatus: Record<string, number>;
  tasksByStatus: Record<string, number>;
  existingWorkflows: ExistingWorkflowSummary[];
  aiConfigured: boolean;
}

const SYSTEM_PROMPT = `You design CRM automations for the A1 Group, a family of marine-services businesses (A1 Marine Care — boat detailing & maintenance; A1 Marine Storage — seasonal storage, shrink-wrap, winterization; A1 Coatings). You are given a snapshot of their actual CRM and the automations they already run. Propose automations that fit THIS business's current state.

Rules:
- Ground every suggestion in the snapshot. Reference what you actually see (a stage with leads piling up, bookings with no follow-up, an obvious gap). Never invent data.
- Do NOT duplicate an automation they already have. If an existing workflow covers a trigger well, leave it alone.
- Prefer a few high-value automations over many marginal ones. If their setup is already good, return fewer — or an empty list. An empty list is a valid, useful answer.
- The rationale is read by a busy business owner. One or two plain sentences on what it does and why it's worth it. No jargon.
- Only ever use the triggers and actions listed below. Anything else is discarded.

Triggers:
- "contact.created" — a new lead arrives (from a website form or added by hand)
- "contact.stage_changed" — a lead moves between lead/qualified/active/closed
- "booking.created" — a job is booked
- "booking.completed" — a job is finished
- "task.completed" — a task is ticked off

Actions:
- {"type":"create_task","title":string,"description"?:string,"priority"?:"low"|"medium"|"high"|"urgent","due_in_days"?:number} — put a job on the owner's list
- {"type":"ai_analyze","create_review_task"?:boolean} — Claude reads the lead and drafts a reply + SMS + proposed booking times for review. Only useful on contact.created. Requires their AI to be configured.
- {"type":"update_status","target_entity":"contact"|"booking"|"task","status":string} — move a record's status. Contact stages: lead, qualified, active, closed.

Respond with ONLY a JSON object — no markdown, no code fences, no prose:
{
  "suggestions": [
    {
      "name": string,               // short, e.g. "Follow up after every job"
      "rationale": string,          // why THIS business wants it, grounded in the snapshot
      "triggerEvent": string,       // exactly one of the triggers above
      "actions": [ ... ]            // 1-3 actions from the list above
    }
  ]
}`;

function buildSnapshotPrompt(snapshot: BusinessSnapshot): string {
  const countLine = (label: string, counts: Record<string, number>) => {
    const entries = Object.entries(counts).filter(([, n]) => n > 0);
    return `${label}: ${entries.length ? entries.map(([k, n]) => `${n} ${k}`).join(", ") : "none yet"}`;
  };

  const lines = [
    `Organization: ${snapshot.organizationName}`,
    `Companies: ${snapshot.companies.length ? snapshot.companies.map((c) => `${c.name} (${c.stage})`).join(", ") : "none"}`,
    countLine("Contacts by stage", snapshot.contactsByStage),
    countLine("Bookings by status", snapshot.bookingsByStatus),
    countLine("Tasks by status", snapshot.tasksByStatus),
    "",
    snapshot.aiConfigured
      ? "AI is configured, so ai_analyze actions will run."
      : "AI is NOT configured on this deployment — do not propose ai_analyze actions; they would fail.",
    "",
    "Automations they already have:",
  ];

  if (snapshot.existingWorkflows.length === 0) {
    lines.push("  (none — this is a blank slate)");
  } else {
    for (const workflow of snapshot.existingWorkflows) {
      lines.push(`  - "${workflow.name}" on ${workflow.triggerEvent} [${workflow.status}]`);
    }
  }

  return lines.join("\n");
}

function stripJsonFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

export async function proposeWorkflows(snapshot: BusinessSnapshot): Promise<SuggestedWorkflow[]> {
  const client = new Anthropic();

  const response = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Here is the business right now. Propose automations that fit it:\n\n${buildSnapshotPrompt(snapshot)}`,
      },
    ],
  });

  const textBlock = response.content.find((block) => block.type === "text");
  const raw = textBlock && textBlock.type === "text" ? textBlock.text : "";

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFences(raw));
  } catch {
    throw new Error("The AI response was not valid JSON.");
  }

  const result = suggestionsResponseSchema.parse(parsed);

  // Belt and braces: the prompt says not to propose ai_analyze when AI is off,
  // but a suggestion that can only fail shouldn't reach the owner either way.
  if (snapshot.aiConfigured) {
    return result.suggestions;
  }

  return result.suggestions.filter(
    (suggestion) => !suggestion.actions.some((action) => action.type === "ai_analyze"),
  );
}
