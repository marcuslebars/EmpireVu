/**
 * Customer import (docs/ai-staff.md → "Customer import"): a new business brings its existing
 * customer list so the Bookkeeper, Marketer and Dispatcher have history on day one.
 *
 *   • upload a CSV / XLSX (the Import customers page, or the texted /import/:token link)
 *                                                         batches.ts, parse.ts, links.ts
 *   • columns guessed from the header (Jobber, QuickBooks, Housecall Pro, Square…), Claude when
 *     unsure, fixed by the owner in the preview         mapping.ts
 *   • preview, then a chunked import in the sweep: contacts, past jobs as completed bookings,
 *     open balances as invoices on hold — never a message, never a workflow
 *                                                         preview.ts, apply.ts
 *   • undo (whatever hasn't been touched since)           undo.ts
 *   • approval chase_imported_balances: Y lets reminders start on imported balances   approvals.ts
 *   • owner tools send_import_link / import_status         owner-tools.ts
 *
 * Settings: companies.ai_settings.import (settings.ts) — on by default for CrankLeads orgs, off
 * for house orgs (A1 never sees the tools or gets a sweep step unless switched on).
 */
import type { StaffRoleModule } from "@/server/services/staff/types";
import { importerExecutors } from "./approvals";
import { runImportSweep } from "./batches";
import { importOwnerTools, IMPORTER_OWNER_NOTES } from "./owner-tools";
import { importerActiveFor } from "./settings";

export const importerRole: StaffRoleModule = {
  activeFor: importerActiveFor,
  role: "importer",
  approvalExecutors: importerExecutors,
  agentTools: [],
  agentPromptNotes: [],
  ownerTools: importOwnerTools(),
  ownerPromptNotes: IMPORTER_OWNER_NOTES,
  sweeps: [
    {
      name: "importer:batches",
      intervalMs: 30_000,
      run: async (admin, nowMs) => {
        await runImportSweep(admin, nowMs);
      },
    },
  ],
};
