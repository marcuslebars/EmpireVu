/**
 * Shared bits for the staff quote screens: statuses, line parsing, price hints and
 * the send-outcome toast. Form classes and money parsing come from the invoice screens.
 */
import { toast } from "@/components/ui/sonner";
import { ApiError, type EmailOutcome } from "@/lib/api-client";
import { formatCents } from "@/lib/invoices-api";
import type { CatalogItemSummary, QuotePreviewLine } from "@/lib/quotes-api";

export const QUOTE_STATUSES = ["draft", "sent", "viewed", "approved", "deposit_paid", "completed", "expired", "cancelled"] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

export const QUOTE_STATUS_LABELS: Record<QuoteStatus, string> = {
  draft: "Draft",
  sent: "Sent",
  viewed: "Viewed",
  approved: "Approved",
  deposit_paid: "Deposit paid",
  completed: "Completed",
  expired: "Expired",
  cancelled: "Void",
};

export function asQuoteStatus(s: string): QuoteStatus {
  return (QUOTE_STATUSES as readonly string[]).includes(s) ? (s as QuoteStatus) : "draft";
}

/** Server rules (service.ts / lifecycle.ts), mirrored only to decide which buttons to show. */
export const EDITABLE_STATUSES: readonly QuoteStatus[] = ["draft", "sent", "viewed"];
export const REISSUABLE_STATUSES: readonly QuoteStatus[] = ["draft", "sent", "viewed", "approved", "expired"];
export const VOIDABLE_STATUSES = REISSUABLE_STATUSES;

export type QuoteFilter = "all" | "draft" | "with_customer" | "approved" | "deposit_paid" | "completed" | "closed";

export const QUOTE_FILTERS: Array<{ value: QuoteFilter; label: string; statuses: readonly QuoteStatus[] | null }> = [
  { value: "all", label: "All", statuses: null },
  { value: "draft", label: "Drafts", statuses: ["draft"] },
  { value: "with_customer", label: "With customer", statuses: ["sent", "viewed"] },
  { value: "approved", label: "Approved", statuses: ["approved"] },
  { value: "deposit_paid", label: "Deposit paid", statuses: ["deposit_paid"] },
  { value: "completed", label: "Completed", statuses: ["completed"] },
  { value: "closed", label: "Closed", statuses: ["expired", "cancelled"] },
];

/** A stored or previewed priced line. Parsed defensively — line_items is jsonb. */
export type QuoteLine = Pick<QuotePreviewLine, "label" | "description" | "quantity" | "amountCents" | "optional" | "selected" | "custom">;

export function parseLineItems(raw: unknown): QuoteLine[] {
  if (!Array.isArray(raw)) return [];
  const out: QuoteLine[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const r = entry as Record<string, unknown>;
    const amount = typeof r.amountCents === "number" ? r.amountCents : 0;
    out.push({
      label: typeof r.label === "string" ? r.label : "Line item",
      description: typeof r.description === "string" ? r.description : "",
      quantity: typeof r.quantity === "number" ? r.quantity : 1,
      amountCents: amount,
      optional: r.optional === true,
      selected: r.selected !== false,
      custom: r.custom === true,
    });
  }
  return out;
}

/** "$12" for whole dollars, "$12.50" otherwise. */
export function shortMoney(cents: number): string {
  if (cents % 100 === 0) {
    return new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD", maximumFractionDigits: 0 }).format(cents / 100);
  }
  return formatCents(cents);
}

/** A one-glance price hint for the service picker, e.g. "$12/ft" or "$350 flat". */
export function priceHint(item: CatalogItemSummary): string {
  const unit = item.unitLabel?.trim() || (item.pricingType === "per_unit" || item.pricingType === "per_unit_declining" ? "each" : "ft");
  const per = (cents: number) => (unit === "each" ? `${shortMoney(cents)} each` : `${shortMoney(cents)}/${unit}`);
  switch (item.pricingType) {
    case "flat":
      return `${shortMoney(item.rateCents)} flat`;
    case "per_unit":
    case "per_measure":
      return per(item.rateCents);
    case "per_unit_declining":
    case "per_measure_banded":
      return item.rateCents > 0 ? `from ${per(item.rateCents)}` : `priced by ${unit}`;
    case "tiered_by_measure":
      return `tiered by ${unit}`;
    default:
      return "";
  }
}

/** Toast what happened on send. The quote is live either way; a failed email is a warning. */
export function toastQuoteSent(quoteNumber: string | null, email: EmailOutcome, contactEmail?: string | null): void {
  const label = quoteNumber ? `Quote ${quoteNumber}` : "Quote";
  if (email.delivered) {
    toast.success(`${label} sent${contactEmail ? ` to ${contactEmail}` : ""}`);
    return;
  }
  toast.success(`${label} is live`);
  toast.warning(`Email not delivered: ${email.reason ?? "unknown reason"}. Copy the customer link and share it another way.`);
}

/** Matches InvoiceEditorDialog's error box. */
export const errorBoxCls = "rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive";

/**
 * The server refused to save because the edit would change the total on a quote the
 * customer already has (409 code "total_changed"). Returns both totals, else null.
 */
export function totalChangeFrom(err: unknown): { oldTotalCents: number; newTotalCents: number } | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  const body = err.body as { code?: unknown; oldTotalCents?: unknown; newTotalCents?: unknown } | undefined;
  if (!body || body.code !== "total_changed") return null;
  if (typeof body.oldTotalCents !== "number" || typeof body.newTotalCents !== "number") return null;
  return { oldTotalCents: body.oldTotalCents, newTotalCents: body.newTotalCents };
}
