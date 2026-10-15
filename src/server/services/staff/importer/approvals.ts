/**
 * Approval kind `chase_imported_balances`: imported open balances sit on hold (no reminder
 * emails, no Bookkeeper texts, no overdue automations) until the owner says Y.
 *
 *   "14 imported balances, $8,420 owing (oldest from Mar 3). Y to let the Bookkeeper start
 *    reminders on them (texts and emails, your usual schedule)."
 *
 * Y releases the hold on the balances of those batches still on hold (a conditional update — a
 * retry releases nothing twice). N / expiry: they stay on hold; "import status" in a text asks
 * again. A note ("Y 12 $500") can't change anything here, so it is re-asked as written under a
 * fresh code, nothing done.
 */
import { insertApproval } from "@/server/services/front-desk/approvals";
import type { AdminClient, ApprovalDecision, ExecuteResult, OwnerApprovalRow } from "@/server/services/front-desk/contracts";
import { parseInvoiceSettings } from "@/server/services/invoices/settings";
import { readCollectionsSettings } from "@/server/services/staff/bookkeeper/settings";
import type { RoleApprovalExecutor } from "@/server/services/staff/types";
import type { Db } from "./db-types";
import { defaultImporterDeps, type ImporterDeps } from "./deps";
import { loadImportCompany, type ImportCompany } from "./settings";
import { chunks, ownerMoney, plural } from "./util";

export const KIND_CHASE_IMPORTED = "chase_imported_balances";
export const IMPORTER_REQUESTED_BY = "importer";
export const CHASE_TTL_MS = 7 * 86_400_000;

export interface HeldBalances {
  count: number;
  totalCents: number;
  oldestIssue: string | null;
  newestIssue?: string | null;
  batchIds: string[];
}

/** Imported balances still on hold for a company (optionally only some batches). */
export async function loadHeldBalances(admin: AdminClient, scope: { organizationId: string; companyId: string }, batchIds?: string[]): Promise<HeldBalances> {
  let q = (admin as Db)
    .from("invoices")
    .select("id, balance_due_cents, issue_date, import_batch_id, status")
    .eq("organization_id", scope.organizationId)
    .eq("company_id", scope.companyId)
    .eq("import_hold", true)
    .in("status", ["sent", "viewed", "partially_paid"]);
  if (batchIds) q = q.in("import_batch_id", batchIds);
  const { data, error } = await q.limit(30_000);
  if (error) throw error;
  const rows = ((data ?? []) as Array<{ balance_due_cents: number; issue_date: string | null; import_batch_id: string | null }>).filter((r) => (r.balance_due_cents ?? 0) > 0);
  const issues = rows.map((r) => r.issue_date).filter((d): d is string => Boolean(d)).sort();
  return {
    count: rows.length,
    totalCents: rows.reduce((s, r) => s + (r.balance_due_cents ?? 0), 0),
    oldestIssue: issues[0] ?? null,
    newestIssue: issues[issues.length - 1] ?? null,
    batchIds: [...new Set(rows.map((r) => r.import_batch_id).filter((id): id is string => Boolean(id)))],
  };
}

function shortDate(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : date;
}

/** What Y does for this company, in the owner's words. PURE. */
export function chaseEffect(input: { bookkeeperOn: boolean; textReminders: boolean; emailReminders: boolean }): string {
  const texts = input.bookkeeperOn && input.textReminders;
  if (texts && input.emailReminders) return "Y to let the Bookkeeper start reminders on them (texts and emails, your usual schedule).";
  if (texts) return "Y to let the Bookkeeper start reminder texts on them (your usual schedule).";
  if (input.emailReminders) return "Y to start your invoice reminder emails on them (your usual schedule).";
  return "Y to treat them like your other invoices (your reminders are off, so nothing goes out until you turn them on).";
}

/** The approval summary (≤500). PURE. */
export function chaseSummary(held: Pick<HeldBalances, "count" | "totalCents" | "oldestIssue" | "newestIssue">, effect: string): string {
  const first = held.oldestIssue;
  const oldest = first && held.count > 1 && first !== (held.newestIssue ?? null) ? ` (oldest from ${shortDate(first)})` : "";
  const what = held.count === 1 ? "1 imported balance" : `${held.count.toLocaleString("en-CA")} imported balances`;
  return `${what}, ${ownerMoney(held.totalCents)} owing${oldest}. Nobody has been reminded yet. ${effect}`.slice(0, 500);
}

export async function chaseEffectFor(admin: AdminClient, company: ImportCompany): Promise<string> {
  const { data } = await (admin as Db).from("companies").select("ai_settings").eq("organization_id", company.organizationId).eq("id", company.companyId).maybeSingle();
  const collections = readCollectionsSettings((data as { ai_settings?: unknown } | null)?.ai_settings, { doneForYou: company.doneForYou });
  const email = parseInvoiceSettings((company.invoiceSettings ?? null) as never).remindersEnabled;
  return chaseEffect({ bookkeeperOn: collections.enabled, textReminders: collections.textReminders, emailReminders: email });
}

/** A pending chase approval for this company, if there is one. */
export async function pendingChase(admin: AdminClient, companyId: string): Promise<{ id: string; short_code: number | null } | null> {
  const { data } = await (admin as Db).from("owner_approvals").select("id, short_code").eq("company_id", companyId).eq("kind", KIND_CHASE_IMPORTED).eq("status", "pending").limit(1);
  return ((data ?? []) as Array<{ id: string; short_code: number | null }>)[0] ?? null;
}

