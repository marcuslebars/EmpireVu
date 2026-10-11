/**
 * The Marketer (docs/ai-staff.md → "Marketer"): win-back campaigns to past customers, Google
 * review reply drafts, and weekly Google listing post drafts. Every one waits for the owner's
 * Y by text (approval kinds marketing_campaign, review_reply, google_post).
 */
import { executeMarketingCampaign, MARKETING_CAMPAIGN_KIND, sendCampaignBatches, sweepMonthlyWinBack } from "@/server/services/staff/marketer/campaigns";
import { defaultMarketerDeps } from "@/server/services/staff/marketer/deps";
import { marketingResultsTool, startWinBackTool, stopCampaignTool } from "@/server/services/staff/marketer/owner-tools";
import { executeGooglePost, GOOGLE_POST_KIND, sweepGooglePosts } from "@/server/services/staff/marketer/posts";
import { executeReviewReply, REVIEW_REPLY_KIND, sweepGoogleReviews } from "@/server/services/staff/marketer/reviews";
import { listMarketingCompanies } from "@/server/services/staff/marketer/settings";
import type { StaffRoleModule } from "@/server/services/staff/types";

const deps = defaultMarketerDeps;

export const MARKETER_AGENT_NOTES = [
  "Past-customer texts: the business sometimes sends past customers a short check-in text (a win-back message). If the customer is replying to one, treat it like any new enquiry - help them book or price from the price list. Never invent a discount, deal or deadline the business didn't state.",
];

export const MARKETER_OWNER_NOTES = [
  "start_win_back drafts a text campaign to past customers; it never sends. After it runs, tell the owner the audience size and to reply Y <code> to send it (they get the exact text separately). If it's off for this business, say it can be turned on in Settings.",
  "stop_campaign stops a win-back campaign immediately (owner says stop / cancel the campaign or the past-customer texts). It acts right away - no code needed, it only ever stops texts.",
  "marketing_results answers how the last campaign did (sent, replies, bookings, quotes) and the Google rating / reviews. Google review replies and weekly Google posts arrive as their own approvals; on Y the owner is texted the text to paste on Google.",
];

export const marketerRole: StaffRoleModule = {
  role: "marketer",
  approvalExecutors: {
    [MARKETING_CAMPAIGN_KIND]: (admin, approval, decision) => executeMarketingCampaign(admin, approval, decision, deps),
    [REVIEW_REPLY_KIND]: (admin, approval, decision) => executeReviewReply(admin, approval, decision, deps),
    [GOOGLE_POST_KIND]: (admin, approval, decision) => executeGooglePost(admin, approval, decision, deps),
  },
  agentTools: [],
  agentPromptNotes: MARKETER_AGENT_NOTES,
  ownerTools: [startWinBackTool(deps), stopCampaignTool, marketingResultsTool],
  ownerPromptNotes: MARKETER_OWNER_NOTES,
  sweeps: [
    { name: "marketer_campaign_sender", intervalMs: 5 * 60_000, run: async (admin, nowMs) => void (await sendCampaignBatches(admin, { ...deps, now: () => nowMs })) },
    {
      // One company listing per hour, shared by the three daytime passes (each claims its own period).
      name: "marketer_hourly",
      intervalMs: 60 * 60_000,
      run: async (admin, nowMs) => {
        const at = { ...deps, now: () => nowMs };
        const companies = await listMarketingCompanies(admin);
        await sweepMonthlyWinBack(admin, at, companies);
        await sweepGoogleReviews(admin, at, companies);
        await sweepGooglePosts(admin, at, companies);
      },
    },
  ],
};
