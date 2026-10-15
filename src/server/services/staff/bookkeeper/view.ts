// ─────────────────────────────────────────────────────────────────────────────
// SANCTIONED EXCEPTION (service role): Settings → AI front desk → Bookkeeper. The route checks
// org membership (owner/admin for writes) and that the company belongs to the org on the
// caller's RLS client FIRST; only then does this read/write that one company's row with the
// service role. Writes merge ONLY ai_settings.collections (updateAiSettings, optimistic).
// ─────────────────────────────────────────────────────────────────────────────
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { updateAiSettings } from "@/server/services/front-desk/ai-settings-write";
import { agingSummary, loadOpenInvoicesWithNames } from "./ar";
import { loadCompanyCtx, todayIn } from "./context";
import type { Db } from "./db-types";
import { mergeCollectionsSettings, type CollectionsPatch, type CollectionsSettings } from "./settings";

export interface CollectionsView {
  companyId: string;
  companyName: string;
  settings: CollectionsSettings;
  /** What the default is for this org (on for CrankLeads, off for house orgs). */
  defaultEnabled: boolean;
  emailReminders: { enabled: boolean; days: number[] };
  ownerPhoneOnFile: boolean;
  stats: { overdueCount: number; overdueCents: number; outstandingCents: number; texts30d: number; activePlans: number; openPromises: number };
}

export async function getCollectionsView(admin: AdminClient, organizationId: string, companyId: string, nowMs: number = Date.now()): Promise<CollectionsView | null> {
  const ctx = await loadCompanyCtx(admin, organizationId, companyId);
  if (!ctx) return null;
  const db = admin as Db;
  const scope = { organizationId, companyId };
  const since = new Date(nowMs - 30 * 86_400_000).toISOString();
  const [open, texts, plans, promises] = await Promise.all([
    loadOpenInvoicesWithNames(admin, scope).catch(() => []),
    db.from("invoice_reminder_texts").select("id").eq("organization_id", organizationId).eq("company_id", companyId).eq("status", "sent").gte("sent_at", since).limit(5000),
    db.from("payment_plans").select("id").eq("organization_id", organizationId).eq("company_id", companyId).eq("status", "active").limit(1000),
    db.from("invoice_collections").select("id").eq("organization_id", organizationId).eq("company_id", companyId).eq("promise_status", "open").limit(1000),
  ]);
  const aging = agingSummary(open, todayIn(ctx, nowMs));
  return {
    companyId,
    companyName: ctx.name,
    settings: ctx.settings,
    defaultEnabled: ctx.doneForYou,
    emailReminders: ctx.emailReminders,
    ownerPhoneOnFile: Boolean(ctx.ownerPhone),
    stats: {
      overdueCount: aging.overdueCount,
      overdueCents: aging.overdueCents,
      outstandingCents: aging.outstandingCents,
      texts30d: ((texts.data ?? []) as unknown[]).length,
      activePlans: ((plans.data ?? []) as unknown[]).length,
      openPromises: ((promises.data ?? []) as unknown[]).length,
    },
  };
}

/** Merge ONLY ai_settings.collections; returns the fresh view (null → company not found). */
export async function updateCollections(admin: AdminClient, organizationId: string, companyId: string, patch: CollectionsPatch): Promise<CollectionsView | null> {
  const written = await updateAiSettings(admin, { organizationId, companyId }, (current) => mergeCollectionsSettings(current, patch));
  if (!written) return null;
  return getCollectionsView(admin, organizationId, companyId);
}
