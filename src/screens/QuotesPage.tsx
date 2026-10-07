/**
 * Quotes — staff list, detail panel and point-and-click builder.
 * Deep links: /quotes?open={quoteId} opens that quote; /quotes?new=1 opens the builder.
 *
 * The whole feature 404s while STRIPE_QUOTES_ENABLED is off, which renders as a
 * plain "not enabled" notice rather than an error.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { FileText, Plus, Receipt, Sparkles } from "lucide-react";

import { QuoteBuilderDialog } from "@/components/quotes/QuoteBuilderDialog";
import { QuoteDetailPanel } from "@/components/quotes/QuoteDetailPanel";
import { QuoteStatusBadge } from "@/components/quotes/QuoteStatusBadge";
import { QUOTE_FILTERS, asQuoteStatus, type QuoteFilter } from "@/components/quotes/quote-ui";
import { EmptyState, ErrorBanner, SkeletonRow } from "@/components/ui/StateViews";
import { ApiError } from "@/lib/api-client";
import { formatDate } from "@/lib/format";
import { formatCents } from "@/lib/invoices-api";
import { useQuoteList } from "@/lib/quote-hooks";
import type { QuoteListItem } from "@/lib/quotes-api";
import { useOrgId } from "@/lib/org-context";
import { cn } from "@/lib/utils";

const EMPTY_COPY: Record<QuoteFilter, { title: string; description: string }> = {
  all: { title: "No quotes yet", description: "Build one from your price list and send the customer a link to approve and pay a deposit." },
  draft: { title: "No drafts", description: "Quotes you start but haven't sent show up here." },
  with_customer: { title: "Nothing waiting on customers", description: "Sent quotes the customer hasn't approved yet show up here." },
  approved: { title: "No approved quotes", description: "Quotes the customer approved but hasn't paid a deposit on show up here." },
  deposit_paid: { title: "No deposits yet", description: "Quotes with a paid deposit show up here, ready to schedule and invoice." },
  completed: { title: "Nothing completed", description: "Finished jobs show up here." },
  closed: { title: "Nothing closed", description: "Expired and voided quotes are kept here for your records." },
};

type BuilderState = { quoteId: string | null; contactName: string | null; returnTo: string | null } | null;

function DateCell({ q }: { q: QuoteListItem }) {
  const iso = q.sent_at ?? q.created_at;
  return (
    <span className="text-xs text-foreground/80 whitespace-nowrap">
      {formatDate(iso, "MMM d, yyyy")}
      <span className="block text-[10px] text-muted-foreground">{q.sent_at ? "Sent" : "Created"}</span>
    </span>
  );
}

function InvoicedChip({ q, onOpen }: { q: QuoteListItem; onOpen: (id: string) => void }) {
  if (!q.invoice_id) return null;
  const id = q.invoice_id;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onOpen(id);
      }}
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border border-border bg-background text-muted-foreground hover:text-foreground"
      aria-label={`Open invoice for ${q.quote_number ?? "this quote"}`}
    >
      <Receipt className="w-3 h-3" /> Invoiced
    </button>
  );
}

export default function QuotesPage() {
  const orgId = useOrgId();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [filter, setFilter] = useState<QuoteFilter>("all");
  /**
   * Review mode = machine-written quotes still out with a customer and unpaid —
   * the only window where a wrong auto-quote can be voided and reissued for free.
   */
  const [review, setReview] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [builder, setBuilder] = useState<BuilderState>(null);

  const { data, isLoading, isError, error, refetch } = useQuoteList(orgId, review);
  const disabled = isError && error instanceof ApiError && error.status === 404;

  // Deep links: ?open={id} and ?new=1
  useEffect(() => {
    const openId = searchParams.get("open");
    const isNew = searchParams.get("new");
    if (!openId && !isNew) return;
    if (openId) setSelectedId(openId);
    if (isNew) setBuilder({ quoteId: null, contactName: null, returnTo: null });
    const next = new URLSearchParams(searchParams);
    next.delete("open");
    next.delete("new");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const counts = useMemo(() => {
    const c = new Map<QuoteFilter, number>();
    for (const f of QUOTE_FILTERS) c.set(f.value, f.statuses ? (data ?? []).filter((q) => f.statuses?.includes(asQuoteStatus(q.status))).length : (data ?? []).length);
    return c;
  }, [data]);

  const quotes = useMemo(() => {
    const all = data ?? [];
    if (review) return all;
    const statuses = QUOTE_FILTERS.find((f) => f.value === filter)?.statuses;
    return statuses ? all.filter((q) => statuses.includes(asQuoteStatus(q.status))) : all;
  }, [data, filter, review]);

  const closePanel = useCallback(() => setSelectedId(null), []);
  const openInvoice = useCallback((id: string) => navigate(`/invoices?open=${id}`), [navigate]);
  const openNew = () => setBuilder({ quoteId: null, contactName: null, returnTo: null });

  const editFromPanel = useCallback(
    (quoteId: string, contactName: string | null) => {
      setBuilder({ quoteId, contactName, returnTo: quoteId });
      setSelectedId(null);
    },
    [],
  );

  if (disabled) {
    return (
      <div className="space-y-2">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Quotes</h1>
        <div className="bg-card border border-border rounded-2xl">
          <EmptyState
            icon={FileText}
            title="Quotes aren't enabled"
            description="Quotes are not enabled for this organization yet. Set STRIPE_QUOTES_ENABLED=1 to turn them on."
          />
        </div>
      </div>
    );
  }

  const empty = review
    ? { title: "Nothing to review", description: "Every auto-quote has been approved, paid or voided." }
    : EMPTY_COPY[filter];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Quotes</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Price jobs from your price list and get them approved online</p>
        </div>
        <button
          onClick={openNew}
          className="self-start sm:self-auto flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold bg-[hsl(var(--accent-blue))] text-white hover:bg-[hsl(var(--accent-blue))]/90 transition-all shadow-md shadow-blue-500/20 active:scale-[0.97]"
        >
          <Plus className="w-4 h-4" />
          New quote
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        {!review && (
          <div className="flex items-center gap-1 bg-secondary rounded-lg p-0.5 overflow-x-auto max-w-full" role="tablist" aria-label="Filter quotes">
            {QUOTE_FILTERS.map((f) => (
              <button
                key={f.value}
                role="tab"
                aria-selected={filter === f.value}
                onClick={() => setFilter(f.value)}
                className={cn(
                  "px-3 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap",
                  filter === f.value ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {f.label}
                {data && f.value !== "all" && (counts.get(f.value) ?? 0) > 0 && (
                  <span className="ml-1.5 text-[10px] font-bold text-muted-foreground tabular-nums">{counts.get(f.value)}</span>
                )}
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          onClick={() => setReview((r) => !r)}
          aria-pressed={review}
          className={cn(
            "sm:ml-auto self-start flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium border transition-colors",
            review
              ? "bg-[hsl(var(--warning))]/10 border-[hsl(var(--warning))]/30 text-[hsl(var(--warning))]"
              : "bg-card border-border text-muted-foreground hover:text-foreground",
          )}
        >
          <Sparkles className="w-3.5 h-3.5" />
          Auto-quotes to review
        </button>
      </div>

      {review && (
        <p className="text-xs text-muted-foreground -mt-3">
          Machine-written quotes that are sent or viewed but not yet paid. Void one or make a new version here and the customer can't pay a wrong price; after they
          approve, the number is one they agreed to.
        </p>
      )}

      {/* List */}
      {isError ? (
        <ErrorBanner message={error instanceof Error ? error.message : "Failed to load quotes."} onRetry={() => void refetch()} />
      ) : isLoading ? (
        <div className="bg-card border border-border rounded-2xl divide-y divide-border">
          {Array.from({ length: 5 }).map((_, i) => (
            <SkeletonRow key={i} cols={6} />
          ))}
        </div>
      ) : quotes.length === 0 ? (
        <div className="bg-card border border-border rounded-2xl">
          <EmptyState
            icon={FileText}
            title={empty.title}
            description={empty.description}
            action={!review && (filter === "all" || filter === "draft") ? { label: "New quote", onClick: openNew } : undefined}
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
                    {["Number", "Customer", "Title", "Total", "Deposit", "Status", "Date"].map((h) => (
                      <th
                        key={h}
                        className={cn(
                          "px-4 py-3 text-[10px] font-bold text-muted-foreground uppercase tracking-wider",
                          (h === "Total" || h === "Deposit") && "text-right",
                        )}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {quotes.map((q) => (
                    <tr
                      key={q.id}
                      onClick={() => setSelectedId(q.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setSelectedId(q.id);
                        }
                      }}
                      tabIndex={0}
                      className={cn(
                        "hover:bg-secondary/40 transition-colors cursor-pointer focus:outline-none focus-visible:bg-secondary/50",
                        selectedId === q.id && "bg-secondary/60",
                      )}
                    >
                      <td className="px-4 py-3">
                        <p className={cn("text-sm font-semibold whitespace-nowrap", q.quote_number ? "text-foreground" : "text-muted-foreground italic")}>
                          {q.quote_number ?? "Draft"}
                        </p>
                        {q.auto_generated && <p className="text-[10px] font-bold uppercase tracking-wider text-[hsl(var(--warning))]">Auto</p>}
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-sm text-foreground/90 truncate block max-w-[14rem]">{q.contact_name || "—"}</span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-sm text-foreground/80 truncate block max-w-[16rem]">{q.title || "Untitled"}</span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span className="text-sm font-semibold text-foreground tabular-nums">{formatCents(q.total_cents, q.currency)}</span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span className="text-sm text-foreground/80 tabular-nums">{formatCents(q.deposit_cents, q.currency)}</span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <QuoteStatusBadge status={q.status} />
                          <InvoicedChip q={q} onOpen={openInvoice} />
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <DateCell q={q} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Mobile cards */}
          <div className="md:hidden space-y-2">
            {quotes.map((q) => (
              <div
                key={q.id}
                role="button"
                tabIndex={0}
                onClick={() => setSelectedId(q.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setSelectedId(q.id);
                  }
                }}
                className="w-full text-left bg-card border border-border rounded-xl p-3.5 shadow-sm transition-colors active:bg-secondary/40 cursor-pointer"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-foreground truncate">{q.contact_name || "No customer"}</p>
                    <p className="text-[11px] text-muted-foreground truncate">
                      {q.quote_number ?? "Draft"}
                      {q.title ? ` · ${q.title}` : ""}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-sm font-bold tabular-nums text-foreground">{formatCents(q.total_cents, q.currency)}</p>
                    <p className="text-[10px] text-muted-foreground tabular-nums">{formatCents(q.deposit_cents, q.currency)} deposit</p>
                  </div>
                </div>
                <div className="flex items-center justify-between gap-2 mt-2.5">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <QuoteStatusBadge status={q.status} />
                    <InvoicedChip q={q} onOpen={openInvoice} />
                  </span>
                  <span className="text-[11px] text-muted-foreground whitespace-nowrap">
                    {q.sent_at ? "Sent " : "Created "}
                    {formatDate(q.sent_at ?? q.created_at, "MMM d")}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <QuoteDetailPanel quoteId={selectedId} onClose={closePanel} onEdit={editFromPanel} onOpenQuote={setSelectedId} />

      {builder && (
        <QuoteBuilderDialog
          quoteId={builder.quoteId}
          contactName={builder.contactName}
          onClose={() => {
            const back = builder.returnTo;
            setBuilder(null);
            if (back) setSelectedId(back);
          }}
          onSaved={(id) => {
            setBuilder(null);
            setSelectedId(id);
          }}
        />
      )}
    </div>
  );
}
