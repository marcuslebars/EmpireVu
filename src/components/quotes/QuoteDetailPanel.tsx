/**
 * Quote detail slide-over: right-hand panel on desktop, bottom sheet on mobile.
 * Same custom-portal approach as InvoiceDetailSheet (not a Radix Sheet) so the app's
 * Modal dialogs stay clickable on top of it.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, ArrowUpRight, Ban, Copy, ExternalLink, FileText, Loader2, Pencil, Receipt, RefreshCw, Send, X } from "lucide-react";

import { actionBtnCls, errorMessage, sectionLabelCls } from "@/components/invoices/invoice-ui";
import { ErrorState, LoadingCards } from "@/components/ui/StateViews";
import { toast } from "@/components/ui/sonner";
import { sendQuote, voidQuote, type QuoteSummary } from "@/lib/api-client";
import { useContactDetail } from "@/lib/api-hooks";
import { formatDate } from "@/lib/format";
import { useCreateInvoiceFromQuote } from "@/lib/invoice-hooks";
import { existingInvoiceIdFrom, formatCents } from "@/lib/invoices-api";
import { useInvalidateQuotes, useQuoteDetail, useQuoteList } from "@/lib/quote-hooks";
import { reissueQuote, type QuoteListItem } from "@/lib/quotes-api";
import { useOrgId } from "@/lib/org-context";
import { cn } from "@/lib/utils";

import { QuoteConfirmDialog } from "./QuoteConfirmDialog";
import { QuoteLinesTable } from "./QuotePricingPanel";
import { QuoteStatusBadge } from "./QuoteStatusBadge";
import { REISSUABLE_STATUSES, VOIDABLE_STATUSES, asQuoteStatus, parseLineItems, toastQuoteSent } from "./quote-ui";

/** The single-quote route returns the raw row (select *), which has more than QuoteSummary declares. */
type RawQuote = QuoteSummary & {
  contact_id: string | null;
  company_id: string | null;
  tax_rate_bps?: number;
  first_viewed_at?: string | null;
  approved_at?: string | null;
  deposit_paid_at?: string | null;
  superseded_by?: string | null;
  supersedes?: string | null;
  cancel_reason?: string | null;
  cancelled_at?: string | null;
};

const fmt = (iso: string | null | undefined) => (iso ? formatDate(iso, "MMM d, yyyy") : null);

const primaryActionCls =
  "w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-bold bg-[hsl(var(--accent-blue))] text-white hover:bg-[hsl(var(--accent-blue))]/90 transition-colors disabled:opacity-50";

type Confirm = "void" | "revise" | null;

