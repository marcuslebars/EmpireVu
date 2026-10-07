import { z } from "zod";

import type { Inserts } from "@/server/db/database.types";
import { toJson } from "@/server/db/json";
import type { SendEmailInput, SendEmailResult } from "@/server/outbound/email";
import { describeAccount, type HelpAccountContext } from "@/server/services/help/account-context";
import { MAX_TURN_CHARS, chatTurnSchema, type ChatTurn } from "@/server/services/help/assistant";
import type { TenantServiceContext } from "@/server/services/shared";
import { appBaseUrlFor, platformBrand } from "@/server/services/platform-brand";

/**
 * "Contact support" (docs/help-assistant.md): persist a support_requests row on the
 * caller's own RLS client (members may insert for their org, as themselves), then email the
 * operator (OWNER_EMAIL). The row is written FIRST — it is the durable record; a mail failure
 * is logged and recorded on the deflection event, never lost.
 */

export const MAX_TRANSCRIPT_TURNS = 10;
export const SUPPORT_CONFIRMATION = "We've got it — we'll reply by email.";

export const escalateBodySchema = z.object({
  question: z.string().trim().min(1).max(2000),
  transcript: z.array(chatTurnSchema).max(40).default([]),
  sessionId: z.string().uuid().optional(),
  reason: z.enum(["not_sure", "user_requested", "other"]).default("user_requested"),
});
export type EscalateBody = z.infer<typeof escalateBodySchema>;

export type HelpEventType = "answered" | "not_sure" | "handoff_requested" | "escalated" | "error";

export function trimTranscript(transcript: readonly ChatTurn[]): ChatTurn[] {
  return transcript
    .filter((turn) => turn.text.trim().length > 0)
    .slice(-MAX_TRANSCRIPT_TURNS)
    .map((turn) => ({ role: turn.role, text: turn.text.slice(0, MAX_TURN_CHARS) }));
}

export function operatorEmailAddress(): string | null {
  return process.env.OWNER_EMAIL?.trim() || null;
}

/** One line, no control characters — subject headers must not carry user-typed newlines. */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export interface SupportEmailInput {
  requestId: string;
  organizationId: string;
  requesterEmail: string | null;
  question: string;
  transcript: readonly ChatTurn[];
  account: HelpAccountContext;
  reason: EscalateBody["reason"];
  appBaseUrl: string | null;
}

/** The operator email. Plain text — user-typed content is never rendered as HTML. */
export function buildSupportEmail(input: SupportEmailInput): { subject: string; body: string } {
  const who = input.account.organizationName ?? "Unknown organization";
  const brand = platformBrand(input.account.platformBrand);
  const subject = `[${brand.name} Help] ${oneLine(who, 60)}: ${oneLine(input.question, 70)}`;

  const reasonText =
    input.reason === "not_sure"
      ? "The Help assistant couldn't answer."
      : input.reason === "user_requested"
        ? "They asked for a person."
        : "Other.";

  const lines = [
    "A customer asked for help from the in-app Help panel.",
    "",
    `Organization: ${who}`,
    `Company: ${input.account.companyName ?? "—"}`,
    `From: ${input.requesterEmail ?? "(no email on the account)"}`,
    ...describeAccount(input.account),
    `Why: ${reasonText}`,
    `Request id: ${input.requestId}`,
    `Organization id: ${input.organizationId}`,
    "",
    "Question:",
    input.question,
    "",
    "Conversation (most recent last):",
    ...(input.transcript.length
      ? input.transcript.map((turn) => `${turn.role === "user" ? "Customer" : "Assistant"}: ${turn.text}`)
      : ["(none — they went straight to Contact support)"]),
    "",
    input.requesterEmail
      ? "Reply to this email to answer them directly (Reply-To is set to their address)."
      : "No email on file — reach them through the organization's owner.",
  ];
  if (input.appBaseUrl) lines.push("", `App: ${input.appBaseUrl}`);

  return { subject, body: lines.join("\n") };
}

export interface EscalateDeps {
  sendEmail: (input: SendEmailInput) => Promise<SendEmailResult>;
  isEmailConfigured: () => boolean;
}

export type SupportEmailStatus = "sent" | "failed" | "not_configured";

export interface EscalateResult {
  id: string;
  emailStatus: SupportEmailStatus;
}

export async function createSupportRequest(
  context: TenantServiceContext,
  input: {
    body: EscalateBody;
    requesterEmail: string | null;
    account: HelpAccountContext;
  },
  deps: EscalateDeps,
): Promise<EscalateResult> {
  const transcript = trimTranscript(input.body.transcript);

  const row: Inserts<"support_requests"> = {
    organization_id: context.organizationId,
    profile_id: context.actorProfileId,
    requester_email: input.requesterEmail,
    question: input.body.question,
    transcript: toJson(transcript),
    context: toJson(input.account),
    reason: input.body.reason,
    session_id: input.body.sessionId ?? null,
  };

  // Durable first: if this fails the user is told it didn't go through (the route 500s).
  const { data, error } = await context.supabase.from("support_requests").insert(row).select("id").single();
  if (error) throw error;
  const id = data.id;

  let emailStatus: SupportEmailStatus = "not_configured";
  const to = operatorEmailAddress();
  if (!to || !deps.isEmailConfigured()) {
    console.error(
      `[help] support request ${id} saved but the operator email is not configured (OWNER_EMAIL / RESEND_API_KEY / OUTBOUND_FROM_EMAIL).`,
    );
  } else {
    const email = buildSupportEmail({
      requestId: id,
      organizationId: context.organizationId,
      requesterEmail: input.requesterEmail,
      question: input.body.question,
      transcript,
      account: input.account,
      reason: input.body.reason,
      appBaseUrl:
        platformBrand(input.account.platformBrand).key === "empirevu"
          ? process.env.APP_BASE_URL?.trim() || null
          : appBaseUrlFor(platformBrand(input.account.platformBrand)),
    });
    try {
      await deps.sendEmail({
        to,
        subject: email.subject,
        body: email.body,
        fromName: `${platformBrand(input.account.platformBrand).name} Help`,
        ...(input.requesterEmail ? { replyTo: input.requesterEmail } : {}),
      });
      emailStatus = "sent";
    } catch (err) {
      emailStatus = "failed";
      console.error(`[help] support request ${id} saved but the operator email failed:`, err instanceof Error ? err.message : err);
    }
  }

  await recordHelpChatEvent(context, {
    eventType: "escalated",
    sessionId: input.body.sessionId ?? null,
    supportRequestId: id,
    metadata: { email: emailStatus, reason: input.body.reason, turns: transcript.length },
  });

  return { id, emailStatus };
}

/** Deflection log. Best-effort: analytics must never fail an answer or an escalation. */
export async function recordHelpChatEvent(
  context: TenantServiceContext,
  input: {
    eventType: HelpEventType;
    sessionId: string | null;
    supportRequestId?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    const row: Inserts<"help_chat_events"> = {
      organization_id: context.organizationId,
      profile_id: context.actorProfileId,
      session_id: input.sessionId,
      event_type: input.eventType,
      support_request_id: input.supportRequestId ?? null,
      metadata: toJson(input.metadata ?? {}),
    };
    const { error } = await context.supabase.from("help_chat_events").insert(row);
    if (error) throw error;
  } catch (err) {
    console.warn(`[help] could not record ${input.eventType} event:`, err instanceof Error ? err.message : err);
  }
}
