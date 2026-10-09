// ─────────────────────────────────────────────────────────────────────────────
// SANCTIONED EXCEPTION #4b (continued): AI-answering housekeeping jobs, run by the
// inbound-webhook worker with the service-role client. Each job was queued by OUR code with
// ids we resolved ourselves (the catcher number's tenant / the CallSid's missed_calls row);
// every write is filtered by those ids. docs/front-desk-ai.md → "## Phone answering".
// ─────────────────────────────────────────────────────────────────────────────
import type { Tables } from "@/server/db/database.types";
import type { TenantServiceContext } from "@/server/services/shared";
import { handleMissedCall } from "@/server/services/twilio/missed-call";
import { releaseAiPending, storedCallParams } from "@/server/services/voice/ai-answer";
import { monthName } from "@/server/services/voice/minutes";
import { deliverMessage, resolveOwnerContacts, type DeliverMessageInput, type DeliverMessageResult } from "@/server/services/workflow-engine/messaging";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

export interface VoiceAiJobDeps {
  admin?: AdminClient;
  send?: (input: DeliverMessageInput) => Promise<DeliverMessageResult>;
  now?: () => Date;
  runMissedCall?: (payload: unknown) => Promise<unknown>;
}

function field(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== "object") return null;
  const v = (payload as Record<string, unknown>)[key];
  return typeof v === "string" && v ? v : null;
}

/** The owner notice. Pure. */
export function minutesExhaustedText(companyName: string, month: string): string {
  const name = monthName(month);
  return (
    `Heads up: ${companyName}'s AI call answering minutes for ${name} are used up, so missed calls go to voicemail ` +
    `(callers still get the instant text-back) until the 1st. Want more minutes? Reply here or change it in Settings.`
  );
}

/**
 * provider 'twilio_voice_ai':
 *   kind=watchdog        an AI hand-off whose post-call webhook never came → release it to the
 *                        normal missed-call path (lead + generic text-back), once.
 *   kind=minutes_notice  "your AI call minutes for October are used up" → owner, once per
 *                        company per month (call_answering_notices claim).
 */
export async function handleVoiceAiJob(payload: unknown, deps: VoiceAiJobDeps = {}): Promise<void> {
  const admin = deps.admin ?? createSupabaseAdminClient();
  const now = deps.now?.() ?? new Date();
  const kind = field(payload, "kind");

  if (kind === "watchdog") {
    const callSid = field(payload, "CallSid");
    if (!callSid) return;
    if (!(await releaseAiPending(admin, callSid, now))) return; // handled (or released) already
    const params = (await storedCallParams(admin, callSid)) ?? { CallSid: callSid };
    console.warn(`[voice-ai] no post-call for AI hand-off ${callSid} — released to the normal text-back path.`);
    await (deps.runMissedCall ?? ((p: unknown) => handleMissedCall(p)))(params);
    return;
  }

  if (kind === "minutes_notice") {
    const organizationId = field(payload, "organizationId");
    const companyId = field(payload, "companyId");
    const month = field(payload, "month");
    if (!organizationId || !companyId || !month) return;
    const { data: claimed, error } = await admin
      .from("call_answering_notices")
      .upsert(
        { organization_id: organizationId, company_id: companyId, month, kind: "minutes_exhausted" },
        { onConflict: "company_id,month,kind", ignoreDuplicates: true },
      )
      .select("id");
    if (error) throw error;
    if (((claimed ?? []) as unknown[]).length === 0) return;
    const noticeId = ((claimed ?? []) as Array<{ id: string }>)[0].id;

    const { data: companyData, error: companyError } = await admin
      .from("companies")
      .select("name, owner_email, owner_phone_e164")
      .eq("organization_id", organizationId)
      .eq("id", companyId)
      .maybeSingle();
    if (companyError) throw companyError;
    const company = companyData as Pick<Tables<"companies">, "name" | "owner_email" | "owner_phone_e164"> | null;
    if (!company) return;
    const context: TenantServiceContext = { organizationId, actorProfileId: null, supabase: admin };
    const owner = await resolveOwnerContacts(context, company);
    const body = minutesExhaustedText(company.name, month);
    const send = deps.send ?? deliverMessage;
    let sent = false;
    if (owner.phone) {
      sent = (await send({ context, channel: "sms", to: owner.phone, body, companyId, contactId: null, consentContact: null })).status === "sent";
    }
    if (!sent && owner.email) {
      sent =
        (
          await send({
            context,
            channel: "email",
            to: owner.email,
            subject: `AI call answering minutes used up for ${monthName(month)}`,
            body,
            companyId,
            contactId: null,
            consentContact: null,
          })
        ).status === "sent";
    }
    if (sent) {
      await admin.from("call_answering_notices").update({ sent_at: now.toISOString() }).eq("id", noticeId);
    }
    return;
  }

  throw new Error(`Unknown voice AI job kind: ${kind ?? "none"}`);
}
