import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

/**
 * Server-side Claude integration. All AI runs here (never in the browser); the
 * API key is read from the ANTHROPIC_API_KEY environment variable on the server.
 */

export function isAIConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export const leadAnalysisSchema = z.object({
  summary: z.string(),
  intent: z.string(),
  urgency: z.enum(["low", "medium", "high"]),
  fitScore: z.number(),
  suggestedStage: z.enum(["lead", "qualified", "active", "closed"]),
  suggestedActions: z.array(z.string()),
  draftedEmail: z.object({ subject: z.string(), body: z.string() }),
  draftedSms: z.string(),
});

export type LeadAnalysis = z.infer<typeof leadAnalysisSchema>;

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

  return lines.join("\n");
}

const SYSTEM_PROMPT = `You are the lead-intelligence assistant for the A1 Group, a family of marine-services businesses (A1 Marine Care — boat detailing & maintenance; A1 Marine Storage; A1 Coatings). A new lead has come in through a website form. Analyze the lead in depth and prepare a first response the business owner can review before sending.

Ground everything only in the information provided — do not invent details about the lead. If information is missing, work with what you have; surface the gaps through your suggested actions rather than guessing.

For the drafted email and SMS, write in a warm, professional, human voice as if from the A1 team. The email should acknowledge their enquiry, address the obvious next question, and propose one clear next step (a call, a quote, or a booking). The SMS is a short friendly version, under ~300 characters. Do NOT fabricate prices, availability, or specific promises — keep next steps open ("we'll confirm…", "happy to set up a time…").

Respond with ONLY a JSON object — no markdown, no code fences, no prose before or after — with exactly these fields:
{
  "summary": string,                // 1-2 sentences: who they are and what they want
  "intent": string,                 // what they are looking for
  "urgency": "low" | "medium" | "high",
  "fitScore": number,               // 0-100, how well they match an ideal high-value customer given the signals available
  "suggestedStage": "lead" | "qualified" | "active" | "closed",
  "suggestedActions": string[],     // concrete next steps for the team
  "draftedEmail": { "subject": string, "body": string },
  "draftedSms": string
}`;

function stripJsonFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

export async function analyzeLead(lead: LeadForAnalysis): Promise<LeadAnalysis> {
  // The zero-arg client reads ANTHROPIC_API_KEY from the environment.
  const client = new Anthropic();

  const response = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Analyze this new lead and prepare a first response:\n\n${buildLeadPrompt(lead)}`,
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

  return leadAnalysisSchema.parse(parsed);
}
