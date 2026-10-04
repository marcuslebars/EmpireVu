/**
 * SANCTIONED EXCEPTION (service role, delivery only): send a customer their portal link.
 * The caller (portal/links.ts) has already resolved the contact and company through its
 * own RLS-scoped session; this module only sends to that contact and writes the
 * message log (which members can't insert into directly), pinned to the caller's org.
 * Listed in docs/EMPIREVU_RUNBOOK.md (service-role surfaces).
 */
import type { Tables } from "@/server/db/database.types";
import { isEmailSendConfigured } from "@/server/outbound/email";
import type { TenantServiceContext } from "@/server/services/shared";
import { deliverMessage } from "@/server/services/workflow-engine/messaging";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

type Contact = Pick<Tables<"contacts">, "id" | "first_name" | "phone" | "email" | "sms_opt_out_at" | "email_opt_out_at">;

export function portalMessage(input: { firstName: string | null; brandName: string; url: string }): { sms: string; subject: string; email: string } {
  const hi = input.firstName ? `Hi ${input.firstName}, ` : "Hi, ";
  return {
    sms: `${hi}${input.brandName} here. Your account — upcoming visits, quotes, invoices and payments — is all in one place: ${input.url}`,
    subject: `Your ${input.brandName} account`,
    email:
      `${hi}\n\nHere's your private link to your ${input.brandName} account. You can see your upcoming visits, ` +
      `quotes and invoices, pay any balance, and ask us for more work:\n\n${input.url}\n\n` +
      `Keep this link to yourself — anyone with it can see your account.\n\n— ${input.brandName}`,
  };
}

export async function sendPortalLinkMessage(
  ctx: TenantServiceContext,
  input: { channel: "sms" | "email"; companyId: string; contact: Contact; brandName: string; replyTo: string | null; url: string },
): Promise<{ delivered: boolean; reason: string | null; to: string | null }> {
  const { contact } = input;
  const to = input.channel === "sms" ? contact.phone?.trim() || null : contact.email?.trim() || null;
  if (!to) return { delivered: false, reason: input.channel === "sms" ? "No mobile number on file." : "No email address on file.", to: null };
  // Transactional (their own account), but an opt-out always wins.
  if (input.channel === "sms" && contact.sms_opt_out_at) return { delivered: false, reason: "This customer has opted out of texts.", to };
  if (input.channel === "email" && contact.email_opt_out_at) return { delivered: false, reason: "This customer has opted out of email.", to };
  if (input.channel === "email" && !isEmailSendConfigured()) return { delivered: false, reason: "Email sending isn't set up.", to };

  const msg = portalMessage({ firstName: contact.first_name?.trim() || null, brandName: input.brandName, url: input.url });
  const db = createSupabaseAdminClient();
  const result = await deliverMessage({
    context: { organizationId: ctx.organizationId, actorProfileId: ctx.actorProfileId, supabase: db as never },
    channel: input.channel,
    to,
    body: input.channel === "sms" ? msg.sms : msg.email,
    subject: input.channel === "email" ? msg.subject : null,
    fromName: input.brandName,
    replyTo: input.replyTo,
    companyId: input.companyId,
    contactId: contact.id,
    consentContact: null,
  });
  return { delivered: result.status === "sent", reason: result.status === "sent" ? null : (result.reason ?? "Not sent."), to };
}
