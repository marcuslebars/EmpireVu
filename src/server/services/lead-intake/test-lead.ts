import { handleLeadIntake } from "@/server/services/lead-intake/intake";
import type { LeadEnvelope } from "@/server/services/lead-intake/envelope";
import type { TenantServiceContext } from "@/server/services/shared";

/**
 * "Send a test lead" for the onboarding Website-leads step (Task 13). Builds a canonical
 * lead envelope and runs it through the real intake pipeline with the onboarding tenant
 * pinned, so the user watches a lead land (raw_lead → contact → activity/inbox) exactly as
 * their website form will produce. The authed org-member context is the tenancy proof, so
 * this uses the pinned target rather than round-tripping an HMAC over HTTP.
 */

export function buildTestLeadEnvelope(now: Date = new Date()): LeadEnvelope {
  return {
    schemaVersion: 1,
    source: "onboarding_test",
    sourceSite: "onboarding",
    formType: "contact",
    receivedAt: now.toISOString(),
    contact: {
      name: "Test Lead",
      email: "test.lead+onboarding@empirevu.com",
      phone: "+15555550123",
    },
    message: "This is a test lead from the onboarding wizard — it confirms your website form is wired up.",
  };
}

export async function sendTestLead(
  context: TenantServiceContext,
  companyId: string,
): Promise<{ leadId: string }> {
  const envelope = buildTestLeadEnvelope();
  const rawBody = JSON.stringify(envelope);
  const result = await handleLeadIntake(rawBody, envelope, {
    target: { organizationId: context.organizationId, companyId },
  });
  return { leadId: result.leadId };
}
