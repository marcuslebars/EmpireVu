/**
 * Invoices — staff list with summary, filters, detail sheet and editor.
 * Deep links: /invoices?open={invoiceId} opens that invoice; /invoices?new=1 opens the editor.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AlertTriangle, Clock, FileText, Plus, Wallet } from "lucide-react";

import { InvoiceDetailSheet } from "@/components/invoices/InvoiceDetailSheet";
import { InvoiceEditorDialog } from "@/components/invoices/InvoiceEditorDialog";
import { InvoiceStatusBadge } from "@/components/invoices/InvoiceStatusBadge";
import { EmptyState, ErrorBanner, SkeletonRow, SkeletonStatCard } from "@/components/ui/StateViews";
import { useCompanies } from "@/lib/api-hooks";
import { useInvoices } from "@/lib/invoice-hooks";
import { formatCents, formatYmd, type Invoice, type InvoiceFilter } from "@/lib/invoices-api";
import { useOrgId } from "@/lib/org-context";
import { cn } from "@/lib/utils";

const FILTERS: Array<{ value: InvoiceFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "draft", label: "Drafts" },
  { value: "open", label: "Open" },
  { value: "overdue", label: "Overdue" },
  { value: "paid", label: "Paid" },
  { value: "void", label: "Void" },
];

const EMPTY_COPY: Record<InvoiceFilter, { title: string; description: string }> = {
  all: { title: "No invoices yet", description: "Create one here, or turn an approved quote or a booking into an invoice." },
  draft: { title: "No drafts", description: "Drafts you start but haven't sent show up here." },
  open: { title: "Nothing outstanding", description: "Every sent invoice has been paid or voided." },
  overdue: { title: "Nothing overdue", description: "No open invoice is past its due date." },
  paid: { title: "No paid invoices yet", description: "Invoices paid in full show up here." },
  void: { title: "No void invoices", description: "Voided invoices are kept here for your records." },
};

function SummaryCard({
  label,
  value,
  sub,
  icon: Icon,
  tone,
  onClick,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: React.ElementType;
  tone?: "urgent" | "warning";
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "text-left bg-card border rounded-xl p-4 sm:p-5 transition-all duration-200 shadow-md shadow-black/10 hover:shadow-lg hover:shadow-black/15",
        tone === "urgent" ? "border-destructive/20" : "border-border",
        onClick && "hover:border-primary/40",
      )}
    >
      <div className="flex items-center justify-between mb-2 sm:mb-3">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{label}</p>
        <span
          className={cn(
            "flex items-center justify-center w-7 h-7 rounded-md",
            tone === "urgent"
              ? "bg-destructive/10 text-destructive"
              : tone === "warning"
                ? "bg-[hsl(var(--warning))]/10 text-[hsl(var(--warning))]"
                : "bg-secondary text-muted-foreground",
          )}
        >
          <Icon className="w-3.5 h-3.5" />
        </span>
      </div>
      <p className={cn("text-xl sm:text-2xl font-bold tracking-tight tabular-nums", tone === "urgent" ? "text-destructive" : "text-foreground")}>{value}</p>
      {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
    </button>
  );
}

function DueCell({ invoice }: { invoice: Invoice }) {
  if (!invoice.due_date || invoice.status === "void") return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <span className={cn("text-xs whitespace-nowrap", invoice.overdue ? "text-destructive font-semibold" : "text-foreground/80")}>
      {formatYmd(invoice.due_date)}
      {invoice.overdue && <span className="ml-1.5 text-[10px] font-bold uppercase tracking-wider">Overdue</span>}
    </span>
  );
}

export default function InvoicesPage() {
  const orgId = useOrgId();
  const [searchParams, setSearchParams] = useSearchParams();
  const [filter, setFilter] = useState<InvoiceFilter>("all");
  const [companyFilter, setCompanyFilter] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [sendOnOpen, setSendOnOpen] = useState(false);

  const { data: companies } = useCompanies(orgId);
  const opts = useMemo(() => ({ filter, companyId: companyFilter || undefined }), [filter, companyFilter]);
  const { data, isLoading, isError, error, refetch } = useInvoices(orgId, opts);
  const invoices = data?.invoices ?? [];
  const summary = data?.summary;

  // Deep links: ?open={id} and ?new=1
  useEffect(() => {
    const openId = searchParams.get("open");
    const isNew = searchParams.get("new");
    if (!openId && !isNew) return;
    if (openId) setSelectedId(openId);
    if (isNew) setIsCreateOpen(true);
    const next = new URLSearchParams(searchParams);
    next.delete("open");
    next.delete("new");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const closeSheet = useCallback(() => {
    setSelectedId(null);
    setSendOnOpen(false);
  }, []);
  const consumeSendOnOpen = useCallback(() => setSendOnOpen(false), []);

  const currency = invoices[0]?.currency ?? "CAD";
  const empty = EMPTY_COPY[filter];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Invoices</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Bill customers, take payments and chase what's owing</p>
        </div>
        <button
          onClick={() => setIsCreateOpen(true)}
          className="self-start sm:self-auto flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold bg-[hsl(var(--accent-blue))] text-white hover:bg-[hsl(var(--accent-blue))]/90 transition-all shadow-md shadow-blue-500/20 active:scale-[0.97]"
        >
          <Plus className="w-4 h-4" />
          New invoice
        </button>
      </div>

      {/* Summary */}
      <div className={cn("grid gap-3 sm:gap-4 grid-cols-2", summary && summary.clearingCents > 0 ? "lg:grid-cols-3" : "lg:grid-cols-2 lg:max-w-2xl")}>
        {!summary ? (
          <>
            <SkeletonStatCard />
            <SkeletonStatCard />
          </>
        ) : (
          <>
            <SummaryCard
              label="Outstanding"
              value={formatCents(summary.outstandingCents, currency)}
              sub="Across all open invoices"
              icon={Wallet}
              onClick={() => setFilter("open")}
            />
            <SummaryCard
              label="Overdue"
              value={formatCents(summary.overdueCents, currency)}
              sub={summary.overdueCount === 0 ? "Nothing past due" : `${summary.overdueCount} invoice${summary.overdueCount === 1 ? "" : "s"} past due`}
              icon={AlertTriangle}
              tone={summary.overdueCount > 0 ? "urgent" : undefined}
              onClick={() => setFilter("overdue")}
            />
            {summary.clearingCents > 0 && (
              <SummaryCard
                label="Clearing"
                value={formatCents(summary.clearingCents, currency)}
                sub="Bank debits in progress"
                icon={Clock}
                tone="warning"
              />
            )}
          </>
        )}
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex items-center gap-1 bg-secondary rounded-lg p-0.5 overflow-x-auto max-w-full">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              className={cn(
                "px-3 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap",
                filter === f.value ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {f.label}
              {f.value === "overdue" && summary && summary.overdueCount > 0 && (
                <span className="ml-1.5 text-[10px] font-bold bg-destructive/15 text-destructive rounded-full px-1.5">{summary.overdueCount}</span>
              )}
            </button>
          ))}
        </div>
        {companies && companies.length > 1 && (
          <select
            value={companyFilter}
            onChange={(e) => setCompanyFilter(e.target.value)}
            className="sm:ml-auto px-3 py-2 text-xs bg-card border border-border rounded-xl text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 cursor-pointer"
            aria-label="Filter by company"
          >
            <option value="">All companies</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* List */}
      {isError ? (
        <ErrorBanner message={error instanceof Error ? error.message : "Failed to load invoices."} onRetry={() => void refetch()} />
      ) : isLoading ? (
        <div className="bg-card border border-border rounded-2xl divide-y divide-border">
          {Array.from({ length: 5 }).map((_, i) => (
            <SkeletonRow key={i} cols={6} />
          ))}
        </div>
      ) : invoices.length === 0 ? (
        <div className="bg-card border border-border rounded-2xl">
          <EmptyState
            icon={FileText}
            title={empty.title}
            description={empty.description}
            action={filter === "all" || filter === "draft" ? { label: "New invoice", onClick: () => setIsCreateOpen(true) } : undefined}
          />
        </div>
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden md:block bg-card border border-border rounded-2xl overflow-hidden shadow-sm">
            <div className="overflow-x-auto custom-scrollbar">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-secondary/30 border-b border-border">
                    {["Number", "Customer", "Issued", "Due", "Total", "Balance", "Status"].map((h) => (
                      <th
                        key={h}
                        className={cn(
                          "px-4 py-3 text-[10px] font-bold text-muted-foreground uppercase tracking-wider",
                          (h === "Total" || h === "Balance") && "text-right",
                        )}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {invoices.map((inv) => (
                    <tr
                      key={inv.id}
                      onClick={() => setSelectedId(inv.id)}
                      className={cn("hover:bg-secondary/40 transition-colors cursor-pointer", selectedId === inv.id && "bg-secondary/60")}
                    >
                      <td className="px-4 py-3">
                        <p className={cn("text-sm font-semibold", inv.invoice_number ? "text-foreground" : "text-muted-foreground italic")}>
                          {inv.invoice_number ?? "Draft"}
                        </p>
                        {inv.title && <p className="text-[11px] text-muted-foreground truncate max-w-[14rem]">{inv.title}</p>}
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-sm text-foreground/90 truncate block max-w-[16rem]">{inv.bill_to_name ?? inv.bill_to.name}</span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-xs text-foreground/80 whitespace-nowrap">{inv.issue_date ? formatYmd(inv.issue_date) : "—"}</span>
                      </td>
                      <td className="px-4 py-3">
                        <DueCell invoice={inv} />
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span className="text-sm text-foreground tabular-nums">{formatCents(inv.total_cents, inv.currency)}</span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span
                          className={cn(
                            "text-sm font-semibold tabular-nums",
                            inv.status === "void" || inv.balance_due_cents === 0 ? "text-muted-foreground" : inv.overdue ? "text-destructive" : "text-foreground",
                          )}
                        >
                          {inv.status === "void" ? "—" : formatCents(inv.balance_due_cents, inv.currency)}
                        </span>
                        {inv.pending_payment_cents > 0 && (
                          <p className="text-[10px] text-[hsl(var(--warning))]">{formatCents(inv.pending_payment_cents, inv.currency)} clearing</p>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <InvoiceStatusBadge status={inv.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Mobile cards */}
          <div className="md:hidden space-y-2">
            {invoices.map((inv) => (
              <button
                key={inv.id}
                type="button"
                onClick={() => setSelectedId(inv.id)}
                className={cn(
                  "w-full text-left bg-card border rounded-xl p-3.5 shadow-sm transition-colors active:bg-secondary/40",
                  inv.overdue ? "border-destructive/30" : "border-border",
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-foreground truncate">{inv.bill_to_name ?? inv.bill_to.name}</p>
                    <p className="text-[11px] text-muted-foreground truncate">
                      {inv.invoice_number ?? "Draft"}
                      {inv.title ? ` · ${inv.title}` : ""}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className={cn("text-sm font-bold tabular-nums", inv.overdue ? "text-destructive" : "text-foreground")}>
                      {formatCents(inv.status === "paid" || inv.status === "void" || inv.status === "draft" ? inv.total_cents : inv.balance_due_cents, inv.currency)}
                    </p>
                    {inv.status !== "draft" && inv.status !== "paid" && inv.status !== "void" && inv.balance_due_cents !== inv.total_cents && (
                      <p className="text-[10px] text-muted-foreground tabular-nums">of {formatCents(inv.total_cents, inv.currency)}</p>
                    )}
                  </div>
                </div>
                <div className="flex items-center justify-between gap-2 mt-2.5">
                  <InvoiceStatusBadge status={inv.status} />
                  <DueCell invoice={inv} />
                </div>
              </button>
            ))}
          </div>
        </>
      )}

      <InvoiceDetailSheet invoiceId={selectedId} onClose={closeSheet} openSendOnLoad={sendOnOpen} onSendOpened={consumeSendOnOpen} />

      {isCreateOpen && (
        <InvoiceEditorDialog
          onClose={() => setIsCreateOpen(false)}
          onSaved={(saved, { send }) => {
            setIsCreateOpen(false);
            setSendOnOpen(send);
            setSelectedId(saved.id);
          }}
        />
      )}
    </div>
  );
}
