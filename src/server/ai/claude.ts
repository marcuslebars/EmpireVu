import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

import { getDraftsModel } from "@/server/ai/config";
import type { AiTokenUsage } from "@/server/ai/pricing";

/**
 * Server-side Claude integration. All AI runs here (never in the browser); the
 * API key is read from the ANTHROPIC_API_KEY environment variable on the server.
 */

export function isAIConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/** The response id + model + token counts from one model call, for usage metering. */
export interface AiUsageMeta {
  responseId: string;
  model: string;
  usage: AiTokenUsage;
}

/** Pull the metering fields off an Anthropic response (usage may be partial). */
export function extractAiUsage(response: Anthropic.Message, fallbackModel: string): AiUsageMeta {
  const usage = response.usage;
  return {
    responseId: response.id,
    model: response.model ?? fallbackModel,
    usage: {
      inputTokens: usage?.input_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
      cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
      cacheWriteTokens: usage?.cache_creation_input_tokens ?? 0,
    },
  };
}

/** A booking time the AI proposes. A proposal only — a human confirms it into a real booking. */
export const proposedSlotSchema = z.object({
  startsAt: z.string(),
  durationMinutes: z.number().int().positive().max(1440),
  reason: z.string(),
});

export type ProposedSlot = z.infer<typeof proposedSlotSchema>;

export const leadAnalysisSchema = z.object({
  summary: z.string(),
  intent: z.string(),
  urgency: z.enum(["low", "medium", "high"]),
  fitScore: z.number(),
  suggestedStage: z.enum(["lead", "qualified", "active", "closed"]),
  suggestedActions: z.array(z.string()),
  draftedEmail: z.object({ subject: z.string(), body: z.string() }),
  draftedSms: z.string(),
  proposedSlots: z.array(proposedSlotSchema).default([]),
});

export type LeadAnalysis = z.infer<typeof leadAnalysisSchema>;

/** An existing booking the proposed slots must not collide with. */
export interface BusySlot {
  startsAt: string;
  durationMinutes: number;
  title: string;
}

export interface SchedulingContext {
  /** "now" as an ISO timestamp — passed in so the caller controls the clock (and tests can pin it). */
  nowIso: string;
  /** IANA zone the business books in; slot proposals are reasoned about in local time. */
  timezone: string;
  busy: BusySlot[];
}

export interface LeadForAnalysis {
  firstName: string;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  stage: string;
  notes: string | null;
  companyName: string | null;
  createdAt: string;
  metadata: Record<string, unknown>;
  scheduling: SchedulingContext;
  /** The customer's self-booking URL, or null if the app base URL isn't configured. */
  bookingUrl: string | null;
}

function slotEndMs(startsAt: string, durationMinutes: number): number {
  return new Date(startsAt).getTime() + durationMinutes * 60_000;
}

/**
 * Drop proposals we can't stand behind, regardless of what the model returned:
 * unparseable timestamps, anything in the past, and anything overlapping an
 * existing booking. The model is told the busy list, but a double-booked customer
 * is a real-world mess — so the conflict check is enforced here, not trusted.
 */
export function sanitizeProposedSlots(
  slots: ProposedSlot[],
  scheduling: SchedulingContext,
): ProposedSlot[] {
  const nowMs = new Date(scheduling.nowIso).getTime();

  return slots.filter((slot) => {
    const startMs = new Date(slot.startsAt).getTime();
    if (!Number.isFinite(startMs) || startMs <= nowMs) {
      return false;
    }

    const endMs = slotEndMs(slot.startsAt, slot.durationMinutes);

    return !scheduling.busy.some((busy) => {
      const busyStartMs = new Date(busy.startsAt).getTime();
      if (!Number.isFinite(busyStartMs)) {
        return false;
      }
      const busyEndMs = slotEndMs(busy.startsAt, busy.durationMinutes);
      return startMs < busyEndMs && busyStartMs < endMs;
    });
  });
}

