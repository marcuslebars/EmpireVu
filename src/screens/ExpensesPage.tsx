import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Download, FileText, HandCoins, Loader2, Plus, Receipt, Search } from "lucide-react";

import { ExpenseDialog } from "@/components/expenses/ExpenseDialog";
import { errorMessage } from "@/components/invoices/invoice-ui";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorBanner, SkeletonCard } from "@/components/ui/StateViews";
import { toast } from "@/components/ui/sonner";
import { useOrgMembers } from "@/lib/api-hooks";
import { useAuth } from "@/lib/auth-context";
import {
  EXPENSE_CATEGORIES,
  categoryLabel,
  downloadExpensesCsv,
  useExpenses,
  useSetReimbursed,
  type Expense,
  type ExpenseQuery,
} from "@/lib/expenses-api";
import { formatCents } from "@/lib/invoices-api";
import { useOrg } from "@/lib/org-context";
import { PRESETS, addDaysYmd, presetRange, rangeLabel, shortDate, ymd, type Preset } from "@/lib/reports-api";
import { cn } from "@/lib/utils";

const ctl = "h-9 rounded-md border border-input bg-background px-2.5 text-sm text-foreground";

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-card border border-border rounded-xl p-4 min-w-0">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="text-2xl font-bold tabular-nums text-foreground mt-1 truncate">{value}</p>
      {sub && <p className="text-[11px] text-muted-foreground mt-0.5">{sub}</p>}
    </div>
  );
}

function Badges({ e }: { e: Expense }) {
  const chip = "inline-flex items-center rounded-full px-1.5 py-px text-[10px] font-semibold";
  return (
    <>
      {e.paidWith === "personal" &&
        (e.reimbursedAt ? (
          <span className={cn(chip, "bg-secondary text-muted-foreground")}>Paid back</span>
        ) : (
          <span className={cn(chip, "bg-amber-500/15 text-amber-700 dark:text-amber-400")}>Owed back</span>
        ))}
      {e.billable &&
        (e.billedInvoiceId ? (
          <span className={cn(chip, "bg-secondary text-muted-foreground")}>Billed{e.billedInvoiceNumber ? ` · ${e.billedInvoiceNumber}` : ""}</span>
        ) : (
          <span className={cn(chip, "bg-primary/10 text-primary")}>To bill</span>
        ))}
    </>
  );
}

