/**
 * The ESTIMATOR (docs/ai-staff.md "## Estimator"): prices jobs the price list can't (photos +
 * description → AI estimate → the owner's OK → a quote), and follows every front-desk quote up
 * by text until it's booked.
 *
 *   SMS agent tool   request_estimate          (request-tool.ts)
 *   approval kind    ai_estimate               (approval.ts)
 *   owner tool       pending_estimates         (owner-tool.ts)
 *   sweep            estimator-quote-follow-up (follow-up.ts)
 *   settings         companies.ai_settings.estimator (settings.ts)
 */
import { executeAiEstimate } from "@/server/services/staff/estimator/approval";
import { sweepQuoteFollowUps } from "@/server/services/staff/estimator/follow-up";
import { pendingEstimatesTool } from "@/server/services/staff/estimator/owner-tool";
import { AI_ESTIMATE_KIND, requestEstimateTool } from "@/server/services/staff/estimator/request-tool";
import type { StaffRoleModule } from "@/server/services/staff/types";
import type { AgentTool } from "@/server/services/sms-agent/tools";

export const ESTIMATOR_AGENT_NOTES: string[] = [
  "If request_estimate is available: for work the price list doesn't cover (damage, repairs, custom jobs, \"how much to fix this?\", photos of a problem), get what's needed (what, where, roughly how big; ask for a photo if it would help), then call request_estimate with every detail they gave. Price-list services still go through quote_from_price_list / send_quote_link.",
  "If request_estimate is available: after calling it, NEVER state, guess or hint at a price, range or ballpark for that work - not even if they push. Say the owner will look it over and you'll text the quote as soon as it's ready. If it returns questions, ask them (one or two at a time) and call it again with answers_to_questions: true and the job plus their answers. If they ask about the job already being estimated, pass same_job: true.",
  "If request_estimate is available and says an estimate is already in progress for a DIFFERENT job, don't promise a quote for the new job: use request_owner_approval (kind custom_price) or hand_off_to_owner for it.",
];

export const ESTIMATOR_OWNER_NOTES: string[] = [
  "If pending_estimates is available: it shows AI estimates waiting on the owner (with reply codes), ones still collecting details, and quotes being followed up by text. The owner approves an estimate themselves by replying Y <code> (or Y <code> $price to change the total before HST); you can't approve, price or send one for them.",
];

export const estimatorRole: StaffRoleModule = {
  role: "estimator",
  approvalExecutors: { [AI_ESTIMATE_KIND]: executeAiEstimate },
  agentTools: [requestEstimateTool as unknown as AgentTool<never>],
  agentPromptNotes: ESTIMATOR_AGENT_NOTES,
  ownerTools: [pendingEstimatesTool],
  ownerPromptNotes: ESTIMATOR_OWNER_NOTES,
  sweeps: [
    {
      name: "estimator-quote-follow-up",
      intervalMs: 5 * 60_000,
      run: async (admin, nowMs) => {
        await sweepQuoteFollowUps(admin, nowMs);
      },
    },
  ],
};
