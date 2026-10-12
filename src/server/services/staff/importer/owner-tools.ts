/**
 * The import's tools for the owner-by-text agent, scoped to the company the owner's phone
 * resolved to (state.scope):
 *
 *   send_import_link   texts the owner the /import/:token link (upload a spreadsheet, see a preview)
 *   import_status      the latest imports, balances on hold, and — when asked — the
 *                      chase_imported_balances question ("Reply Y 12 …"); nothing is released here.
 */
import type { ToolRunState } from "@/server/services/owner-channel/tools";
import { replyInstruction } from "@/server/services/front-desk/approval-text";
import type { RoleOwnerTool } from "@/server/services/staff/types";
import { createChaseApproval, KIND_CHASE_IMPORTED, loadHeldBalances, pendingChase } from "./approvals";
import { listBatches } from "./batches";
import { defaultImporterDeps, type ImporterDeps } from "./deps";
import { sendImportLink } from "./links";
import { loadImportCompany } from "./settings";
import { ownerMoney } from "./util";

export const IMPORT_OFF = "Customer import is off for this business (Settings > AI front desk > Customer import).";

const STATUS_WORDS: Record<string, string> = {
  uploading: "waiting for the file",
  uploaded: "reading the file",
  mapped: "building the preview",
  previewed: "preview ready - waiting for you to press Import",
  importing: "importing now",
  done: "done",
  failed: "failed",
  undoing: "being undone",
  undone: "undone",
};

export function importOwnerTools(deps: ImporterDeps = defaultImporterDeps): RoleOwnerTool[] {
  return [
    {
      tool: {
        name: "send_import_link",
        description:
          "Text the owner a link to bring their existing customer list over (a CSV or Excel export from Jobber, QuickBooks, Housecall Pro, Square or a spreadsheet). They see a preview before anything is saved; no customer is texted. Use when the owner asks to import / upload / bring over their customers.",
        input_schema: { type: "object", properties: {} },
      },
      run: async (state: ToolRunState) => {
        try {
          const out = await sendImportLink(state.admin, state.scope, { ...deps, now: () => state.nowMs });
          if (out.status === "off") return { ok: false, error: IMPORT_OFF };
          if (out.status === "sent") return { ok: true, texted_link: true, note: "The link went out in its own text - just confirm it's on its way." };
          if (out.status === "no_phone") return { ok: false, error: "Your cell isn't confirmed for owner texts yet.", link: out.url };
          return { ok: false, error: "The text didn't go through.", link: out.url };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : "Couldn't make the link." };
        }
      },
    },
    {
      tool: {
        name: "import_status",
        description:
          "Where the owner's customer imports stand: the latest imports and what they brought in, and imported balances still on hold (no reminders yet). Set start_reminders true when the owner wants the Bookkeeper to start reminders on imported balances - that only creates an approval; reply with the returned tell_owner text exactly.",
        input_schema: { type: "object", properties: { start_reminders: { type: "boolean" } } },
      },
      run: async (state: ToolRunState, input: Record<string, unknown>) => {
        try {
          const company = await loadImportCompany(state.admin, state.scope.organizationId, state.scope.companyId);
          if (!company) return { ok: false, error: "Business not found." };
          if (!company.settings.enabled) return { ok: false, error: IMPORT_OFF };
          const batches = await listBatches(state.admin, state.scope, 3);
          const held = await loadHeldBalances(state.admin, state.scope);
          const pending = await pendingChase(state.admin, state.scope.companyId);
          const imports = batches.map((b) => ({
            file: b.fileName,
            started: b.createdAt.slice(0, 10),
            status: STATUS_WORDS[b.status] ?? b.status,
            customers_new: b.counts?.contactsCreated ?? null,
            customers_already_had: b.counts?.contactsMatched ?? null,
            past_jobs: b.counts?.jobsCreated ?? null,
            balances: b.counts?.balancesCreated ?? null,
            rows_skipped: b.counts?.invalidRows ?? null,
            undo: b.undoSummary,
          }));
          const base = {
            ok: true,
            imports,
            balances_on_hold: held.count,
            on_hold_owing: ownerMoney(held.totalCents),
            pending_question: pending ? `#${pending.short_code ?? "?"}` : null,
          };
          if (input.start_reminders !== true) return base;
          if (pending) return { ...base, tell_owner: `That's waiting on your answer: reply Y ${pending.short_code ?? "?"} to start reminders on the imported balances, N ${pending.short_code ?? "?"} to keep them on hold.` };
          if (held.count === 0) return { ...base, tell_owner: "No imported balances are on hold - nothing to start." };
          const chase = await createChaseApproval(state.admin, company, held, { ...deps, now: () => state.nowMs }, { inlineTo: state.ownerPhone });
          if (!chase) return base;
          return { ...base, approval_created: true, tell_owner: `#${chase.shortCode ?? "?"} ${chase.summary} ${replyInstruction(KIND_CHASE_IMPORTED, chase.shortCode)}` };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : "Couldn't read the imports." };
        }
      },
    },
  ];
}

export const IMPORTER_OWNER_NOTES = [
  "Customer list: when the owner wants to bring over / import / upload their customers from another app or a spreadsheet, use send_import_link (it texts them the link). import_status says how their imports went. Imported balances get no reminders until the owner OKs it: if they want reminders started on them, use import_status with start_reminders true and reply with its tell_owner text exactly. An import never texts or emails customers.",
];
