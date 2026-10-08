// ─────────────────────────────────────────────────────────────────────────────
// SANCTIONED EXCEPTION (service role): who the done-for-you automation may act on.
// Read-only helpers; every query is filtered by the caller's organization_id + company_id.
// docs/done-for-you.md → "Who done-for-you applies to".
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Two rules every done-for-you sweep and owner message follows:
 *
 *  1. NEW FLOW ONLY. The automatic parts — switch-on, number buying, site generation and
 *     publishing, the page text — apply only to purchases that went through the done-for-you
 *     flow, i.e. the company has a `setup_intakes` row (created at provisioning). CrankLeads
 *     companies bought before this feature ("legacy") are never auto-published or texted; an
 *     operator may build them a DRAFT page from the concierge ("Build / rebuild website").
 *  2. OWNER TEXTS RESPECT THE STOP FLAGS. `crankleads_purchases.setup_followups_exempt_at` and
 *     `setup_reminders_stopped_at` silence every done-for-you owner text/email: the quick-setup
 *     link (and its retries / operator resend), the forwarding text, the page text, the
 *     forwarding-test result notice and "You're live".
 */
import type { AdminClient } from "@/server/services/crankleads/purchases";

export type OwnerTextBlock = "followups_exempt" | "reminders_stopped";

export interface PurchaseStopFlags {
  setup_followups_exempt_at?: string | null;
  setup_reminders_stopped_at?: string | null;
}

/** PURE: why owner texts are off for this purchase (null = allowed). */
export function ownerTextBlockFor(purchase: PurchaseStopFlags | null | undefined): OwnerTextBlock | null {
  if (!purchase) return null;
  if (purchase.setup_followups_exempt_at) return "followups_exempt";
  if (purchase.setup_reminders_stopped_at) return "reminders_stopped";
  return null;
}

/** The latest CrankLeads purchase's stop flags for a company → why texts are off (null = allowed). */
export async function loadOwnerTextBlock(admin: AdminClient, organizationId: string, companyId: string): Promise<OwnerTextBlock | null> {
  const { data, error } = await admin
    .from("crankleads_purchases")
    .select("setup_followups_exempt_at, setup_reminders_stopped_at")
    .eq("organization_id", organizationId)
    .eq("company_id", companyId)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`purchase flags lookup failed: ${error.message}`);
  return ownerTextBlockFor(((data ?? []) as PurchaseStopFlags[])[0] ?? null);
}

/** Does this company belong to the done-for-you flow (it has a quick-setup intake row)? */
export async function isNewFlowCompany(admin: AdminClient, organizationId: string, companyId: string): Promise<boolean> {
  const { data, error } = await admin
    .from("setup_intakes")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("company_id", companyId)
    .limit(1);
  if (error) throw new Error(`intake lookup failed: ${error.message}`);
  return (data ?? []).length > 0;
}

/** Of these company ids, the ones in the done-for-you flow (bounded batches, no giant IN). */
export async function newFlowCompanyIds(admin: AdminClient, companyIds: string[], batchSize = 100): Promise<Set<string>> {
  const out = new Set<string>();
  const unique = [...new Set(companyIds)];
  for (let i = 0; i < unique.length; i += batchSize) {
    const { data, error } = await admin.from("setup_intakes").select("company_id").in("company_id", unique.slice(i, i + batchSize));
    if (error) throw new Error(`intake lookup failed: ${error.message}`);
    for (const row of (data ?? []) as Array<{ company_id: string }>) out.add(row.company_id);
  }
  return out;
}
