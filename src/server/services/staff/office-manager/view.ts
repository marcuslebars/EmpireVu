// ─────────────────────────────────────────────────────────────────────────────
// SANCTIONED EXCEPTION (service role): Settings → AI front desk → Office manager. The route checks
// org membership (owner/admin for writes) and that the company belongs to the org on the
// caller's RLS client FIRST; only then does this read/write that one company's row with the
// service role. Writes merge ONLY ai_settings.office_manager (updateAiSettings, optimistic).
// ─────────────────────────────────────────────────────────────────────────────
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { updateAiSettings } from "@/server/services/front-desk/ai-settings-write";
import { ctxFor } from "@/server/services/owner-channel/common";
import { loadCollectionsSettings } from "@/server/services/staff/bookkeeper/settings";
import { resolveOwnerContacts } from "@/server/services/workflow-engine/messaging";
import type { Db, OwnerBriefingRow } from "./db-types";
import { loadBriefingCompany, mergeOfficeManagerSettings, type OfficeManagerPatch, type OfficeManagerSettings } from "./settings";

export interface OfficeManagerView {
  companyId: string;
  companyName: string;
  settings: OfficeManagerSettings & { emailCopy: boolean };
  /** What the default is for this org (on for CrankLeads, off for house orgs). */
  defaultEnabled: boolean;
  ownerPhoneOnFile: boolean;
  ownerEmailOnFile: boolean;
  /** The Bookkeeper's 8am money alert is on, so it rides in the briefing on briefing days. */
  foldsMoneyAlert: boolean;
  lastBriefing: { date: string; status: string; sentAt: string | null; body: string | null } | null;
}

export async function getOfficeManagerView(admin: AdminClient, organizationId: string, companyId: string): Promise<OfficeManagerView | null> {
  const company = await loadBriefingCompany(admin, organizationId, companyId);
  if (!company) return null;
  const [last, collections, owner] = await Promise.all([
    (admin as Db)
      .from("owner_briefings")
      .select("local_date, status, sent_at, body")
      .eq("organization_id", organizationId)
      .eq("company_id", companyId)
      .order("local_date", { ascending: false })
      .limit(1)
      .then((r: { data: unknown }) => ((r.data ?? []) as OwnerBriefingRow[])[0] ?? null, () => null),
    loadCollectionsSettings(admin, organizationId, companyId).catch(() => null),
    resolveOwnerContacts(ctxFor(admin, organizationId), { owner_email: company.ownerEmail, owner_phone_e164: company.ownerPhone }, { allowPlatformFallback: false }).catch(() => ({ email: null })),
  ]);
  return {
    companyId,
    companyName: company.name,
    settings: { ...company.settings, emailCopy: company.settings.channels.includes("email") },
    defaultEnabled: company.crankleads,
    ownerPhoneOnFile: Boolean(company.ownerPhone),
    ownerEmailOnFile: Boolean(owner.email),
    foldsMoneyAlert: Boolean(collections?.enabled && collections.dailyAlert),
    lastBriefing: last ? { date: last.local_date, status: last.status, sentAt: last.sent_at, body: last.body } : null,
  };
}

/** Merge ONLY ai_settings.office_manager; returns the fresh view (null → company not found). */
export async function updateOfficeManager(admin: AdminClient, organizationId: string, companyId: string, patch: OfficeManagerPatch): Promise<OfficeManagerView | null> {
  const written = await updateAiSettings(admin, { organizationId, companyId }, (current) => mergeOfficeManagerSettings(current, patch));
  if (!written) return null;
  return getOfficeManagerView(admin, organizationId, companyId);
}