function buildLeadPrompt(lead: LeadForAnalysis): string {
  const lines = [
    `Brand they contacted: ${lead.companyName ?? "Unknown"}`,
    `Name: ${[lead.firstName, lead.lastName].filter(Boolean).join(" ") || "Unknown"}`,
    `Email: ${lead.email ?? "—"}`,
    `Phone: ${lead.phone ?? "—"}`,
    `Current CRM stage: ${lead.stage}`,
    `Created: ${lead.createdAt}`,
    `Notes / message: ${lead.notes?.trim() || "(none provided)"}`,
  ];

  const meta = Object.entries(lead.metadata ?? {}).filter(
    ([, value]) => value != null && value !== "",
  );
  if (meta.length > 0) {
    lines.push(
      `Additional form fields: ${meta.map(([key, value]) => `${key}=${String(value)}`).join(", ")}`,
    );
  }

  lines.push(
    "",
    lead.bookingUrl
      ? `Self-booking link (put this EXACT url in the email and SMS as the booking call-to-action; never invent, shorten, or alter it): ${lead.bookingUrl}`
      : "Self-booking link: none available — propose a next step without a booking link.",
  );

  lines.push(
    "",
    "Scheduling context —",
    `Current time: ${lead.scheduling.nowIso}`,
    `Business timezone: ${lead.scheduling.timezone}`,
  );

  if (lead.scheduling.busy.length > 0) {
    lines.push("Already booked (do NOT propose times that overlap these):");
    for (const busy of lead.scheduling.busy) {
      lines.push(`  - ${busy.startsAt} for ${busy.durationMinutes} min — ${busy.title}`);
    }
  } else {
    lines.push("Already booked: nothing in the calendar for the next two weeks.");
  }

  return lines.join("\n");
}

const SYSTEM_PROMPT = `You are the lead-intelligence assistant for the A1 Group, a family of marine-services businesses (A1 Marine Care — boat detailing & maintenance; A1 Marine Storage; A1 Coatings). A new lead has come in through a website form. Analyze the lead in depth and prepare a first response the business owner can review before sending.

Ground everything only in the information provided — do not invent details about the lead. If information is missing, work with what you have; surface the gaps through your suggested actions rather than guessing.

For the drafted email and SMS, write in a warm, professional, human voice as if from the A1 team. The email should acknowledge their enquiry, address the obvious next question, and propose one clear next step (a call, a quote, or a booking). The SMS is a short friendly version, under ~300 characters. Do NOT fabricate prices, availability, or specific promises — keep next steps open ("we'll confirm…", "happy to set up a time…").

When a self-booking link is provided below, make booking the primary call-to-action: include that exact link in the drafted email (e.g. "Pick a time that suits you here: <link>") and in the SMS. Use the link verbatim — never invent, shorten, or alter it. When no link is provided, propose a next step without one.

You are also given the current time, the business timezone, and the jobs already on the calendar. Propose up to 3 booking slots to offer this lead. Rules: never overlap an existing booking; always in the future; keep them in normal working hours (roughly 09:00–17:00 local, Mon–Sat) in the business timezone; spread them over different days where you can. Give each a short reason the customer would understand. If the lead clearly doesn't want a booking yet, return an empty list rather than inventing one.

The response shape is fixed by a schema — fill in every field it asks for.`;

/**
 * The response schema, enforced by the API (`output_config.format`) rather than asked for in
 * the prompt. Field meaning lives in the descriptions, which the model sees.
 *
 * This is hand-written rather than derived from `leadAnalysisSchema` because the SDK's zod
 * helper targets zod v4 and this project is on v3. The zod schema still validates what comes
 * back, so a drift between the two surfaces as a parse error rather than as bad data.
 */
