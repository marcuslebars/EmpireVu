/**
 * Invoice money, dates and conversions — PURE functions only, so every number on
 * an invoice can be unit-tested without a database.
 *
 * All money is integer cents. Quantities may carry up to two decimals (1.5 hours
 * of detailing); a line's amount is rounded half-up to the cent ONCE, and the
 * invoice totals are sums of those rounded amounts — so the lines a customer sees
 * always add up to the subtotal they see.
 */

export interface InvoiceLineInput {
  label: string;
  description?: string | null;
  quantity: number;
  unitPriceCents: number;
}

export interface InvoiceLine {
  label: string;
  description: string | null;
  quantity: number;
  unitPriceCents: number;
  amountCents: number;
}

export interface InvoiceTotals {
  lineItems: InvoiceLine[];
  subtotalCents: number;
  taxRateBps: number;
  taxCents: number;
  totalCents: number;
}

/** Round half away from zero to an integer — symmetric for discount lines. */
function roundHalfAway(x: number): number {
  return Math.sign(x) * Math.round(Math.abs(x));
}

/** Quantity to 2 decimals, so 1.005 can't sneak an extra fraction of a cent in. */
export function normalizeQuantity(q: number): number {
  return Math.round(q * 100) / 100;
}

export function lineAmountCents(quantity: number, unitPriceCents: number): number {
  // Work in hundredths of a unit to stay in integers until the final rounding.
  const hundredths = Math.round(normalizeQuantity(quantity) * 100);
  return roundHalfAway((hundredths * unitPriceCents) / 100);
}

/**
 * Tax on a (possibly discounted) subtotal. A subtotal can't go negative on a real
 * invoice — a credit note is a different document — so tax floors at zero.
 */
export function taxCentsFor(subtotalCents: number, taxRateBps: number): number {
  if (subtotalCents <= 0 || taxRateBps <= 0) return 0;
  return Math.floor((subtotalCents * taxRateBps + 5_000) / 10_000);
}

export function computeInvoiceTotals(lines: InvoiceLineInput[], taxRateBps: number): InvoiceTotals {
  const lineItems: InvoiceLine[] = lines.map((l) => {
    const quantity = normalizeQuantity(l.quantity);
    return {
      label: l.label.trim(),
      description: l.description?.trim() || null,
      quantity,
      unitPriceCents: Math.round(l.unitPriceCents),
      amountCents: lineAmountCents(quantity, Math.round(l.unitPriceCents)),
    };
  });
  const subtotalCents = lineItems.reduce((sum, l) => sum + l.amountCents, 0);
  const taxCents = taxCentsFor(subtotalCents, taxRateBps);
  return { lineItems, subtotalCents, taxRateBps, taxCents, totalCents: subtotalCents + taxCents };
}

/** What the customer still owes, given money already in. Never negative. */
export function balanceDueCents(totalCents: number, creditCents: number, paidCents: number): number {
  return Math.max(totalCents - creditCents - paidCents, 0);
}

// ── Dates ────────────────────────────────────────────────────────────────────

/** Today's calendar date (YYYY-MM-DD) in a time zone. */
export function localDateString(now: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD.
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/** YYYY-MM-DD + n days, as a calendar date (no time-zone drift). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (both YYYY-MM-DD); positive when `to` is later. */
export function daysBetween(from: string, to: string): number {
  const [y1, m1, d1] = from.split("-").map(Number);
  const [y2, m2, d2] = to.split("-").map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000);
}

export const OPEN_STATUSES = ["sent", "viewed", "partially_paid"] as const;

export function isOpenStatus(status: string): boolean {
  return (OPEN_STATUSES as readonly string[]).includes(status);
}

/** Overdue = open, has a balance, and the due date is before today. */
export function isOverdue(
  invoice: { status: string; due_date: string | null; balance_due_cents: number; pending_payment_cents?: number },
  today: string,
): boolean {
  // Money that's clearing (a bank debit) for the whole balance isn't late — just slow.
  return (
    isOpenStatus(invoice.status) &&
    invoice.balance_due_cents - (invoice.pending_payment_cents ?? 0) > 0 &&
    invoice.due_date !== null &&
    daysBetween(invoice.due_date, today) > 0
  );
}

/**
 * Which reminder (if any) is due today. `sentCount` reminders have gone out
 * already; the next one fires once the invoice is at least reminderDays[sentCount]
 * days past due. Returns the index of the reminder to send, or null.
 *
 * Catching up is deliberate but bounded: an invoice that was 20 days overdue when
 * reminders were switched on gets ONE reminder today, not three at once — the
 * count only advances by one per sweep.
 */
