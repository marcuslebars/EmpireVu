/**
 * Invoice detail slide-over: right-hand panel on desktop, bottom sheet on mobile.
 * Owns the per-invoice dialogs (edit, send, record payment, void) so they stack
 * above it. Rendered in a portal (like Modal) so a filtered ancestor can't become
 * the containing block for `position: fixed`.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  ArrowUpRight,
  Ban,
  CalendarDays,
  Copy,
  CreditCard,
  Download,
  ExternalLink,
  FileText,
  Loader2,
  MessageSquare,
  Pencil,
  Send,
  X,
} from "lucide-react";

import { Modal } from "@/components/ui/Modal";
import { ErrorState, LoadingCards } from "@/components/ui/StateViews";
import { toast } from "@/components/ui/sonner";
import { formatDate, relativeTime } from "@/lib/format";
import { useInvoice, useRemoveInvoicePayment, useSendInvoice, useVoidInvoice } from "@/lib/invoice-hooks";
import {
  PAYMENT_METHOD_LABELS,
  formatCents,
  formatYmd,
  invoicePdfUrl,
  type Invoice,
  type InvoiceEvent,
  type InvoicePayment,
  type PaymentMethod,
} from "@/lib/invoices-api";
import { useOrgId } from "@/lib/org-context";
import { cn } from "@/lib/utils";

import { InvoiceEditorDialog } from "./InvoiceEditorDialog";
import { SyncBadge } from "@/components/accounting/SyncBadge";
import { InvoiceStatusBadge } from "./InvoiceStatusBadge";
import { RecordPaymentDialog } from "./RecordPaymentDialog";
import { SendInvoiceDialog } from "./SendInvoiceDialog";
import { actionBtnCls, errorMessage, inputCls, labelCls, sectionLabelCls, secondaryBtnCls, toastDeliveryOutcomes } from "./invoice-ui";

// ─── Activity labels ─────────────────────────────────────────────────────────

function metaStr(meta: Record<string, unknown> | null, key: string): string | null {
  const v = meta?.[key];
  return typeof v === "string" && v.trim() ? v : null;
}

function metaNum(meta: Record<string, unknown> | null, key: string): number | null {
  const v = meta?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function methodLabel(meta: Record<string, unknown> | null): string | null {
  const m = metaStr(meta, "method");
  return m && m in PAYMENT_METHOD_LABELS ? PAYMENT_METHOD_LABELS[m as PaymentMethod] : m;
}

function describeEvent(e: InvoiceEvent, currency: string): { title: string; detail: string | null; tone?: "bad" | "good" } {
  const m = e.metadata;
  const amount = metaNum(m, "amountCents");
  const money = amount !== null ? formatCents(amount, currency) : null;
  const to = metaStr(m, "to");
  const reason = metaStr(m, "reason");
  const join = (...parts: Array<string | null>) => parts.filter(Boolean).join(" · ") || null;

  switch (e.event_type) {
    case "created":
      return { title: "Invoice created", detail: null };
    case "edited":
      return { title: "Edited", detail: metaNum(m, "toTotalCents") !== null ? `Total now ${formatCents(metaNum(m, "toTotalCents") ?? 0, currency)}` : null };
    case "sent":
      return { title: "Issued and sent", detail: join(metaStr(m, "invoiceNumber"), metaStr(m, "dueDate") ? `due ${formatYmd(metaStr(m, "dueDate"))}` : null) };
    case "resent":
      return { title: "Resent", detail: null };
    case "email_sent":
      return { title: "Invoice emailed", detail: to };
    case "email_skipped":
      return { title: "Email skipped", detail: reason, tone: "bad" };
    case "email_failed":
      return { title: "Email failed", detail: reason, tone: "bad" };
    case "copy_sent":
      return { title: "Your copy emailed", detail: to };
    case "copy_failed":
      return { title: "Your copy didn't send", detail: reason, tone: "bad" };
    case "sms_sent":
      return { title: "Pay link texted", detail: to };
    case "sms_failed":
      return { title: "Text failed", detail: join(to, reason), tone: "bad" };
    case "viewed":
      return { title: "Viewed by the customer", detail: null };
    case "checkout_started":
      return { title: "Customer started paying online", detail: join(money, methodLabel(m)) };
    case "payment_received":
      return { title: "Payment received", detail: join(money, methodLabel(m)), tone: "good" };
    case "payment_processing":
      return { title: "Bank payment processing", detail: join(money, "clears in a few business days") };
    case "payment_cleared":
      return { title: "Payment cleared", detail: money, tone: "good" };
    case "payment_failed":
      return { title: "Payment failed", detail: money, tone: "bad" };
    case "payment_recorded":
      return { title: "Payment recorded", detail: join(money, methodLabel(m)), tone: "good" };
    case "payment_removed":
      return { title: "Payment removed", detail: join(money, methodLabel(m)), tone: "bad" };
    case "payment_refunded":
    case "payment_partially_refunded": {
      const refunded = metaNum(m, "refundedCents");
      return {
        title: e.event_type === "payment_refunded" ? "Payment refunded" : "Payment partly refunded",
        detail: refunded !== null ? formatCents(refunded, currency) : null,
        tone: "bad",
      };
    }
    case "payment_on_void_invoice":
      return { title: "Payment received on a void invoice — refund it in Stripe", detail: money, tone: "bad" };
    case "receipt_sent":
      return { title: "Receipt emailed", detail: to };
    case "receipt_failed":
      return { title: "Receipt email failed", detail: reason, tone: "bad" };
    case "reminder_sent":
      return { title: "Reminder sent", detail: to };
    case "reminder_failed":
      return { title: "Reminder failed", detail: reason, tone: "bad" };
    case "overdue": {
      const days = metaNum(m, "daysOverdue");
      return { title: "Became overdue", detail: days !== null ? `${days} day${days === 1 ? "" : "s"} past due` : null, tone: "bad" };
    }
    case "paid":
      return { title: "Paid in full", detail: null, tone: "good" };
    case "voided":
      return { title: "Voided", detail: reason, tone: "bad" };
    case "statement_sent":
      return { title: "Included in a statement", detail: to };
    default: {
      const label = e.event_type.replace(/[._]/g, " ");
      return { title: label.charAt(0).toUpperCase() + label.slice(1), detail: null };
    }
  }
}

function paymentStatusLabel(p: InvoicePayment): { label: string; cls: string } {
  switch (p.status) {
    case "pending":
      return { label: "Clearing", cls: "text-[hsl(var(--warning))] bg-[hsl(var(--warning))]/10" };
    case "failed":
      return { label: p.failure_reason?.startsWith("Removed") ? "Removed" : "Failed", cls: "text-destructive bg-destructive/10" };
    case "refunded":
      return { label: "Refunded", cls: "text-muted-foreground bg-secondary" };
    default:
      return { label: "Received", cls: "text-[hsl(var(--success))] bg-[hsl(var(--success))]/10" };
  }
}

// ─── Void dialog ─────────────────────────────────────────────────────────────

function VoidInvoiceDialog({ invoice, onClose }: { invoice: Invoice; onClose: () => void }) {
  const orgId = useOrgId();
  const voidInvoice = useVoidInvoice(orgId);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setError(null);
    try {
      await voidInvoice.mutateAsync({ invoiceId: invoice.id, reason: reason.trim() || undefined });
      toast.success(`${invoice.invoice_number ?? "Draft invoice"} voided`);
      onClose();
    } catch (err) {
      const msg = errorMessage(err, "Couldn't void the invoice.");
      setError(msg);
      toast.error(msg);
    }
  }

  return (
    <Modal onClose={onClose} size="md">
      <div className="px-6 py-4 border-b border-border">
        <h2 className="text-base font-semibold text-foreground">Void {invoice.invoice_number ?? "this draft"}?</h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          {invoice.status === "draft"
            ? "The draft is kept for your records but can't be sent."
            : "The customer's pay link stops working and reminders stop. This can't be undone."}
        </p>
      </div>
      <div className="p-6 space-y-4">
        <div>
          <label className={labelCls}>Reason (optional)</label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            placeholder="e.g., Issued to the wrong customer"
            className={cn(inputCls, "resize-none")}
          />
        </div>
        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
            {error}
          </div>
        )}
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className={cn(secondaryBtnCls, "flex-1")}>
            Don&apos;t void
          </button>
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={voidInvoice.isPending}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors disabled:opacity-50"
          >
            {voidInvoice.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Void invoice
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ─── Sheet ───────────────────────────────────────────────────────────────────

type DialogKind = "edit" | "send" | "payment" | "void" | null;

export function InvoiceDetailSheet({
  invoiceId,
  onClose,
  openSendOnLoad,
  onSendOpened,
}: {
  invoiceId: string | null;
  onClose: () => void;
  /** Open the send dialog as soon as the invoice loads (after "Save & send"). */
  openSendOnLoad?: boolean;
  onSendOpened?: () => void;
}) {
  const orgId = useOrgId();
  const navigate = useNavigate();
  const { data: detail, isLoading, isError, error, refetch } = useInvoice(orgId, invoiceId);
  const removePayment = useRemoveInvoicePayment(orgId);
  const sendInvoice = useSendInvoice(orgId);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const open = Boolean(invoiceId);

  // Reset any dialog when switching invoices.
  useEffect(() => {
    setDialog(null);
  }, [invoiceId]);

  useEffect(() => {
    if (openSendOnLoad && detail && detail.invoice.id === invoiceId) {
      setDialog("send");
      onSendOpened?.();
    }
  }, [openSendOnLoad, detail, invoiceId, onSendOpened]);

  // Escape closes the sheet — unless a dialog on top of it is handling it.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && dialog === null) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, dialog, onClose]);

  // Lock background scroll while open.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  if (typeof document === "undefined") return null;

  const invoice = detail?.invoice;
  const currency = invoice?.currency ?? "CAD";
  const isOpenInvoice = invoice ? ["sent", "viewed", "partially_paid"].includes(invoice.status) : false;
  const hasMoney = invoice ? invoice.amount_paid_cents > 0 || invoice.pending_payment_cents > 0 : false;
  const canEdit = invoice ? invoice.status === "draft" || (isOpenInvoice && !hasMoney) : false;
  const canVoid = invoice ? invoice.status !== "void" && invoice.status !== "paid" && !hasMoney : false;

  const openPdf = (download: boolean) => {
    if (!invoice) return;
    window.open(invoicePdfUrl(orgId, invoice.id, download), "_blank", "noopener");
  };

  const copyLink = async () => {
    if (!detail) return;
    try {
      await navigator.clipboard.writeText(detail.publicUrl);
      toast.success("Pay link copied");
    } catch {
      toast.error("Couldn't copy — the link is " + detail.publicUrl);
    }
  };

  const textLink = async () => {
    if (!invoice) return;
    if (!invoice.bill_to.phone) {
      toast.error("No phone number on file for this customer.");
      return;
    }
    try {
      const result = await sendInvoice.mutateAsync({ invoiceId: invoice.id, email: false, sms: true });
      toastDeliveryOutcomes("Pay link", null, result.sms, result.copy);
    } catch (err) {
      toast.error(errorMessage(err, "Couldn't text the pay link."));
    }
  };

  const confirmRemovePayment = (p: InvoicePayment) => {
    if (!invoice) return;
    const what = `${formatCents(p.amount_cents, currency)} ${PAYMENT_METHOD_LABELS[p.method]}`;
    if (!window.confirm(`Remove the ${what} payment? Use this only for a payment recorded by mistake.`)) return;
    removePayment.mutate(
      { invoiceId: invoice.id, paymentId: p.id },
      {
        onSuccess: () => toast.success("Payment removed"),
        onError: (err) => toast.error(errorMessage(err, "Couldn't remove the payment.")),
      },
    );
  };

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
    if (isError || !detail || !invoice) {
      return (
        <div className="flex-1 flex flex-col">
          <div className="flex justify-end p-3">
            <button onClick={onClose} className="p-1 hover:bg-secondary rounded-md transition-colors" aria-label="Close">
              <X className="w-4 h-4 text-muted-foreground" />
            </button>
          </div>
          <ErrorState message={errorMessage(error, "Couldn't load this invoice.")} onRetry={() => void refetch()} />
        </div>
      );
    }

    const billTo = invoice.bill_to;
    const rows: Array<{ label: string; value: number; strong?: boolean; tone?: string; negative?: boolean }> = [
      { label: "Subtotal", value: invoice.subtotal_cents },
      { label: `Tax (${invoice.tax_rate_bps / 100}%)`, value: invoice.tax_cents },
      { label: "Total", value: invoice.total_cents, strong: true },
    ];
    if (invoice.credit_cents > 0) rows.push({ label: "Deposit / credit", value: invoice.credit_cents, negative: true });
    if (invoice.amount_paid_cents > 0) rows.push({ label: "Paid", value: invoice.amount_paid_cents, negative: true, tone: "text-[hsl(var(--success))]" });
    if (invoice.pending_payment_cents > 0) rows.push({ label: "Clearing", value: invoice.pending_payment_cents, tone: "text-[hsl(var(--warning))]" });

    return (
      <div className="flex-1 flex flex-col min-h-0">
        {/* Header */}
        <div className="p-5 border-b border-border bg-secondary/10 shrink-0">
          <div className="flex items-start justify-between gap-2 mb-2">
            <div className="min-w-0">
              <h3 className="text-base font-bold text-foreground leading-tight truncate">{invoice.invoice_number ?? "Draft invoice"}</h3>
              {invoice.title && <p className="text-xs text-muted-foreground mt-0.5 truncate">{invoice.title}</p>}
            </div>
            <button onClick={onClose} className="p-1 hover:bg-secondary rounded-md transition-colors shrink-0" aria-label="Close">
              <X className="w-4 h-4 text-muted-foreground" />
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <InvoiceStatusBadge status={invoice.status} overdue={invoice.overdue} />
            {invoice.status !== "draft" && <SyncBadge orgId={orgId} companyId={invoice.company_id} type="invoice" id={invoice.id} />}
            {invoice.quote_id && (
              <button
                type="button"
                onClick={() => navigate(`/quotes?open=${invoice.quote_id}`)}
                className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border border-border bg-background text-muted-foreground hover:text-foreground"
              >
                <FileText className="w-3 h-3" /> From quote
              </button>
            )}
            {invoice.booking_id && (
              <button
                type="button"
                onClick={() => navigate(`/calendar?booking=${invoice.booking_id}`)}
                className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border border-border bg-background text-muted-foreground hover:text-foreground"
              >
                <CalendarDays className="w-3 h-3" /> Booking
              </button>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-6 custom-scrollbar">
          {/* Balance hero */}
          <div className={cn("rounded-xl border p-4", invoice.overdue ? "border-destructive/30 bg-destructive/5" : "border-border bg-secondary/20")}>
            <p className={sectionLabelCls}>{invoice.status === "paid" ? "Paid in full" : invoice.status === "void" ? "Void" : "Balance due"}</p>
            <p className={cn("text-2xl font-bold tracking-tight mt-1 tabular-nums", invoice.overdue ? "text-destructive" : "text-foreground")}>
              {formatCents(invoice.status === "paid" ? invoice.total_cents : invoice.balance_due_cents, currency)}
            </p>
            {invoice.status === "void" && invoice.void_reason && <p className="text-xs text-muted-foreground mt-1">{invoice.void_reason}</p>}
            {invoice.status !== "void" && invoice.due_date && invoice.status !== "paid" && (
              <p className={cn("text-xs mt-1", invoice.overdue ? "text-destructive font-medium" : "text-muted-foreground")}>
                {invoice.overdue ? "Overdue — was due " : "Due "}
                {formatYmd(invoice.due_date, "long")}
              </p>
            )}
            {invoice.status === "paid" && invoice.paid_at && <p className="text-xs text-muted-foreground mt-1">Paid {formatDate(invoice.paid_at, "MMM d, yyyy")}</p>}
          </div>

          {/* Bill to + dates */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1 col-span-2 sm:col-span-1">
              <p className={sectionLabelCls}>Bill to</p>
              {!invoice.contact_id && !invoice.customer_account_id ? (
                <p className="text-sm text-muted-foreground italic">No customer yet — edit the draft to choose who it's for.</p>
              ) : (
                <p className="text-sm font-medium text-foreground">{billTo.name}</p>
              )}
              {billTo.attention && <p className="text-xs text-muted-foreground">Attn: {billTo.attention}</p>}
              {billTo.email && <p className="text-xs text-muted-foreground break-all">{billTo.email}</p>}
              {billTo.phone && <p className="text-xs text-muted-foreground">{billTo.phone}</p>}
              {billTo.address && <p className="text-xs text-muted-foreground whitespace-pre-line">{billTo.address}</p>}
              {invoice.contact_id && (
                <button
                  type="button"
                  onClick={() => navigate(`/crm/${invoice.contact_id}`)}
                  className="flex items-center gap-1 text-[11px] text-primary hover:underline pt-0.5"
                >
                  Open contact <ArrowUpRight className="w-3 h-3" />
                </button>
              )}
            </div>
            <div className="space-y-2 col-span-2 sm:col-span-1">
              <div>
                <p className={sectionLabelCls}>Issued</p>
                <p className="text-xs font-medium text-foreground">{invoice.issue_date ? formatYmd(invoice.issue_date) : "Not sent yet"}</p>
              </div>
              <div>
                <p className={sectionLabelCls}>Terms</p>
                <p className="text-xs font-medium text-foreground">
                  {invoice.payment_terms_days === 0 ? "Due on receipt" : `Net ${invoice.payment_terms_days}`}
                  {invoice.status === "draft" && invoice.due_date ? ` · due ${formatYmd(invoice.due_date)}` : ""}
                </p>
              </div>
              {invoice.sent_at && (
                <div>
                  <p className={sectionLabelCls}>Sent</p>
                  <p className="text-xs font-medium text-foreground">
                    {relativeTime(invoice.sent_at)}
                    {invoice.first_viewed_at ? ` · viewed ${relativeTime(invoice.first_viewed_at)}` : ""}
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Line items + amounts */}
          <div className="space-y-2">
            <p className={sectionLabelCls}>Line items</p>
            <div className="rounded-xl border border-border/60 divide-y divide-border/60">
              {invoice.line_items.map((l, i) => (
                <div key={i} className="flex items-start justify-between gap-3 px-3 py-2.5">
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-foreground">{l.label}</p>
                    {l.description && <p className="text-[11px] text-muted-foreground whitespace-pre-line mt-0.5">{l.description}</p>}
                    <p className="text-[11px] text-muted-foreground mt-0.5 tabular-nums">
                      {l.quantity} × {formatCents(l.unitPriceCents, currency)}
                    </p>
                  </div>
                  <p className={cn("text-xs font-medium tabular-nums shrink-0", l.amountCents < 0 ? "text-[hsl(var(--success))]" : "text-foreground")}>
                    {formatCents(l.amountCents, currency)}
                  </p>
                </div>
              ))}
              <div className="px-3 py-2.5 space-y-1 bg-secondary/20 rounded-b-xl">
                {rows.map((r) => (
                  <div key={r.label} className={cn("flex justify-between text-xs", r.strong ? "font-semibold text-foreground" : "text-muted-foreground", r.tone)}>
                    <span>{r.label}</span>
                    <span className="tabular-nums">
                      {r.negative ? "−" : ""}
                      {formatCents(r.value, currency)}
                    </span>
                  </div>
                ))}
                <div className="flex justify-between text-sm font-bold text-foreground border-t border-border pt-1.5">
                  <span>Balance due</span>
                  <span className="tabular-nums">{formatCents(invoice.balance_due_cents, currency)}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Notes */}
          {(invoice.notes || invoice.internal_notes) && (
            <div className="space-y-3">
              {invoice.notes && (
                <div className="space-y-1.5">
                  <p className={sectionLabelCls}>Notes to customer</p>
                  <p className="text-xs text-foreground/80 whitespace-pre-wrap bg-secondary/30 rounded-xl p-3 border border-border/50">{invoice.notes}</p>
                </div>
              )}
              {invoice.internal_notes && (
                <div className="space-y-1.5">
                  <p className={sectionLabelCls}>Internal notes</p>
                  <p className="text-xs text-foreground/80 whitespace-pre-wrap bg-[hsl(var(--warning))]/5 rounded-xl p-3 border border-[hsl(var(--warning))]/20">
                    {invoice.internal_notes}
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Online payments hint */}
          {!detail.online.stripeReady && invoice.status !== "void" && invoice.status !== "paid" && (
            <div className="flex items-start gap-2 rounded-xl border border-border bg-secondary/30 p-3">
              <CreditCard className="w-3.5 h-3.5 text-muted-foreground mt-0.5 shrink-0" />
              <p className="text-[11px] text-muted-foreground">
                Online card/bank payments are off for this company — connect Stripe in{" "}
                <button type="button" onClick={() => navigate("/settings/payments")} className="text-primary hover:underline">
                  Settings → Payments
                </button>
                .
              </p>
            </div>
          )}

          {/* Payments */}
          {detail.payments.length > 0 && (
            <div className="space-y-2">
              <p className={sectionLabelCls}>Payments</p>
              <div className="space-y-1.5">
                {detail.payments.map((p) => {
                  const st = paymentStatusLabel(p);
                  const removable = !p.stripe_payment_intent_id && p.status === "succeeded";
                  return (
                    <div key={p.id} className="flex items-start justify-between gap-3 p-2.5 rounded-lg bg-card border border-border">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={cn("text-xs font-semibold tabular-nums", p.status === "failed" || p.status === "refunded" ? "line-through text-muted-foreground" : "text-foreground")}>
                            {formatCents(p.amount_cents, currency)}
                          </span>
                          <span className="text-xs text-muted-foreground">{PAYMENT_METHOD_LABELS[p.method]}</span>
                          <span className={cn("px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider", st.cls)}>{st.label}</span>
                        </div>
                        <p className="text-[11px] text-muted-foreground mt-0.5">
                          {formatDate(p.received_at, "MMM d, yyyy")}
                          {p.reference ? ` · ${p.reference}` : ""}
                        </p>
                        {p.status === "failed" && p.failure_reason && <p className="text-[11px] text-destructive mt-0.5">{p.failure_reason}</p>}
                        {p.notes && <p className="text-[11px] text-muted-foreground mt-0.5 whitespace-pre-wrap">{p.notes}</p>}
                      </div>
                      {removable && (
                        <button
                          type="button"
                          onClick={() => confirmRemovePayment(p)}
                          disabled={removePayment.isPending}
                          className="text-[11px] font-medium text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50 shrink-0"
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Activity */}
          <div className="space-y-3">
            <p className={sectionLabelCls}>Activity</p>
            {detail.events.length === 0 ? (
              <p className="text-[10px] text-muted-foreground italic">No activity yet.</p>
            ) : (
              <div className="space-y-3 relative before:absolute before:left-[11px] before:top-2 before:bottom-2 before:w-px before:bg-border">
                {detail.events.map((e) => {
                  const d = describeEvent(e, currency);
                  return (
                    <div key={e.id} className="relative pl-8">
                      <div className="absolute left-0 top-0.5 w-6 h-6 rounded-full bg-card border border-border flex items-center justify-center z-10">
                        <div
                          className={cn(
                            "w-1.5 h-1.5 rounded-full",
                            d.tone === "bad" ? "bg-destructive" : d.tone === "good" ? "bg-[hsl(var(--success))]" : "bg-primary",
                          )}
                        />
                      </div>
                      <p className="text-xs font-medium text-foreground">{d.title}</p>
                      <p className="text-[10px] text-muted-foreground">
                        {d.detail ? `${d.detail} · ` : ""}
                        <span title={new Date(e.created_at).toLocaleString()}>{relativeTime(e.created_at)}</span>
                      </p>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="p-4 border-t border-border bg-secondary/20 shrink-0 space-y-2">
          {invoice.status === "draft" && (
            <>
              <button
                type="button"
                onClick={() => setDialog("send")}
                className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-bold bg-[hsl(var(--accent-blue))] text-white hover:bg-[hsl(var(--accent-blue))]/90 transition-colors"
              >
                <Send className="w-3.5 h-3.5" /> Send invoice
              </button>
              <div className="grid grid-cols-3 gap-2">
                <button type="button" onClick={() => setDialog("edit")} className={actionBtnCls}>
                  <Pencil className="w-3.5 h-3.5" /> Edit
                </button>
                <button type="button" onClick={() => openPdf(false)} className={actionBtnCls}>
                  <ExternalLink className="w-3.5 h-3.5" /> Preview
                </button>
                <button type="button" onClick={() => setDialog("void")} className={cn(actionBtnCls, "hover:text-destructive")}>
                  <Ban className="w-3.5 h-3.5" /> Void
                </button>
              </div>
            </>
          )}

          {isOpenInvoice && (
            <>
              <button
                type="button"
                onClick={() => setDialog("payment")}
                disabled={invoice.balance_due_cents - invoice.pending_payment_cents <= 0}
                className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-bold bg-[hsl(var(--success))] text-white hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                <CreditCard className="w-3.5 h-3.5" /> Record payment
              </button>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <button type="button" onClick={() => setDialog("send")} className={actionBtnCls}>
                  <Send className="w-3.5 h-3.5" /> Resend
                </button>
                <button type="button" onClick={() => void copyLink()} className={actionBtnCls}>
                  <Copy className="w-3.5 h-3.5" /> Copy link
                </button>
                <button type="button" onClick={() => void textLink()} disabled={sendInvoice.isPending} className={actionBtnCls}>
                  {sendInvoice.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <MessageSquare className="w-3.5 h-3.5" />} Text link
                </button>
                <button type="button" onClick={() => openPdf(true)} className={actionBtnCls}>
                  <Download className="w-3.5 h-3.5" /> Download PDF
                </button>
              </div>
              {(canEdit || canVoid) && (
                <div className="flex justify-center gap-4 pt-1">
                  {canEdit && (
                    <button type="button" onClick={() => setDialog("edit")} className="text-[11px] font-medium text-muted-foreground hover:text-foreground flex items-center gap-1">
                      <Pencil className="w-3 h-3" /> Edit invoice
                    </button>
                  )}
                  {canVoid && (
                    <button type="button" onClick={() => setDialog("void")} className="text-[11px] font-medium text-muted-foreground hover:text-destructive flex items-center gap-1">
                      <Ban className="w-3 h-3" /> Void
                    </button>
                  )}
                </div>
              )}
            </>
          )}

          {invoice.status === "paid" && (
            <div className="grid grid-cols-2 gap-2">
              <button type="button" onClick={() => openPdf(true)} className={actionBtnCls}>
                <Download className="w-3.5 h-3.5" /> Download PDF
              </button>
              <button type="button" onClick={() => void copyLink()} className={actionBtnCls}>
                <Copy className="w-3.5 h-3.5" /> Copy link
              </button>
            </div>
          )}

          {invoice.status === "void" && (
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              <p className="text-[11px] text-muted-foreground flex-1">
                Voided{invoice.voided_at ? ` ${relativeTime(invoice.voided_at)}` : ""}. Create a new invoice to bill again.
              </p>
              <button type="button" onClick={() => openPdf(true)} className={actionBtnCls}>
                <Download className="w-3.5 h-3.5" /> Download PDF
              </button>
            </div>
          )}
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
            aria-label="Invoice details"
            className={cn(
              "absolute flex flex-col bg-card border-border shadow-2xl shadow-black/60 transition-transform duration-300 ease-out",
              // Mobile: bottom sheet. Desktop: right-hand panel.
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

      {invoice && dialog === "edit" && (
        <InvoiceEditorDialog
          invoice={invoice}
          onClose={() => setDialog(null)}
          onSaved={(_saved, { send }) => setDialog(send ? "send" : null)}
        />
      )}
      {invoice && dialog === "send" && <SendInvoiceDialog invoice={invoice} onClose={() => setDialog(null)} />}
      {invoice && dialog === "payment" && <RecordPaymentDialog invoice={invoice} onClose={() => setDialog(null)} />}
      {invoice && dialog === "void" && <VoidInvoiceDialog invoice={invoice} onClose={() => setDialog(null)} />}
    </>
  );
}