const LEAD_ANALYSIS_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "summary",
    "intent",
    "urgency",
    "fitScore",
    "suggestedStage",
    "suggestedActions",
    "draftedEmail",
    "draftedSms",
    "proposedSlots",
  ],
  properties: {
    summary: { type: "string", description: "1-2 sentences: who they are and what they want." },
    intent: { type: "string", description: "What they are looking for." },
    urgency: { type: "string", enum: ["low", "medium", "high"] },
    fitScore: {
      type: "number",
      minimum: 0,
      maximum: 100,
      description: "How well they match an ideal high-value customer, given the signals available.",
    },
    suggestedStage: { type: "string", enum: ["lead", "qualified", "active", "closed"] },
    suggestedActions: {
      type: "array",
      items: { type: "string" },
      description: "Concrete next steps for the team.",
    },
    draftedEmail: {
      type: "object",
      additionalProperties: false,
      required: ["subject", "body"],
      properties: { subject: { type: "string" }, body: { type: "string" } },
    },
    draftedSms: { type: "string", description: "Short friendly version, under ~300 characters." },
    proposedSlots: {
      type: "array",
      maxItems: 3,
      description: "Empty when a booking isn't the right next step.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["startsAt", "durationMinutes", "reason"],
        properties: {
          startsAt: {
            type: "string",
            description: 'ISO 8601 with an explicit UTC offset, e.g. "2026-07-18T14:00:00-04:00".',
          },
          durationMinutes: {
            type: "integer",
            minimum: 1,
            maximum: 1440,
            description: "Realistic for the job discussed.",
          },
          reason: { type: "string", description: "Short, customer-facing rationale." },
        },
      },
    },
  },
};

/**
 * Read one JSON object out of a model response.
 *
 * With `output_config.format` set the text block is already schema-valid JSON, so the fence
 * and prose tolerance below is a backstop for the paths that don't constrain the format yet.
 * Failures say why — a cut-off answer and a refusal need different fixes, and "not valid JSON"
 * on its own sent us looking in the wrong place.
 */
export function parseModelJson(response: Anthropic.Message, label: string): unknown {
  if (response.stop_reason === "refusal") {
    throw new Error(`Claude declined to produce the ${label}.`);
  }

  const textBlock = response.content.find((block) => block.type === "text");
  const raw = textBlock && textBlock.type === "text" ? textBlock.text.trim() : "";

  if (response.stop_reason === "max_tokens") {
    throw new Error(`The ${label} was cut off before it finished. Try again.`);
  }
  if (!raw) {
    throw new Error(`Claude returned no ${label}.`);
  }

  try {
    return extractJsonObject(raw);
  } catch (error) {
    // The text itself isn't in the thrown message: it can carry customer details, and this
    // surfaces in the UI. The prefix goes to the server log, where the stack already is.
    console.warn(`[ai] ${label}: could not parse response`, {
      model: response.model,
      stopReason: response.stop_reason,
      prefix: raw.slice(0, 200),
    });
    throw error instanceof Error ? error : new Error(`The AI response was not valid JSON (${label}).`);
  }
}

/**
 * Pull one JSON object out of model text: as-is, unfenced, or lifted from between the outer
 * braces when the model wrote something either side of it.
 */
export function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  const candidates = [trimmed, trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim()];

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // Try the next shape.
    }
  }

  throw new Error("The AI response was not valid JSON.");
}

export async function analyzeLead(
  lead: LeadForAnalysis,
): Promise<{ analysis: LeadAnalysis; usage: AiUsageMeta }> {
  // The zero-arg client reads ANTHROPIC_API_KEY from the environment.
  const client = new Anthropic();
  const model = getDraftsModel();

  const response = await client.messages.create({
    model,
    // Room to finish: a truncated response is a parse failure, and the schema below has an
    // email body and up to three slots to fill in.
    max_tokens: 16_000,
    // Without thinking on, the model works through the scheduling rules in its visible answer.
    thinking: { type: "adaptive" },
    // Cache the static system prompt (Task 6): it's identical across every lead, so a
    // cache read replaces re-billing it at full input rate on each call.
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content: `Analyze this new lead and prepare a first response:\n\n${buildLeadPrompt(lead)}`,
      },
    ],
    // The API constrains the response to this schema, so the answer can't arrive wrapped in
    // prose or code fences — which is what used to break the parse.
    output_config: { format: { type: "json_schema", schema: LEAD_ANALYSIS_JSON_SCHEMA } },
  });

  const analysis = leadAnalysisSchema.parse(parseModelJson(response, "lead analysis"));

  return {
    analysis: {
      ...analysis,
      proposedSlots: sanitizeProposedSlots(analysis.proposedSlots, lead.scheduling),
    },
    usage: extractAiUsage(response, model),
  };
}