export function dueReminderIndex(
  daysOverdue: number,
  reminderDays: number[],
  sentCount: number,
): number | null {
  if (daysOverdue <= 0) return null;
  if (sentCount >= reminderDays.length) return null;
  return daysOverdue >= reminderDays[sentCount] ? sentCount : null;
}

export type AgingBucket = "current" | "1_30" | "31_60" | "61_90" | "over_90";

export function agingBucket(dueDate: string | null, today: string): AgingBucket {
  if (!dueDate) return "current";
  const late = daysBetween(dueDate, today);
  if (late <= 0) return "current";
  if (late <= 30) return "1_30";
  if (late <= 60) return "31_60";
  if (late <= 90) return "61_90";
  return "over_90";
}

// ── Quote → invoice ─────────────────────────────────────────────────────────

/** The subset of a quote row the conversion needs. */
export interface QuoteForInvoice {
  title: string | null;
  quote_number: string | null;
  approved_line_items: unknown;
  approved_subtotal_cents: number | null;
  tax_rate_bps: number;
  approved_deposit_cents: number | null;
  deposit_paid_at: string | null;
}

interface QuoteLineLike {
  label?: unknown;
  description?: unknown;
  quantity?: unknown;
  unitPriceCents?: unknown;
  amountCents?: unknown;
  optional?: unknown;
  selected?: unknown;
}

function asQuoteLines(raw: unknown): QuoteLineLike[] {
  return Array.isArray(raw) ? (raw.filter((l) => l && typeof l === "object") as QuoteLineLike[]) : [];
}

/**
 * Turn an APPROVED quote into invoice lines, from the FROZEN approved selection —
 * that is what the customer agreed to pay for. There is deliberately no fallback to
 * the live line_items: those re-price with the price list and were never accepted.
 * Callers check approval first (isQuoteApprovedForInvoicing); a quote with no
 * approved lines throws here as a backstop. A bundle discount is applied at the subtotal level in
 * the quote engine, so it is carried over as an explicit discount line — the
 * invoice must total exactly what the quote did.
 *
 * Returns the deposit already paid as a credit, so the invoice asks only for the
 * balance.
 */
export function quoteToInvoiceDraft(quote: QuoteForInvoice): {
  title: string;
  lines: InvoiceLineInput[];
  taxRateBps: number;
  creditCents: number;
} {
  const approved = asQuoteLines(quote.approved_line_items);
  if (approved.length === 0) {
    // Internal invariant (the service checks approval first), so a plain Error.
    throw new Error("quoteToInvoiceDraft: quote has no approved line items.");
  }
  const chosen = approved.filter((l) => l.optional !== true || l.selected === true);

  const lines: InvoiceLineInput[] = chosen.map((l) => {
    const amount = Number(l.amountCents ?? 0);
    const qty = Number(l.quantity ?? 1) || 1;
    const unit = Number(l.unitPriceCents ?? amount);
    // Engine lines are priced as a whole (e.g. per-foot × length); when qty × unit
    // doesn't reproduce the amount, invoice it as one line of the amount.
    const exact = lineAmountCents(qty, unit) === amount;
    const label = typeof l.label === "string" && l.label.trim() ? l.label.trim() : "Service";
    const description = typeof l.description === "string" && l.description.trim() && l.description.trim() !== label
      ? l.description.trim()
      : null;
    return exact
      ? { label, description, quantity: qty, unitPriceCents: unit }
      : { label, description, quantity: 1, unitPriceCents: amount };
  });

  const linesTotal = lines.reduce((s, l) => s + lineAmountCents(l.quantity, l.unitPriceCents), 0);
  const quoteSubtotal = quote.approved_subtotal_cents ?? linesTotal;
  const discount = quoteSubtotal - linesTotal;
  if (discount !== 0) {
    lines.push({
      label: discount < 0 ? "Bundle discount" : "Adjustment",
      description: null,
      quantity: 1,
      unitPriceCents: discount,
    });
  }

  const creditCents = quote.deposit_paid_at && quote.approved_deposit_cents ? quote.approved_deposit_cents : 0;
  const ref = quote.quote_number ? ` (${quote.quote_number})` : "";
  return {
    title: (quote.title?.trim() || "Services") + ref,
    lines,
    taxRateBps: quote.tax_rate_bps,
    creditCents,
  };
}
