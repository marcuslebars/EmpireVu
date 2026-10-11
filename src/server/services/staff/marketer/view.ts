/**
 * Settings → AI front desk → Marketer: what the section shows, and the settings write
 * (companies.ai_settings.marketing only, optimistic via updateAiSettings).
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { updateAiSettings } from "@/server/services/front-desk/ai-settings-write";
import { isPlacesConfigured } from "@/server/services/dfy/places";
import { ACTIVE_STATUSES, campaignResults, cancelActiveCampaign, lastCampaign, type CampaignResults } from "@/server/services/staff/marketer/campaigns";
import type { Db } from "@/server/services/staff/marketer/db-types";
import { loadMarketingCompany, mergeMarketingSettings, type MarketingSettings, type MarketingSettingsPatch } from "@/server/services/staff/marketer/settings";

export interface MarketingView {
  companyId: string;
  crankleads: boolean;
  settings: MarketingSettings;
  lastCampaign: (CampaignResults & { active: boolean; holdReason: string | null }) | null;
  google: {
    connected: boolean;
    rating: number | null;
    reviewCount: number | null;
    repliesWaiting: number;
    postsWaiting: number;
  };
}

export async function getMarketingView(admin: AdminClient, scope: { organizationId: string; companyId: string }): Promise<MarketingView | null> {
  const company = await loadMarketingCompany(admin, scope);
  if (!company) return null;
  const db = admin as Db;
  const campaign = await lastCampaign(admin, scope);
  const [{ data: replies }, { data: posts }] = await Promise.all([
    db.from("google_reviews").select("id").eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).eq("reply_status", "awaiting_owner").limit(100),
    db.from("google_post_drafts").select("id").eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).eq("status", "awaiting_owner").limit(100),
  ]);
  return {
    companyId: company.companyId,
    crankleads: company.crankleads,
    settings: company.settings,
    lastCampaign: campaign
      ? { ...(await campaignResults(admin, campaign)), active: ACTIVE_STATUSES.includes(campaign.status), holdReason: campaign.held_since ? campaign.hold_reason ?? "on hold" : null }
      : null,
    google: {
      connected: Boolean(company.googlePlaceId) && isPlacesConfigured(),
      rating: company.googleRating,
      reviewCount: company.googleReviewCount,
      repliesWaiting: ((replies ?? []) as unknown[]).length,
      postsWaiting: ((posts ?? []) as unknown[]).length,
    },
  };
}

export async function updateMarketingSettings(
  admin: AdminClient,
  scope: { organizationId: string; companyId: string },
  patch: MarketingSettingsPatch,
): Promise<MarketingView | null> {
  const written = await updateAiSettings(admin, scope, (current) => mergeMarketingSettings(current, patch));
  if (!written) return null;
  return getMarketingView(admin, scope);
}

/** Settings -> "Stop this campaign": cancel the active campaign, skip what's queued. */
export async function stopMarketingCampaign(admin: AdminClient, scope: { organizationId: string; companyId: string }): Promise<MarketingView | null> {
  await cancelActiveCampaign(admin, scope, "owner_stopped", Date.now());
  return getMarketingView(admin, scope);
}
