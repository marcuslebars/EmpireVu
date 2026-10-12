/**
 * Texts and emails Compliance sends to people who aren't the owner — a sub (their upload link) or
 * a customer / GC (the certificate they asked for). Both are transactional: the sub's own
 * paperwork for a job, or a document the customer asked for. So the 6-month implied-consent window
 * doesn't apply, but a STOP always wins: any contact of the company with that number who opted out
 * blocks the text. Sent from the company's own number (deliverMessage, smsFrom "company"),
 * message_log.sent_by = 'compliance'.
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { normalizePhoneLast10 } from "@/server/services/lead-intake/matching";
import { deliverMessage, type DeliverMessageResult } from "@/server/services/workflow-engine/messaging";
import type { Db } from "./db-types";

export const COMPLIANCE_SENDER = "compliance";

/** Has anyone at this number told the company to stop texting? */
export async function phoneOptedOut(admin: AdminClient, scope: { organizationId: string; companyId: string }, phone: string): Promise<boolean> {
  const last10 = normalizePhoneLast10(phone);
  if (!last10) return false;
  const { data, error } = await (admin as Db)
    .from("contacts")
    .select("id, phone, sms_opt_out_at")
    .eq("organization_id", scope.organizationId)
    .eq("company_id", scope.companyId)
    .ilike("phone", `%${last10}`)
    .limit(20);
  if (error) throw error;
  return ((data ?? []) as Array<{ phone: string | null; sms_opt_out_at: string | null }>).some((c) => normalizePhoneLast10(c.phone) === last10 && Boolean(c.sms_opt_out_at));
}

export async function sendText(
  admin: AdminClient,
  scope: { organizationId: string; companyId: string },
  input: { to: string; body: string; contactId?: string | null },
): Promise<DeliverMessageResult> {
  if (await phoneOptedOut(admin, scope, input.to)) return { status: "blocked", reason: "opted_out", body: input.body };
  return deliverMessage({
    context: { organizationId: scope.organizationId, actorProfileId: null, supabase: admin as never },
    channel: "sms",
    to: input.to,
    body: input.body,
    companyId: scope.companyId,
    contactId: input.contactId ?? null,
    consentContact: null,
    smsFrom: "company",
    sentBy: COMPLIANCE_SENDER,
  });
}

export async function sendEmailTo(
  admin: AdminClient,
  scope: { organizationId: string; companyId: string },
  input: { to: string; subject: string; body: string; fromName: string; replyTo?: string | null },
): Promise<DeliverMessageResult> {
  return deliverMessage({
    context: { organizationId: scope.organizationId, actorProfileId: null, supabase: admin as never },
    channel: "email",
    to: input.to,
    subject: input.subject,
    body: input.body,
    fromName: input.fromName,
    replyTo: input.replyTo ?? null,
    companyId: scope.companyId,
    contactId: null,
    consentContact: null,
    sentBy: COMPLIANCE_SENDER,
  });
}
