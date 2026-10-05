import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

import { getWorkflowsModel } from "@/server/ai/config";
import { extractAiUsage, parseModelJson, type AiUsageMeta } from "@/server/ai/claude";
import { ALL_RECIPES } from "@/server/services/workflow-engine/recipes";
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

const proposedConditionSchema = z.object({
  field: z.string().min(1).max(100),
  operator: z.enum(["changed_to", "equals", "exists", "greater_than", "in", "less_than"]),
  value: z.unknown().optional(),
});

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
  // v2 messaging + delay actions (Tasks 8/9) — the same set the recipe library uses.
  z.object({
    type: z.literal("send_sms"),
    to: z.enum(["contact", "owner"]).optional(),
    body: z.string().min(1).max(2000),
  }),
  z.object({
    type: z.literal("send_email"),
    to: z.enum(["contact", "owner"]).optional(),
    subject: z.string().min(1).max(300),
    body: z.string().min(1).max(20000),
  }),
  z.object({
    type: z.literal("notify_owner"),
    channel: z.enum(["sms", "email", "both"]),
    subject: z.string().max(300).optional(),
    body: z.string().min(1).max(20000),
  }),
  z.object({
    type: z.literal("wait"),
    duration: z.string().max(20).optional(),
    until: z.string().max(200).optional(),
    resume_conditions: z.array(proposedConditionSchema).optional(),
  }),
]);

export type ProposedAction = z.infer<typeof proposedActionSchema>;