/** Money owed back to people who paid out of pocket — owners/admins settle it here. */
function OwedCard({ orgId }: { orgId: string }) {
  const today = ymd(new Date());
  const q = useMemo(() => ({ from: addDaysYmd(today, -730), to: addDaysYmd(today, 1), owed: true }), [today]);
  const { data } = useExpenses(orgId, q);
  const mark = useSetReimbursed(orgId);
  const [busy, setBusy] = useState<string | null>(null);
  if (!data || data.expenses.length === 0) return null;
  const people = new Map<string, { name: string; cents: number; ids: string[] }>();
  for (const e of data.expenses) {
    const k = e.createdBy ?? "unknown";
    const p = people.get(k) ?? { name: e.personName ?? "Team member", cents: 0, ids: [] };
    p.cents += e.amountCents;
    p.ids.push(e.id);
    people.set(k, p);
  }
  const settle = async (key: string, p: { name: string; cents: number; ids: string[] }) => {
    setBusy(key);
    try {
      await mark.mutateAsync({ ids: p.ids, reimbursed: true });
      toast.success(`Marked ${formatCents(p.cents)} paid back to ${p.name}`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
      <p className="text-sm font-semibold text-foreground flex items-center gap-2">
        <HandCoins className="w-4 h-4 text-amber-600" /> Owed back to your team
      </p>
      <ul className="mt-2 divide-y divide-border/60">
        {[...people.entries()].map(([key, p]) => (
          <li key={key} className="flex items-center justify-between gap-3 py-2">
            <span className="text-sm text-foreground min-w-0 truncate">
              {p.name} <span className="text-muted-foreground text-xs">· {p.ids.length} receipt{p.ids.length === 1 ? "" : "s"}</span>
            </span>
            <span className="flex items-center gap-3 shrink-0">
              <span className="tabular-nums font-semibold text-foreground">{formatCents(p.cents)}</span>
              <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void settle(key, p)}>
                {busy === key && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
                Mark paid back
              </Button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function ExpensesPage() {
  const { organizationId, companyId, isValid } = useOrg();
  const { session } = useAuth();
  const role = session?.organizations.find((o) => o.id === organizationId)?.membershipRole ?? "member";
  const manager = role === "owner" || role === "admin";
  const { data: members = [] } = useOrgMembers(organizationId);

  const [params, setParams] = useSearchParams();
  const preset = (PRESETS.some((p) => p.id === params.get("range")) ? params.get("range") : "this_month") as Preset;
  const [customFrom, setCustomFrom] = useState(params.get("from") ?? presetRange("this_month").from);
  const [customTo, setCustomTo] = useState(params.get("to") ?? addDaysYmd(presetRange("this_month").to, -1));
  const [category, setCategory] = useState("");
  const [kind, setKind] = useState<"" | "job" | "overhead">("");
  const [person, setPerson] = useState("");
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Expense | "new" | null>(null);
  const [exporting, setExporting] = useState(false);

  const range = useMemo(() => {
    if (preset !== "custom") {
      const r = presetRange(preset);
      return { from: r.from, to: addDaysYmd(r.to, -1) };
    }
    return { from: params.get("from") ?? customFrom, to: params.get("to") ?? customTo };
  }, [preset, params, customFrom, customTo]);

  const query: ExpenseQuery = useMemo(
    () => ({ ...range, companyId: companyId ?? null, category: category || null, kind: kind || null, profileId: person || null, q: search.trim() || null }),
    [range, companyId, category, kind, person, search],
  );
  const { data, isLoading, isError, error, refetch } = useExpenses(organizationId, query, isValid);

  const setPreset = (p: Preset) => {
    const next = new URLSearchParams(params);
    if (p === "this_month") next.delete("range");
    else next.set("range", p);
    if (p === "custom") {
      next.set("from", customFrom);
      next.set("to", customTo);
    } else {
      next.delete("from");
      next.delete("to");
    }
    setParams(next, { replace: true });
  };
  const applyCustom = (from: string, to: string) => {
    setCustomFrom(from);
    setCustomTo(to);
    if (from && to && from <= to) {
      const next = new URLSearchParams(params);
      next.set("range", "custom");
      next.set("from", from);
      next.set("to", to);
      setParams(next, { replace: true });
    }
  };

  const onExport = async () => {
    setExporting(true);
    try {
      await downloadExpensesCsv(organizationId, query);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setExporting(false);
    }
  };

  if (!isValid) return <EmptyState title="Workspace not ready" description="Select an organization to see expenses." />;

  const s = data?.summary;
  const top = s?.byCategory.slice(0, 6) ?? [];
  const maxCat = Math.max(1, ...top.map((c) => c.cents));

  return (
    <div className="max-w-[1440px] mx-auto space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Expenses</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {rangeLabel(range.from, addDaysYmd(range.to, 1))}
            {!manager && " · the receipts you've logged"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" disabled={exporting || !data?.expenses.length} onClick={() => void onExport()}>
            {exporting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Download className="w-4 h-4 mr-2" />}
            Export CSV
          </Button>
          <Button size="sm" onClick={() => setEditing("new")}>
            <Plus className="w-4 h-4 mr-2" />
            Add expense
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="Date range" value={preset} onChange={(e) => setPreset(e.target.value as Preset)} className={ctl}>
          {PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        {preset === "custom" && (
          <>
            <input aria-label="From" type="date" value={customFrom} max={customTo} onChange={(e) => applyCustom(e.target.value, customTo)} className={ctl} />
            <span className="text-sm text-muted-foreground">to</span>
            <input aria-label="To" type="date" value={customTo} min={customFrom} onChange={(e) => applyCustom(customFrom, e.target.value)} className={ctl} />
          </>
        )}
        <select aria-label="Category" value={category} onChange={(e) => setCategory(e.target.value)} className={ctl}>
          <option value="">All categories</option>
          {EXPENSE_CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
        <select aria-label="Job or overhead" value={kind} onChange={(e) => setKind(e.target.value as "" | "job" | "overhead")} className={ctl}>
          <option value="">Jobs & overhead</option>
          <option value="job">On jobs</option>
          <option value="overhead">Overhead</option>
        </select>
        {manager && (
          <select aria-label="Person" value={person} onChange={(e) => setPerson(e.target.value)} className={ctl}>
            <option value="">Everyone</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name || m.email}
              </option>
            ))}
          </select>
        )}
        <label className="relative">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input aria-label="Search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search vendor or note" className={cn(ctl, "pl-8 w-48")} />
        </label>
      </div>

      {manager && <OwedCard orgId={organizationId} />}

      {isError ? (
        <ErrorBanner message={error instanceof Error ? error.message : "Couldn't load expenses."} onRetry={() => refetch()} />
      ) : isLoading || !data || !s ? (
        <div className="space-y-5">
          <SkeletonCard rows={2} />
          <SkeletonCard rows={5} />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Tile label="Spent" value={formatCents(s.totalCents)} sub={`${s.count} expense${s.count === 1 ? "" : "s"}, tax included`} />
            <Tile label="Before tax" value={formatCents(s.preTaxCents)} sub={`${formatCents(s.onJobsCents)} on jobs · ${formatCents(s.overheadCents)} overhead`} />
            <Tile label="Sales tax paid" value={formatCents(s.taxCents)} sub="What you may be able to claim back" />
            <Tile label="Owed back" value={formatCents(s.owedCents)} sub={s.owedCents ? "Paid out of pocket, not yet repaid" : "Nobody's out of pocket"} />
          </div>

          {top.length > 0 && (
            <div className="rounded-xl border border-border bg-card p-4">
              <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-3">By category (before tax)</p>
              <ul className="grid sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-2.5">
                {top.map((c) => (
                  <li key={c.category}>
                    <button
                      type="button"
                      onClick={() => setCategory(category === c.category ? "" : c.category)}
                      className="w-full text-left"
                      aria-pressed={category === c.category}
                    >
                      <div className="flex items-baseline justify-between gap-3 text-sm">
                        <span className={cn("truncate", category === c.category ? "text-primary font-medium" : "text-foreground")}>
                          {c.label} <span className="text-muted-foreground text-xs">· {c.count}</span>
                        </span>
                        <span className="tabular-nums font-medium text-foreground">{formatCents(c.cents)}</span>
                      </div>
                      <div className="h-1.5 mt-1 rounded-full bg-secondary overflow-hidden">
                        <div className="h-full rounded-full bg-primary" style={{ width: `${(c.cents / maxCat) * 100}%` }} />
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {data.expenses.length === 0 ? (
            <EmptyState
              icon={Receipt}
              title="No expenses here yet"
              description="Snap a receipt when you buy materials, fuel or tools. Expenses on a job show up in that job's profit."
              action={{ label: "Add expense", onClick: () => setEditing("new") }}
            />
          ) : (
            <div className="rounded-xl border border-border bg-card overflow-hidden">
              <ul className="divide-y divide-border">
                {data.expenses.map((e) => (
                  <li key={e.id}>
                    <button type="button" onClick={() => setEditing(e)} className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-secondary/40">
                      <div className="w-12 shrink-0 text-center">
                        <p className="text-xs font-semibold text-foreground">{shortDate(e.spentOn)}</p>
                        <p className="text-[10px] text-muted-foreground">{e.spentOn.slice(0, 4)}</p>
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-foreground truncate flex items-center gap-1.5">
                          <span className="truncate">{e.vendor || e.description || categoryLabel(e.category)}</span>
                          {e.receiptType && <FileText className="w-3 h-3 text-muted-foreground shrink-0" aria-label="Has receipt" />}
                        </p>
                        <p className="text-xs text-muted-foreground truncate">
                          {categoryLabel(e.category)}
                          {e.vendor && e.description ? ` · ${e.description}` : ""}
                          {e.jobTitle ? ` · ${e.jobTitle}` : ""}
                          {manager && e.personName ? ` · ${e.personName}` : ""}
                        </p>
                        <div className="flex flex-wrap gap-1 mt-1 empty:hidden">
                          <Badges e={e} />
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-sm font-semibold tabular-nums text-foreground">{formatCents(e.amountCents)}</p>
                        {e.taxCents > 0 && <p className="text-[11px] text-muted-foreground tabular-nums">tax {formatCents(e.taxCents)}</p>}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
              {data.truncated && <p className="px-4 py-2 text-xs text-muted-foreground border-t border-border">Showing the first 5,000 — narrow the dates to see the rest.</p>}
            </div>
          )}
        </>
      )}

      {editing && <ExpenseDialog orgId={organizationId} expense={editing === "new" ? null : editing} manager={manager} onClose={() => setEditing(null)} />}
    </div>
  );
}
