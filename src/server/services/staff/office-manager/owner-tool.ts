/**
 * Owner tool `briefing_now`: today's briefing in the chat (the owner texts "today", "details" or
 * "what's on today"). Read-only: it never claims or marks the daily send, and the Bookkeeper's
 * alert items it shows stay unreported for the morning text. Runs against the ONE company the
 * owner's phone resolved to (state.scope). Never throws.
 */
import type { RoleOwnerTool } from "@/server/services/staff/types";
import type { ToolRunState } from "@/server/services/owner-channel/tools";
import { composeFor } from "./briefing";
import { detailsText } from "./email";
import { defaultBriefingDeps, gatherBriefing, type BriefingDeps } from "./gather";
import { daysLabel, loadBriefingCompany, timeLabel } from "./settings";

export async function briefingNow(state: ToolRunState, input: Record<string, unknown>, deps: BriefingDeps = defaultBriefingDeps): Promise<Record<string, unknown>> {
  const company = await loadBriefingCompany(state.admin, state.scope.organizationId, state.scope.companyId);
  if (!company) return { error: "Business not found." };
  const gathered = await gatherBriefing(state.admin, company, state.nowMs, deps, { fold: true });
  const composed = composeFor(company, gathered);
  const detail = input.detail === true;
  return {
    ok: true,
    briefing: composed.text,
    ...(detail ? { details: detailsText(gathered.details) || "Nothing more to add today." } : {}),
    schedule: company.settings.enabled
      ? `Morning text at ${timeLabel(company.settings.time)}, ${daysLabel(company.settings.days)}${company.settings.channels.includes("email") ? ", with an email copy" : ""}.`
      : "The morning text is off.",
    note: "A preview only - the morning text is unchanged.",
  };
}

export function officeManagerOwnerTools(deps: BriefingDeps = defaultBriefingDeps): RoleOwnerTool[] {
  return [
    {
      tool: {
        name: "briefing_now",
        description:
          "Today's morning briefing for the business: today's jobs by crew, weather risk, money (collected, overdue), approvals waiting on the owner with their codes, and yesterday's activity. Use when the owner texts 'today', 'details', 'briefing' or asks what's on today. detail=true adds every job, who's late paying and each approval in full.",
        input_schema: { type: "object", properties: { detail: { type: "boolean", description: "Include the full lists (true when the owner asks for details or replies 'today')." } } },
      },
      run: async (state, input) => {
        try {
          return await briefingNow(state, input, deps);
        } catch (err) {
          console.error("[office-manager] briefing_now failed:", err instanceof Error ? err.message : err);
          return { error: "That didn't work on our side." };
        }
      },
    },
  ];
}
