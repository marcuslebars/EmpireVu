// ─────────────────────────────────────────────────────────────────────────────
// SANCTIONED EXCEPTION (service role): Settings → AI front desk → Customer import, and the import
// pages. Routes check org membership (owner/admin for writes) and that the company belongs to the
// org on the caller's RLS client FIRST — or, for /import/:token, that the token is the company's
// live link — and only then read/write that one company with the service role. Settings writes
// merge ONLY ai_settings.import (updateAiSettings, optimistic).
// ─────────────────────────────────────────────────────────────────────────────
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { updateAiSettings } from "@/server/services/front-desk/ai-settings-write";
import { loadHeldBalances, pendingChase } from "./approvals";
import { listBatches, type BatchSummary } from "./batches";
import { loadImportCompany, mergeImportSettings, type ImportCompany, type ImportPatch, type ImportSettings } from "./settings";

export interface ImportOverview {
  companyId: string;
  companyName: string;
  settings: ImportSettings;
  /** What the default is for this org (on for CrankLeads, off for house orgs). */
  defaultEnabled: boolean;
  ownerPhoneOnFile: boolean;
  batches: BatchSummary[];
  held: { count: number; totalCents: number; pendingCode: number | null };
}

export async function overviewFor(admin: AdminClient, company: ImportCompany): Promise<ImportOverview> {
  const scope = { organizationId: company.organizationId, companyId: company.companyId };
  const [batches, held, pending] = await Promise.all([
    listBatches(admin, scope).catch(() => []),
    loadHeldBalances(admin, scope).catch(() => ({ count: 0, totalCents: 0, oldestIssue: null, batchIds: [] })),
    pendingChase(admin, company.companyId).catch(() => null),
  ]);
  return {
    companyId: company.companyId,
    companyName: company.name,
    settings: company.settings,
    defaultEnabled: company.doneForYou,
    ownerPhoneOnFile: Boolean(company.ownerPhone),
    batches,
    held: { count: held.count, totalCents: held.totalCents, pendingCode: pending?.short_code ?? null },
  };
}

export async function getImportOverview(admin: AdminClient, organizationId: string, companyId: string): Promise<ImportOverview | null> {
  const company = await loadImportCompany(admin, organizationId, companyId);
  return company ? overviewFor(admin, company) : null;
}

/** Merge ONLY ai_settings.import; returns the fresh overview (null → company not found). */
export async function updateImportSettings(admin: AdminClient, organizationId: string, companyId: string, patch: ImportPatch): Promise<ImportOverview | null> {
  const written = await updateAiSettings(admin, { organizationId, companyId }, (current) => mergeImportSettings(current, patch));
  if (!written) return null;
  return getImportOverview(admin, organizationId, companyId);
}