export function QuoteDetailPanel({
  quoteId,
  onClose,
  onEdit,
  onOpenQuote,
}: {
  quoteId: string | null;
  onClose: () => void;
  /** Open the builder on a quote (also used for a revised successor). */
  onEdit: (quoteId: string, contactName: string | null) => void;
  onOpenQuote: (quoteId: string) => void;
}) {
  const orgId = useOrgId();
  const navigate = useNavigate();
  const invalidate = useInvalidateQuotes();
  const { data: raw, isLoading, isError, error, refetch } = useQuoteDetail(orgId, quoteId);
  // The list row carries the enrichment the single-quote route doesn't (link, contact, invoice).
  const { data: list } = useQuoteList(orgId, false);
  const row: QuoteListItem | undefined = list?.find((q) => q.id === quoteId);
  const quote = raw as RawQuote | undefined;
  const { data: contactDetail } = useContactDetail(orgId, !row && quote?.contact_id ? quote.contact_id : null);
  const convertToInvoice = useCreateInvoiceFromQuote(orgId);

  const [confirm, setConfirm] = useState<Confirm>(null);
  const [busy, setBusy] = useState<"send" | "void" | "revise" | "invoice" | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const open = Boolean(quoteId);

  useEffect(() => {
    setConfirm(null);
    setConfirmError(null);
  }, [quoteId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && confirm === null) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, confirm, onClose]);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  if (typeof document === "undefined") return null;

  const contactName = row?.contact_name ?? contactDetail?.contact.name ?? null;
  const contactEmail = row?.contact_email ?? contactDetail?.contact.email ?? null;
  const publicUrl = row?.public_url ?? (quote ? `${window.location.origin}/q/${quote.public_token}` : "");
  const invoiceId = row?.invoice_id ?? null;

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(publicUrl);
      toast.success("Customer link copied");
    } catch {
      toast.error(`Couldn't copy — the link is ${publicUrl}`);
    }
  };

  async function send() {
    if (!quote) return;
    setBusy("send");
    try {
      const { quote: sent, email } = await sendQuote(orgId, quote.id);
      toastQuoteSent(sent.quote_number, email, contactEmail);
      void invalidate();
    } catch (err) {
      toast.error(errorMessage(err, "Couldn't send the quote."));
    } finally {
      setBusy(null);
    }
  }

  async function createInvoice() {
    if (!quote) return;
    setBusy("invoice");
    try {
      const invoice = await convertToInvoice.mutateAsync(quote.id);
      toast.success("Draft invoice created");
      void invalidate();
      navigate(`/invoices?open=${invoice.id}`);
    } catch (err) {
      const existingId = existingInvoiceIdFrom(err);
      if (existingId) {
        toast.info("Already invoiced — opening it");
        navigate(`/invoices?open=${existingId}`);
      } else {
        toast.error(errorMessage(err, "Couldn't create the invoice."));
      }
    } finally {
      setBusy(null);
    }
  }

  async function doVoid() {
    if (!quote) return;
    setBusy("void");
    setConfirmError(null);
    try {
      await voidQuote(orgId, quote.id);
      toast.success(`${quote.quote_number ?? "Draft quote"} voided`);
      setConfirm(null);
      void invalidate();
    } catch (err) {
      setConfirmError(errorMessage(err, "Couldn't void the quote."));
    } finally {
      setBusy(null);
    }
  }

  async function doRevise(reason: string | undefined) {
    if (!quote) return;
    setBusy("revise");
    setConfirmError(null);
    try {
      const { successor } = await reissueQuote(orgId, quote.id, reason);
      toast.success("Revised draft created — the old link now says it was replaced");
      setConfirm(null);
      void invalidate();
      onEdit(successor.id, contactName);
    } catch (err) {
      setConfirmError(errorMessage(err, "Couldn't revise the quote."));
    } finally {
      setBusy(null);
    }
  }

  const body = (() => {
    if (isLoading) {
      return (
        <div className="p-6 space-y-6">
          <div className="space-y-2">
            <div className="h-4 w-3/4 bg-secondary animate-pulse rounded" />
            <div className="h-3 w-1/2 bg-secondary animate-pulse rounded" />
          </div>
          <LoadingCards count={3} />
        </div>
      );
    }
    if (isError || !quote) {
      return (
        <div className="flex-1 flex flex-col">
          <div className="flex justify-end p-3">
            <button onClick={onClose} className="p-1 hover:bg-secondary rounded-md transition-colors" aria-label="Close">
              <X className="w-4 h-4 text-muted-foreground" />
            </button>
          </div>
          <ErrorState message={errorMessage(error, "Couldn't load this quote.")} onRetry={() => void refetch()} />
        </div>
      );
    }

    const status = asQuoteStatus(quote.status);
    const lines = parseLineItems(quote.line_items);
    const currency = quote.currency || "CAD";
    const isLive = status !== "draft" && status !== "cancelled";
    const canRevise = REISSUABLE_STATUSES.includes(status) && status !== "draft";
    // Drafts get a Void button in their main row; everything else gets the small link.
    const showVoidLink = VOIDABLE_STATUSES.includes(status) && status !== "draft";
    const dates: Array<{ label: string; value: string | null }> = [
      { label: "Created", value: fmt(quote.created_at) },
      { label: "Sent", value: fmt(quote.sent_at) },
      { label: "First viewed", value: fmt(quote.first_viewed_at) },
      { label: "Approved", value: fmt(quote.approved_at) },
      { label: "Deposit paid", value: fmt(quote.deposit_paid_at) },
      { label: "Valid until", value: status === "sent" || status === "viewed" ? fmt(quote.valid_until) : null },
    ].filter((d) => d.value);

    const invoiceButton = invoiceId ? (
      <button type="button" onClick={() => navigate(`/invoices?open=${invoiceId}`)} className={primaryActionCls}>
        <Receipt className="w-3.5 h-3.5" /> View invoice
      </button>
    ) : (
      <button type="button" onClick={() => void createInvoice()} disabled={busy !== null} className={primaryActionCls}>
        {busy === "invoice" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Receipt className="w-3.5 h-3.5" />} Create invoice
      </button>
    );

    return (
      <div className="flex-1 flex flex-col min-h-0">
        {/* Header */}
        <div className="p-5 border-b border-border bg-secondary/10 shrink-0">
          <div className="flex items-start justify-between gap-2 mb-2">
            <div className="min-w-0">
              <h3 className="text-base font-bold text-foreground leading-tight truncate">{quote.title || "Untitled quote"}</h3>
              <p className="text-xs text-muted-foreground mt-0.5 truncate">{quote.quote_number ?? "Draft — numbered when sent"}</p>
            </div>
            <button onClick={onClose} className="p-1 hover:bg-secondary rounded-md transition-colors shrink-0" aria-label="Close">
              <X className="w-4 h-4 text-muted-foreground" />
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <QuoteStatusBadge status={status} />
            {quote.auto_generated && (
              <span className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border border-[hsl(var(--warning))]/20 bg-[hsl(var(--warning))]/10 text-[hsl(var(--warning))]">
                Auto-quote
              </span>
            )}
            {invoiceId && (
              <button
                type="button"
                onClick={() => navigate(`/invoices?open=${invoiceId}`)}
                className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border border-border bg-background text-muted-foreground hover:text-foreground"
              >
                <FileText className="w-3 h-3" /> Invoiced
              </button>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-6 custom-scrollbar">
          {/* Amount hero */}
          <div className="rounded-xl border border-border bg-secondary/20 p-4 grid grid-cols-2 gap-3">
            <div>
              <p className={sectionLabelCls}>Total</p>
              <p className="text-2xl font-bold tracking-tight mt-1 tabular-nums text-foreground">{formatCents(quote.total_cents, currency)}</p>
            </div>
            <div>
              <p className={sectionLabelCls}>Deposit</p>
              <p className="text-2xl font-bold tracking-tight mt-1 tabular-nums text-foreground/80">{formatCents(quote.deposit_cents, currency)}</p>
            </div>
          </div>

          {status === "cancelled" && (
            <div className="flex items-start gap-2 rounded-xl border border-border bg-secondary/30 p-3">
              <AlertTriangle className="w-3.5 h-3.5 text-muted-foreground mt-0.5 shrink-0" />
              <div className="text-[11px] text-muted-foreground space-y-1">
                <p>
                  Voided{quote.cancelled_at ? ` ${fmt(quote.cancelled_at)}` : ""}
                  {quote.cancel_reason ? ` — ${quote.cancel_reason}` : ""}.
                </p>
                {quote.superseded_by && (
                  <button type="button" onClick={() => onOpenQuote(quote.superseded_by as string)} className="text-primary hover:underline font-medium">
                    Open the revised quote
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Customer + dates */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1 col-span-2 sm:col-span-1">
              <p className={sectionLabelCls}>Customer</p>
              <p className="text-sm font-medium text-foreground">{contactName ?? "—"}</p>
              {contactEmail && <p className="text-xs text-muted-foreground break-all">{contactEmail}</p>}
              {quote.contact_id && (
                <button
                  type="button"
                  onClick={() => navigate(`/crm/${quote.contact_id}`)}
                  className="flex items-center gap-1 text-[11px] text-primary hover:underline pt-0.5"
                >
                  Open contact <ArrowUpRight className="w-3 h-3" />
                </button>
              )}
            </div>
            <div className="space-y-2 col-span-2 sm:col-span-1">
              {dates.map((d) => (
                <div key={d.label}>
                  <p className={sectionLabelCls}>{d.label}</p>
                  <p className="text-xs font-medium text-foreground">{d.value}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Customer link */}
          {isLive && (
            <div className="space-y-1.5">
              <p className={sectionLabelCls}>Customer link</p>
              <div className="flex items-center gap-2 rounded-lg border border-border bg-secondary/30 px-3 py-2">
                <span className="text-xs text-foreground/80 truncate flex-1" title={publicUrl}>
                  {publicUrl}
                </span>
                <button type="button" onClick={() => void copyLink()} className="p-1 rounded hover:bg-background text-muted-foreground" aria-label="Copy customer link">
                  <Copy className="w-3.5 h-3.5" />
                </button>
                <a href={publicUrl} target="_blank" rel="noreferrer" className="p-1 rounded hover:bg-background text-muted-foreground" aria-label="Open customer link">
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
              </div>
            </div>
          )}

          {/* Lines */}
          <div className="space-y-2">
            <p className={sectionLabelCls}>Line items</p>
            <QuoteLinesTable
              lines={lines}
              currency={currency}
              totals={{
                subtotalCents: quote.subtotal_cents,
                taxCents: quote.tax_cents,
                taxRateBps: typeof quote.tax_rate_bps === "number" ? quote.tax_rate_bps : null,
                totalCents: quote.total_cents,
                depositCents: quote.deposit_cents,
              }}
            />
          </div>

          {quote.intro_message && (
            <div className="space-y-1.5">
              <p className={sectionLabelCls}>Intro message</p>
              <p className="text-xs text-foreground/80 whitespace-pre-wrap bg-secondary/30 rounded-xl p-3 border border-border/50">{quote.intro_message}</p>
            </div>
          )}
          {quote.notes && (
            <div className="space-y-1.5">
              <p className={sectionLabelCls}>Internal notes</p>
              <p className="text-xs text-foreground/80 whitespace-pre-wrap bg-[hsl(var(--warning))]/5 rounded-xl p-3 border border-[hsl(var(--warning))]/20">{quote.notes}</p>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="p-4 border-t border-border bg-secondary/20 shrink-0 space-y-2">
          {status === "draft" && (
            <>
              <button type="button" onClick={() => void send()} disabled={busy !== null} className={primaryActionCls}>
                {busy === "send" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />} Send quote
              </button>
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => onEdit(quote.id, contactName)} className={actionBtnCls}>
                  <Pencil className="w-3.5 h-3.5" /> Edit
                </button>
                <button type="button" onClick={() => setConfirm("void")} className={cn(actionBtnCls, "hover:text-destructive")}>
                  <Ban className="w-3.5 h-3.5" /> Void
                </button>
              </div>
            </>
          )}

          {(status === "sent" || status === "viewed") && (
            <div className="grid grid-cols-2 gap-2">
              <button type="button" onClick={() => onEdit(quote.id, contactName)} className={actionBtnCls}>
                <Pencil className="w-3.5 h-3.5" /> Edit
              </button>
              <button type="button" onClick={() => void copyLink()} className={actionBtnCls}>
                <Copy className="w-3.5 h-3.5" /> Copy link
              </button>
            </div>
          )}

          {(status === "approved" || status === "deposit_paid" || status === "completed") && invoiceButton}

          {(status === "deposit_paid" || status === "completed") && (
            <button type="button" onClick={() => void copyLink()} className={cn(actionBtnCls, "w-full")}>
              <Copy className="w-3.5 h-3.5" /> Copy customer link
            </button>
          )}

          {(canRevise || showVoidLink) && (
            <div className="flex flex-wrap justify-center gap-x-4 gap-y-1 pt-1">
              {canRevise && (
                <button
                  type="button"
                  onClick={() => setConfirm("revise")}
                  className="text-[11px] font-medium text-muted-foreground hover:text-foreground flex items-center gap-1"
                >
                  <RefreshCw className="w-3 h-3" /> {status === "approved" || status === "expired" ? "Revise" : "Revise & resend"}
                </button>
              )}
              {status === "approved" && (
                <button type="button" onClick={() => void copyLink()} className="text-[11px] font-medium text-muted-foreground hover:text-foreground flex items-center gap-1">
                  <Copy className="w-3 h-3" /> Copy link
                </button>
              )}
              {(status === "sent" || status === "viewed") && !invoiceId && (
                <button
                  type="button"
                  onClick={() => void createInvoice()}
                  disabled={busy !== null}
                  className="text-[11px] font-medium text-muted-foreground hover:text-foreground flex items-center gap-1 disabled:opacity-50"
                >
                  <Receipt className="w-3 h-3" /> Create invoice
                </button>
              )}
              {showVoidLink && (
                <button
                  type="button"
                  onClick={() => setConfirm("void")}
                  className="text-[11px] font-medium text-muted-foreground hover:text-destructive flex items-center gap-1"
                >
                  <Ban className="w-3 h-3" /> Void
                </button>
              )}
            </div>
          )}

          {status === "cancelled" && <p className="text-[11px] text-muted-foreground text-center">This quote is void. Create a new quote to price the job again.</p>}
        </div>
      </div>
    );
  })();

  return (
    <>
      {createPortal(
        <div
          className={cn("fixed inset-0 z-40 transition-opacity duration-200", open ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none")}
          aria-hidden={!open}
        >
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Quote details"
            className={cn(
              "absolute flex flex-col bg-card border-border shadow-2xl shadow-black/60 transition-transform duration-300 ease-out",
              "inset-x-0 bottom-0 max-h-[92vh] rounded-t-2xl border-t",
              "md:inset-y-0 md:left-auto md:right-0 md:h-full md:max-h-none md:w-[30rem] md:rounded-none md:rounded-l-2xl md:border-t-0 md:border-l",
              open ? "translate-y-0 md:translate-x-0" : "translate-y-full md:translate-y-0 md:translate-x-full",
            )}
          >
            <div className="md:hidden mx-auto mt-2 mb-1 h-1 w-10 rounded-full bg-border shrink-0" />
            {open && body}
          </div>
        </div>,
        document.body,
      )}

      {quote && confirm === "void" && (
        <QuoteConfirmDialog
          title={`Void ${quote.quote_number ?? "this draft"}?`}
          description={
            quote.status === "draft"
              ? "The draft is kept for your records but can't be sent."
              : "The customer's link stops accepting approval and payment. This can't be undone."
          }
          confirmLabel="Void quote"
          destructive
          pending={busy === "void"}
          error={confirmError}
          onConfirm={() => void doVoid()}
          onClose={() => {
            setConfirm(null);
            setConfirmError(null);
          }}
        />
      )}
      {quote && confirm === "revise" && (
        <QuoteConfirmDialog
          title={`Revise ${quote.quote_number ?? "this quote"}?`}
          description="This voids the current quote and opens a new draft copy for you to change and send. The customer's old link will say it was replaced, and they're emailed that their quote was updated."
          confirmLabel="Revise quote"
          askReason
          reasonLabel="Note for the customer (optional — included in their email)"
          reasonPlaceholder="e.g., Added bottom paint as you asked."
          pending={busy === "revise"}
          error={confirmError}
          onConfirm={(reason) => void doRevise(reason)}
          onClose={() => {
            setConfirm(null);
            setConfirmError(null);
          }}
        />
      )}
    </>
  );
}
