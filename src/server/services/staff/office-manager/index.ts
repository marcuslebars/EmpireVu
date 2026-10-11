/**
 * Office manager (docs/ai-staff.md → "Office manager"): the owner's morning briefing — one text
 * a day with today's jobs, weather risk, money, what's waiting on them and yesterday's activity.
 * It also carries the Bookkeeper's 8am money alert on briefing days (one text, not two).
 */
import type { StaffRoleModule } from "@/server/services/staff/types";
import { runMorningBriefings, SWEEP_INTERVAL_MS } from "./briefing";
import { officeManagerOwnerTools } from "./owner-tool";
import { officeManagerActiveFor } from "./settings";

export const officeManagerRole: StaffRoleModule = {
  role: "office_manager",
  approvalExecutors: {},
  agentTools: [],
  agentPromptNotes: [],
  ownerTools: officeManagerOwnerTools(),
  ownerPromptNotes: [
    "If briefing_now is available: the owner gets a short morning briefing by text ending 'Reply \"today\" for details.' When they text 'today', 'details', 'briefing' or 'what's on today', call briefing_now with detail=true and relay its details plainly (short lines). It is a read-only preview: never say it re-sent or changed the morning text. To approve or skip something listed, the owner replies Y or N with its number.",
  ],
  sweeps: [{ name: "office-manager:briefing", intervalMs: SWEEP_INTERVAL_MS, run: async (admin, nowMs) => void (await runMorningBriefings(admin, nowMs)) }],
  activeFor: officeManagerActiveFor,
};
