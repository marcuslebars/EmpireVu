// ─────────────────────────────────────────────────────────────────────────────
// SANCTIONED EXCEPTION (service role): Settings → AI front desk → Estimator. The route checks
// org membership (owner/admin for writes) and that the company belongs to the org on the
// caller's RLS client FIRST; only then does this read/write that one company with the service
// role (companies.ai_settings is not client-writable). Writes merge ONLY ai_settings.estimator.
// ─────────────────────────────────────────────────────────────────────────────
import { isDoneForYou } from "@/lib/product-line";
import { updateAiSettings } from "@/server/services/front-desk/ai-settings-write";
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { mergeEstimatorSettings, readEstimatorSettings, type EstimatorSettingsPatch } from "@/server/services/staff/estimator/settings";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

export interface EstimatorSettingsView {
  companyId: string;
  enabled: boolean;
  followUps: boolean;
  cadenceDays: number[];
  enabledIsDefault: boolean;
  /** What "default" means for this org (on for CrankLeads, off for house orgs). */
  defaultEnabled: boolean;
  stats: { waitingOnYou: number; sent30d: number; followingUp: number };
}

async function count(query: Db): Promise<number> {
  const { data, error } = await query.limit(1000);
  if (error) return 0;
  return ((data ?? []) as unknown[]).length;
}

export async function getEstimatorView(admin: AdminClient, organizationId: string, companyId: string, now: Date = new Date()): Promise<EstimatorSettingsView | null> {
  const db = admin as Db;
  const { data: company } = await db.from("companies").select("id, organization_id, ai_settings").eq("organization_id", organizationId).eq("id", companyId).maybeSingle();
  const row = company as { id: string; ai_settings: unknown } | null;
  if (!row) return null;
  const { data: org } = await db.from("organizations").select("platform_brand").eq("id", organizationId).maybeSingle();
  const crankleads = isDoneForYou((org as { platform_brand: string | null } | null)?.platform_brand);
  const settings = readEstimatorSettings(row.ai_settings, { crankleads });
  const since = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const scoped = (table: string) => db.from(table).select("id").eq("organization_id", organizationId).eq("company_id", companyId);
  const [waitingOnYou, sent30d, followingUp] = await Promise.all([
    count(scoped("estimate_requests").eq("status", "awaiting_owner")),
    count(scoped("estimate_requests").eq("status", "sent").gte("created_at", since)),
    count(scoped("quote_follow_ups").is("stopped_at", null)),
  ]);
  return {
    companyId,
    enabled: settings.enabled,
    followUps: settings.followUps,
    cadenceDays: settings.cadenceDays,
    enabledIsDefault: settings.enabledIsDefault,
    defaultEnabled: crankleads,
    stats: { waitingOnYou, sent30d, followingUp },
  };
}

/** Merge ONLY the estimator section; returns the fresh view (null → no such company). */
export async function updateEstimatorView(admin: AdminClient, organizationId: string, companyId: string, patch: EstimatorSettingsPatch): Promise<EstimatorSettingsView | null> {
  const written = await updateAiSettings(admin, { organizationId, companyId }, (current) => mergeEstimatorSettings(current, patch));
  if (!written) return null;
  return getEstimatorView(admin, organizationId, companyId);
}
