/**
 * The Bookkeeper (docs/ai-staff.md → "Bookkeeper"): gets invoices paid and keeps the owner's
 * money picture straight.
 *
 *   • text reminders with the pay link for overdue invoices (gentle → firm), coordinated with the
 *     email reminders, then a final notice with the owner's OK      reminders.ts, deliver.ts
 *   • the SMS agent's my_invoices / promise_to_pay / request_payment_plan   agent-tools.ts
 *   • the owner's who_owes_me / cash_snapshot / record_offline_payment / remind_now   owner-tools.ts
 *   • approvals: collections_final_notice, payment_plan, record_payment, send_invoice_reminder   approvals.ts
 *   • the 08:00 owner money alert with reconciliation flags          daily-alert.ts
 *
 * Settings: companies.ai_settings.collections (settings.ts) — on by default for CrankLeads orgs,
 * off for house orgs (A1 keeps today's behaviour unless switched on).
 */
import { bookkeeperActiveFor } from "@/server/services/staff/bookkeeper/settings";
import type { StaffRoleModule } from "@/server/services/staff/types";
import { bookkeeperAgentTools } from "./agent-tools";
import { bookkeeperExecutors } from "./approvals";
import { runDailyMoneyAlerts } from "./daily-alert";
import { bookkeeperOwnerTools } from "./owner-tools";
import { BOOKKEEPER_AGENT_NOTES, BOOKKEEPER_OWNER_NOTES } from "./prompt-notes";
import { runReminderSweep } from "./reminders";

export const bookkeeperRole: StaffRoleModule = {
  activeFor: bookkeeperActiveFor,
  role: "bookkeeper",
  approvalExecutors: bookkeeperExecutors,
  agentTools: bookkeeperAgentTools,
  agentPromptNotes: BOOKKEEPER_AGENT_NOTES,
  ownerTools: bookkeeperOwnerTools,
  ownerPromptNotes: BOOKKEEPER_OWNER_NOTES,
  sweeps: [
    {
      name: "bookkeeper:reminder-texts",
      intervalMs: 15 * 60_000,
      run: async (admin, nowMs) => {
        await runReminderSweep(admin, nowMs);
      },
    },
    {
      name: "bookkeeper:money-alert",
      intervalMs: 10 * 60_000,
      run: async (admin, nowMs) => {
        await runDailyMoneyAlerts(admin, nowMs);
      },
    },
  ],
};
