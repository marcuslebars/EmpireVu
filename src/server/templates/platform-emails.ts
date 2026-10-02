/**
 * Owner-facing PLATFORM email copy — mail that comes from the product itself (CrankLeads
 * by default), not from a client company. PURE render functions so subject/body/footer
 * can be golden-tested. The brand is passed in; callers use getPlatformBrand().
 *
 * Customer-facing mail (quotes, booking confirmations) is branded from the company row
 * and lives in services/quotes/emails.ts — it must never use these.
 */
import type { PlatformBrand } from "@/server/platform-brand";

/** Plain-text sign-off appended to platform email: product name + support contact. */
export function platformEmailFooter(brand: PlatformBrand): string {
  return `— ${brand.name}\nQuestions? ${brand.supportEmail}`;
}

export interface InvitationEmail {
  subject: string;
  body: string;
  fromName: string;
}

export function renderInvitationEmail(
  input: { role: string; inviteUrl: string },
  brand: PlatformBrand,
): InvitationEmail {
  return {
    subject: `You've been invited to join a team on ${brand.name}`,
    fromName: brand.emailFromName,
    body:
      `You've been invited to join a team on ${brand.name} as ${input.role}.\n\n` +
      `Accept your invitation:\n${input.inviteUrl}\n\n` +
      `This link expires in 7 days.\n\n` +
      platformEmailFooter(brand),
  };
}

/** Default subject for a workflow `notify_owner` email when the workflow sets none. */
export function defaultOwnerAlertSubject(brand: PlatformBrand): string {
  return `${brand.name} alert`;
}
