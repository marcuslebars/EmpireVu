import { useState } from "react";
import { FileText, Plus, Receipt } from "lucide-react";

import { ExpenseDialog } from "@/components/expenses/ExpenseDialog";
import { formatCents } from "@/lib/invoices-api";
import { categoryLabel, useExpenses, type Expense } from "@/lib/expenses-api";

const ALL_TIME = { from: "2000-01-01", to: "2100-01-01" };

/** Receipts / expenses on one job. Crew see what they logged; owners and admins see everyone's. */
export function JobExpenses({
  orgId,
  job,
  manager,
  readOnly,
}: {
  orgId: string;
  job: { id: string; title: string };
  manager: boolean;
  readOnly: boolean;
}) {
  const { data } = useExpenses(orgId, { ...ALL_TIME, bookingId: job.id });
  const [editing, setEditing] = useState<Expense | "new" | null>(null);
  const expenses = data?.expenses ?? [];
  const total = expenses.reduce((s, e) => s + e.amountCents, 0);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
          <Receipt className="w-3 h-3" />
          Expenses {total > 0 && <span className="normal-case tracking-normal font-semibold text-foreground">{formatCents(total)}</span>}
        </h4>
        {!readOnly && (
          <button
            type="button"
            onClick={() => setEditing("new")}
            className="flex items-center gap-1.5 px-3 h-8 rounded-lg text-xs font-semibold border bg-secondary border-border text-foreground hover:bg-secondary/80"
          >
            <Plus className="w-3.5 h-3.5" /> Add receipt
          </button>
        )}
      </div>
      {expenses.length === 0 ? (
        <p className="text-xs text-muted-foreground">No receipts on this job yet{readOnly ? "." : " — snap one when you buy parts or supplies."}</p>
      ) : (
        <ul className="rounded-lg border border-border divide-y divide-border text-sm">
          {expenses.map((e) => (
            <li key={e.id}>
              <button type="button" onClick={() => setEditing(e)} className="w-full flex items-center justify-between gap-3 px-3 py-2 text-left hover:bg-secondary/40">
                <span className="min-w-0">
                  <span className="text-foreground truncate block">
                    {e.description || e.vendor || categoryLabel(e.category)}
                    {e.receiptType && <FileText className="inline w-3 h-3 ml-1.5 text-muted-foreground" aria-label="Has receipt" />}
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    {e.vendor && e.description ? `${e.vendor} · ` : ""}
                    {e.personName ?? "Team member"}
                    {e.billable && (e.billedInvoiceId ? " · billed" : " · to bill")}
                    {e.paidWith === "personal" && !e.reimbursedAt && " · owed back"}
                  </span>
                </span>
                <span className="tabular-nums text-foreground shrink-0">{formatCents(e.amountCents)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <ExpenseDialog orgId={orgId} expense={editing === "new" ? null : editing} job={job} manager={manager} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}
