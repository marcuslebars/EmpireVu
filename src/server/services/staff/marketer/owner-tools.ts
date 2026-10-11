/**
 * The Marketer's owner-by-text tools: start_win_back (drafts a campaign → approval; nothing is
 * sent until the owner's Y) and marketing_results (last campaign + Google reviews).
 * Scoped to the company the owner channel resolved (state.scope) — never an id from a text.
 */
import type { ToolRunState } from "@/server/services/owner-channel/tools";
import { campaignResults, draftWinBackCampaign, exclusionText, lastCampaign } from "@/server/services/staff/marketer/campaigns";
import type { Db } from "@/server/services/staff/marketer/db-types";
import { defaultMarketerDeps, type MarketerDeps } from "@/server/services/staff/marketer/deps";
import { loadMarketingCompany } from "@/server/services/staff/marketer/settings";
import type { RoleOwnerTool } from "@/server/services/staff/types";

export function startWinBackTool(deps: MarketerDeps = defaultMarketerDeps): RoleOwnerTool {
  return {
    tool: {
      name: "start_win_back",
      description:
        "Draft a win-back text campaign to past customers (last job 9-24 months ago, consented, not texted by a campaign in 90 days, nothing open) NOW. It never sends: the owner gets the exact text and audience count with a code and must reply Y <code>.",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
    },
    async run(state: ToolRunState) {
      const company = await loadMarketingCompany(state.admin, state.scope);
      if (!company) return { error: "Business not found." };
      if (!company.settings.winBack.enabled) {
        return { ok: false, error: "Win-back texts are turned off for this business. They can be turned on in Settings > AI front desk > Marketer." };
      }
      const out = await draftWinBackCampaign(state.admin, { ...deps, now: () => state.nowMs }, company, { createdBy: "owner", periodKey: null, urgent: true });
      switch (out.status) {
        case "created":
          return {
            ok: true,
            approval_code: out.shortCode,
            audience_count: out.audienceCount,
            note: `Drafted. The owner is being texted the exact message as #${out.shortCode}. Nothing goes out until they reply Y ${out.shortCode} (N ${out.shortCode} to skip).`,
          };
        case "no_audience":
          return { ok: false, audience_count: 0, past_customers_in_window: out.inWindow, left_out: exclusionText(out.excluded), note: "Nobody to text right now - nothing was drafted." };
        case "busy":
          return { ok: false, note: `A win-back campaign is already ${out.campaignStatus === "sending" ? "going out" : "waiting for the owner's OK"}.` };
        default:
          return { ok: false, note: "A campaign is already being drafted." };
      }
    },
  };
}

export const marketingResultsTool: RoleOwnerTool = {
  tool: {
    name: "marketing_results",
    description: "How the last win-back campaign did (texts sent, replies, bookings and quotes within 30 days) plus the Google rating, review count and review replies waiting.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  async run(state: ToolRunState) {
    const scope = state.scope;
    const company = await loadMarketingCompany(state.admin, scope);
    if (!company) return { error: "Business not found." };
    const campaign = await lastCampaign(state.admin, scope);
    const results = campaign ? await campaignResults(state.admin, campaign) : null;
    const db = state.admin as Db;
    const { data: reviews } = await db
      .from("google_reviews")
      .select("rating, reply_status, published_at")
      .eq("organization_id", scope.organizationId)
      .eq("company_id", scope.companyId)
      .gte("published_at", new Date(state.nowMs - 30 * 86_400_000).toISOString())
      .limit(500);
    const recent = (reviews ?? []) as Array<{ rating: number | null; reply_status: string }>;
    return {
      ok: true,
      last_campaign: results
        ? {
            started: results.createdAt.slice(0, 10),
            status: results.status,
            audience: results.audienceCount,
            sent: results.sent,
            still_to_send: results.queued,
            skipped: results.skipped,
            replies: results.replies,
            bookings_within_30_days: results.bookings,
            quotes_within_30_days: results.quotes,
          }
        : null,
      google: {
        rating: company.googleRating,
        review_count: company.googleReviewCount,
        new_reviews_last_30_days: recent.length,
        replies_waiting_for_owner: recent.filter((r) => r.reply_status === "awaiting_owner").length,
      },
    };
  },
};