export interface CreatedChase {
  id: string;
  shortCode: number | null;
  summary: string;
}

/**
 * Create the approval for these held balances (none → null). `inlineTo`: the caller texts the
 * question itself (the import-done text); otherwise the owner channel notifies (quiet hours apply).
 */
export async function createChaseApproval(
  admin: AdminClient,
  company: ImportCompany,
  held: HeldBalances,
  deps: Pick<ImporterDeps, "notify" | "now">,
  options: { inlineTo?: string | null } = {},
): Promise<CreatedChase | null> {
  if (held.count === 0) return null;
  const nowMs = deps.now();
  const summary = chaseSummary(held, await chaseEffectFor(admin, company));
  const row = await insertApproval(admin, {
    organizationId: company.organizationId,
    companyId: company.companyId,
    contactId: null,
    conversationId: null,
    kind: KIND_CHASE_IMPORTED,
    summary,
    payload: { batchIds: held.batchIds, count: held.count, totalCents: held.totalCents },
    requestedBy: IMPORTER_REQUESTED_BY,
    createdAt: new Date(nowMs),
    expiresAt: new Date(nowMs + CHASE_TTL_MS),
    notifiedAt: options.inlineTo ? new Date(nowMs) : null,
    notifiedTo: options.inlineTo ?? null,
  });
  if (!options.inlineTo) {
    try {
      await deps.notify(admin, row.id);
    } catch (err) {
      console.error("[importer] notify failed:", err instanceof Error ? err.message : err);
    }
  }
  return { id: row.id, shortCode: row.short_code, summary };
}

function batchIdsOf(approval: OwnerApprovalRow): string[] {
  const ids = approval.payload?.batchIds;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id)).slice(0, 200) : [];
}

async function markBatches(admin: AdminClient, approval: OwnerApprovalRow, status: "approved" | "declined"): Promise<void> {
  const ids = batchIdsOf(approval);
  if (ids.length === 0) return;
  await (admin as Db).from("import_batches").update({ chase_status: status }).eq("organization_id", approval.organization_id).eq("company_id", approval.company_id).in("id", ids);
}

export function chaseExecutor(deps: ImporterDeps = defaultImporterDeps): RoleApprovalExecutor {
  return async (admin: AdminClient, approval: OwnerApprovalRow, decision: ApprovalDecision): Promise<ExecuteResult> => {
    const code = `#${approval.short_code ?? "?"}`;
    const count = typeof approval.payload?.count === "number" ? approval.payload.count : 0;
    const cents = typeof approval.payload?.totalCents === "number" ? approval.payload.totalCents : 0;
    const what = `${plural(count, "imported balance")} (${ownerMoney(cents)})`;
    if (!decision.approved) {
      await markBatches(admin, approval, "declined");
      const lead = decision.decidedVia === "expiry" ? `No answer on ${code} - the` : "OK - the";
      return { ok: true, message: `${lead} ${what} stay on hold: no reminders. Text "import status" any time to start them.` };
    }
    if ((decision.ownerNote ?? "").trim()) {
      // Nothing here takes a note: ask again, exactly as written, under a fresh code.
      const company = await loadImportCompany(admin, approval.organization_id, approval.company_id);
      if (company) {
        const held = await loadHeldBalances(admin, { organizationId: approval.organization_id, companyId: approval.company_id }, batchIdsOf(approval));
        const fresh = await createChaseApproval(admin, company, held, deps);
        if (fresh) {
          return { ok: false, message: `Nothing changed yet - that one can't take a note. Reply Y ${fresh.shortCode ?? "?"} to start reminders on the ${plural(held.count, "imported balance")}, or N ${fresh.shortCode ?? "?"} to leave them on hold.`, detail: { reaskedAs: fresh.id } };
        }
      }
      return { ok: false, message: "Nothing changed - that one can't take a note, and there's nothing on hold any more." };
    }
    const ids = batchIdsOf(approval);
    if (ids.length === 0) return { ok: false, message: "I couldn't tell which import that was - nothing changed." };
    let released = 0;
    let releasedCents = 0;
    for (const list of chunks(ids, 50)) {
      const { data, error } = await (admin as Db)
        .from("invoices")
        .update({ import_hold: false, reminders_paused: false })
        .eq("organization_id", approval.organization_id)
        .eq("company_id", approval.company_id)
        .eq("import_hold", true)
        .in("import_batch_id", list)
        .select("id, balance_due_cents");
      if (error) throw error;
      for (const r of (data ?? []) as Array<{ balance_due_cents: number }>) {
        released++;
        releasedCents += r.balance_due_cents ?? 0;
      }
    }
    await markBatches(admin, approval, "approved");
    if (released === 0) return { ok: true, message: "Those imported balances were already released - nothing to change." };
    return { ok: true, message: `Done - reminders can start on ${plural(released, "imported balance")} (${ownerMoney(releasedCents)}), on your usual schedule.` };
  };
}

export const importerExecutors: Record<string, RoleApprovalExecutor> = {
  [KIND_CHASE_IMPORTED]: chaseExecutor(),
};
