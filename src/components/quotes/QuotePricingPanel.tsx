/**
 * Live totals for the quote builder, straight from the server preview.
 * Also used (with stored line items) by the detail panel via QuoteLinesTable.
 */
import { AlertTriangle, Loader2 } from "lucide-react";

import { sectionLabelCls } from "@/components/invoices/invoice-ui";
import { formatCents } from "@/lib/invoices-api";
import { cn } from "@/lib/utils";

import type { QuoteLine } from "./quote-ui";

export interface QuoteTotals {
  subtotalCents: number;
  taxCents: number;
  taxRateBps: number | null;
  totalCents: number;
  depositCents: number;
  bundleSavingsCents?: number;
}

/** Priced lines + totals. Optional lines the customer hasn't picked are greyed out. */
export function QuoteLinesTable({ lines, totals, currency = "CAD" }: { lines: QuoteLine[]; totals: QuoteTotals; currency?: string }) {
  const taxLabel = totals.taxRateBps !== null ? `HST (${totals.taxRateBps / 100}%)` : "HST";
  return (
    <div className="rounded-xl border border-border/60 divide-y divide-border/60 bg-card">
      {lines.length === 0 && <p className="px-3 py-3 text-xs text-muted-foreground">No line items.</p>}
      {lines.map((l, i) => {
        const excluded = l.optional && !l.selected;
        return (
          <div key={i} className={cn("flex items-start justify-between gap-3 px-3 py-2.5", excluded && "opacity-55")}>
            <div className="min-w-0">
              <p className="text-xs font-medium text-foreground">{l.label}</p>
              {l.description && l.description !== l.label && (
                <p className="text-[11px] text-muted-foreground whitespace-pre-line mt-0.5">{l.description}</p>
              )}
              {l.optional && (
                <p className={cn("text-[10px] font-semibold uppercase tracking-wider mt-0.5", excluded ? "text-muted-foreground" : "text-primary")}>
                  {excluded ? "Optional — not selected" : "Optional — selected"}
                </p>
              )}
            </div>
            <p className={cn("text-xs font-medium tabular-nums shrink-0", excluded ? "text-muted-foreground line-through" : "text-foreground")}>
              {formatCents(l.amountCents, currency)}
            </p>
          </div>
        );
      })}
      <div className="px-3 py-2.5 space-y-1 bg-secondary/20 rounded-b-xl text-xs">
        {totals.bundleSavingsCents !== undefined && totals.bundleSavingsCents > 0 && (
          <div className="flex justify-between text-[hsl(var(--success))]">
            <span>Bundle savings</span>
            <span className="tabular-nums">−{formatCents(totals.bundleSavingsCents, currency)}</span>
          </div>
        )}
        <div className="flex justify-between text-muted-foreground">
          <span>Subtotal</span>
          <span className="tabular-nums">{formatCents(totals.subtotalCents, currency)}</span>
        </div>
        <div className="flex justify-between text-muted-foreground">
          <span>{taxLabel}</span>
          <span className="tabular-nums">{formatCents(totals.taxCents, currency)}</span>
        </div>
        <div className="flex justify-between text-sm font-bold text-foreground border-t border-border pt-1.5">
          <span>Total</span>
          <span className="tabular-nums">{formatCents(totals.totalCents, currency)}</span>
        </div>
        <div className="flex justify-between font-semibold text-foreground">
          <span>Deposit to approve</span>
          <span className="tabular-nums">{formatCents(totals.depositCents, currency)}</span>
        </div>
      </div>
    </div>
  );
}

export function QuotePricingPanel({
  lines,
  totals,
  currency,
  loading,
  error,
  problem,
}: {
  lines: QuoteLine[] | null;
  totals: QuoteTotals | null;
  currency: string;
  loading: boolean;
  /** The server refused to price it (missing choice, needs manual review…). */
  error: string | null;
  /** The form isn't complete enough to ask the server yet. */
  problem: string | null;
}) {
  const stale = Boolean(problem || error);
  return (
    <div className="space-y-3" aria-live="polite">
      <div className="flex items-center justify-between">
        <p className={sectionLabelCls}>Live pricing</p>
        {loading && <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" aria-label="Updating prices" />}
      </div>
      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-[hsl(var(--warning))]/30 bg-[hsl(var(--warning))]/10 px-3 py-2" role="status">
          <AlertTriangle className="w-3.5 h-3.5 text-[hsl(var(--warning))] mt-0.5 shrink-0" />
          <p className="text-xs text-foreground">{error}</p>
        </div>
      )}
      {problem && !error && <p className="text-xs text-muted-foreground">{problem}</p>}
      {lines && totals ? (
        <div className={cn("transition-opacity", stale && "opacity-50")}>
          <QuoteLinesTable lines={lines} totals={totals} currency={currency} />
        </div>
      ) : (
        !problem &&
        !error && <p className="text-xs text-muted-foreground">{loading ? "Pricing…" : "Prices appear here as you build the quote."}</p>
      )}
      <p className="text-[11px] text-muted-foreground">Prices come from this company's price list. The customer sees the same numbers.</p>
    </div>
  );
}