export const suggestedWorkflowSchema = z.object({
  name: z.string().min(1).max(200),
  rationale: z.string().min(1).max(600),
  triggerEvent: z.enum(supportedWorkflowTriggerEventTypes),
  actions: z.array(proposedActionSchema).min(1).max(6),
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

/**
 * Few-shot grounding for the author: the proven recipe library, compiled to the exact
 * proposal shape the model must emit. Derived from ALL_RECIPES so the examples can never
 * drift from the recipes we actually ship. Static per process → the cached system prompt
 * stays cache-friendly (Task 6).
 */
const RECIPE_EXAMPLES = ALL_RECIPES.map((recipe) => {
  const actions = recipe.definition.actions.map((action) => {
    switch (action.type) {
      case "send_sms":
        return { type: action.type, to: action.to ?? "contact", body: action.body };
      case "send_email":
        return { type: action.type, to: action.to ?? "contact", subject: action.subject, body: action.body };
      case "notify_owner":
        return { type: action.type, channel: action.channel, subject: action.subject, body: action.body };
      case "wait":
        return {
          type: action.type,
          ...(action.duration ? { duration: action.duration } : {}),
          ...(action.until ? { until: action.until } : {}),
          ...(action.resume_conditions ? { resume_conditions: action.resume_conditions } : {}),
        };
      case "create_task":
        return { type: action.type, title: action.title, priority: action.priority, due_in_days: action.due_in_days };
      default:
        return action;
    }
  });
  return { name: recipe.name, triggerEvent: recipe.trigger_event, actions };
});

const SYSTEM_PROMPT = `You design CRM automations for the A1 Group, a family of marine-services businesses (A1 Marine Care — boat detailing & maintenance; A1 Marine Storage — seasonal storage, shrink-wrap, winterization; A1 Coatings). You are given a snapshot of their actual CRM and the automations they already run. Propose automations that fit THIS business's current state.

Rules:
- Ground every suggestion in the snapshot. Reference what you actually see (a stage with leads piling up, bookings with no follow-up, an obvious gap). Never invent data.
- Do NOT duplicate an automation they already have. If an existing workflow covers a trigger well, leave it alone.
- Prefer a few high-value automations over many marginal ones. If their setup is already good, return fewer — or an empty list. An empty list is a valid, useful answer.
- The rationale is read by a busy business owner. One or two plain sentences on what it does and why it's worth it. No jargon.
- Only ever use the triggers and actions listed below. Anything else is discarded.
- Message bodies may use these template tokens: {{contact.first_name}}, {{contact.last_name}}, {{contact.phone}}, {{contact.email}}, {{company.name}}, {{company.booking_url}}, {{company.review_url}}, {{booking.scheduled_for | date}}, {{booking.scheduled_for | time}}, {{booking.manage_url}} (the customer's own link to confirm, reschedule or cancel the visit — use it in booking reminders).

Triggers:
- "contact.created" — a new lead arrives (from a website form or added by hand)
- "contact.stage_changed" — a lead moves between lead/qualified/active/closed
- "contact.stale" — a lead has had no activity for a while (scheduler-driven)
- "booking.created" — a job is booked
- "booking.completed" — a job is finished
- "booking.upcoming" — a booking is coming up soon (scheduler-driven; N hours before)
- "booking.en_route" — the crew tapped "On my way" for the job
- "booking.cancelled" — a booking is cancelled
- "booking.no_show" — the customer didn't show
- "call.missed" — an inbound call was missed or went to voicemail
- "call.completed" — an inbound call was answered
- "call.urgent" — a caller flagged something urgent
- "quote.sent" / "quote.viewed" / "quote.approved" / "quote.expiring" / "quote.deposit_paid" — quote lifecycle
- "invoice.sent" / "invoice.paid" / "invoice.overdue" / "invoice.payment_failed" — invoice lifecycle (templates: {{ invoice.number }}, {{ invoice.balance }}, {{ invoice.total }}, {{ invoice.due }}, {{ invoice.public_url }})
- "task.completed" — a task is ticked off

Actions:
- {"type":"create_task","title":string,"description"?:string,"priority"?:"low"|"medium"|"high"|"urgent","due_in_days"?:number} — put a job on the owner's list
- {"type":"ai_analyze","create_review_task"?:boolean} — Claude reads the lead and drafts a reply + SMS + proposed booking times for review. Only useful on contact.created. Requires their AI to be configured.
- {"type":"update_status","target_entity":"contact"|"booking"|"task","status":string} — move a record's status. Contact stages: lead, qualified, active, closed.
- {"type":"send_sms","to"?:"contact"|"owner","body":string} — text the customer (default) or the owner. Only sent with consent.
- {"type":"send_email","to"?:"contact"|"owner","subject":string,"body":string} — email the customer or owner.
- {"type":"notify_owner","channel":"sms"|"email"|"both","subject"?:string,"body":string} — alert the owner (no consent needed).
- {"type":"wait","duration"?:"2d"|"4h"|"30m","until"?:"booking.scheduled_for - 24h","resume_conditions"?:[{"field":string,"operator":string,"value"?:any}]} — pause the sequence, then continue. resume_conditions stop the sequence early if the customer has already acted (e.g. the lead's stage moved on).

These are the proven automations we ship as a starter library. Use them as your model for structure, tone, and sensible sequencing — adapt them to what THIS business needs; don't just repeat them, and don't propose one they already have:
${JSON.stringify(RECIPE_EXAMPLES, null, 2)}

Respond with ONLY a JSON object — no markdown, no code fences, no prose:
{
  "suggestions": [
    {
      "name": string,               // short, e.g. "Follow up after every job"
      "rationale": string,          // why THIS business wants it, grounded in the snapshot
      "triggerEvent": string,       // exactly one of the triggers above
      "actions": [ ... ]            // 1-6 actions from the list above
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

export async function proposeWorkflows(
  snapshot: BusinessSnapshot,
): Promise<{ suggestions: SuggestedWorkflow[]; usage: AiUsageMeta }> {
  const client = new Anthropic();
  const model = getWorkflowsModel();

  const response = await client.messages.create({
    model,
    // Several workflows, each with trigger, conditions and actions, don't fit in 4k.
    max_tokens: 16_000,
    // Without thinking on, the model reasons about the action set in its visible answer,
    // which is what turned this into "the AI response was not valid JSON".
    thinking: { type: "adaptive" },
    // Cache the static system prompt (Task 6) — identical across every snapshot.
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content: `Here is the business right now. Propose automations that fit it:\n\n${buildSnapshotPrompt(snapshot)}`,
      },
    ],
  });
  const usage = extractAiUsage(response, model);

  const result = suggestionsResponseSchema.parse(parseModelJson(response, "workflow suggestions"));

  // Belt and braces: the prompt says not to propose ai_analyze when AI is off,
  // but a suggestion that can only fail shouldn't reach the owner either way.
  if (snapshot.aiConfigured) {
    return { suggestions: result.suggestions, usage };
  }

  return {
    suggestions: result.suggestions.filter(
      (suggestion) => !suggestion.actions.some((action) => action.type === "ai_analyze"),
    ),
    usage,
  };
}
