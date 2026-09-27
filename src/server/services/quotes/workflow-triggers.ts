import type { TenantServiceContext } from "@/server/services/shared";
import type { createSupabaseAdminClient } from "@/server/supabase/admin";
import { emitActivityEventAndDispatch } from "@/server/services/workflow-engine/dispatch";

/**
 * Emit a quote.* workflow trigger (Task 9). Anchored to the quote's contact when known,
 * else the company (both are valid trace entities; a quote is not). Best-effort — a
 * trigger emission must never fail the quote transition that produced it.
 */
type Admin = ReturnType<typeof createSupabaseAdminClient>;

export async function emitQuoteTrigger(
  admin: Admin,
  args: {
    organizationId: string;
    companyId: string | null;
    contactId: string | null;
    quoteId: string;
    eventType: "quote.sent" | "quote.viewed" | "quote.approved" | "quote.deposit_paid";
  },
): Promise<void> {
  const anchorId = args.contactId ?? args.companyId;
  if (!anchorId) return;
  const context: TenantServiceContext = {
    organizationId: args.organizationId,
    actorProfileId: null,
    supabase: admin,
  };
  try {
    await emitActivityEventAndDispatch(context, {
      companyId: args.companyId,
      entityId: anchorId,
      entityType: args.contactId ? "contact" : "company",
      eventType: args.eventType,
      metadata: { quoteId: args.quoteId },
    });
  } catch (err) {
    console.error(`[quotes] failed to emit ${args.eventType}:`, err instanceof Error ? err.message : err);
  }
}
