/**
 * Job done → invoice. Called when a booking moves to "completed" (dashboard, mobile,
 * or an automation), under the same tenant context that completed it.
 *
 * Per brand (Settings → Invoices → "When a job is marked done"):
 *   off    nothing happens (the default)
 *   draft  a draft invoice is created for the owner to check and send
 *   send   the invoice is created and sent to the customer
 *
 * A booking made off a quote invoices that quote's agreed prices with the deposit
 * credited. A stand-alone booking has no price yet, so it always stays a $0 draft and
 * the owner gets a task to price and send it — nothing unpriced is ever sent.
 *
 * Best-effort by design: completing the job must never fail because invoicing did.
 */
import { createTask } from "@/server/services/tasks";
import type { TenantServiceContext } from "@/server/services/shared";
import type { Tables } from "@/server/db/database.types";
import { loadCompanyForInvoice } from "./common";
import { InvoiceConflictError } from "./errors";
import { createInvoiceFromBooking, sendInvoice } from "./service";
import { parseInvoiceSettings } from "./settings";

/**
 * A stand-alone job with no price yet is invoiced as a $0 line named after the job. Billed
 * expenses can make the total non-zero, but the work itself still needs a price — so it
 * stays a draft with a task, never sent.
 */
export function hasUnpricedJobLine(invoice: Pick<Tables<"invoices">, "line_items">, jobTitle: string): boolean {
  const lines = Array.isArray(invoice.line_items) ? (invoice.line_items as Array<{ label?: unknown; unitPriceCents?: unknown }>) : [];
  const title = jobTitle.trim();
  // The line's label is the booking title as stored (possibly with stray spaces), so
  // compare trimmed on both sides.
  return lines.some((l) => typeof l.label === "string" && l.label.trim() === title && l.unitPriceCents === 0);
}

export type AutoInvoiceOutcome =
  | { action: "skipped"; reason: string }
  | { action: "drafted" | "sent" | "needs_price"; invoiceId: string; emailed?: boolean };

export async function autoInvoiceCompletedBooking(
  ctx: TenantServiceContext,
  booking: Pick<Tables<"bookings">, "id" | "company_id" | "contact_id" | "title">,
): Promise<AutoInvoiceOutcome> {
  try {
    if (!booking.company_id) return { action: "skipped", reason: "booking has no company" };
    if (!booking.contact_id) return { action: "skipped", reason: "booking has no customer" };
    const company = await loadCompanyForInvoice(ctx.supabase, ctx.organizationId, booking.company_id);
    const mode = parseInvoiceSettings(company?.invoice_settings ?? null).autoInvoiceOnComplete;
    if (mode === "off") return { action: "skipped", reason: "auto-invoicing is off" };

    let invoice;
    try {
      invoice = await createInvoiceFromBooking(ctx, booking.id);
    } catch (err) {
      // Already invoiced (by hand, or the quote was) — that's fine, nothing to do.
      if (err instanceof InvoiceConflictError) return { action: "skipped", reason: "already invoiced" };
      throw err;
    }

    if (invoice.total_cents <= 0 || hasUnpricedJobLine(invoice, booking.title)) {
      await createTask(ctx, {
        title: `Price and send the invoice for "${booking.title}"`,
        description: "The job was marked done. Its draft invoice has no price yet — open Invoices, add the amount, then send it.",
        companyId: booking.company_id,
        contactId: booking.contact_id,
        bookingId: booking.id,
        priority: "medium",
      }).catch((err: unknown) => console.error("[invoices/auto] could not create the pricing task:", err instanceof Error ? err.message : err));
      return { action: "needs_price", invoiceId: invoice.id };
    }

    if (mode === "draft") return { action: "drafted", invoiceId: invoice.id };

    const sent = await sendInvoice(ctx, invoice.id, { email: true });
    return { action: "sent", invoiceId: invoice.id, emailed: sent.email?.delivered ?? false };
  } catch (err) {
    console.error(`[invoices/auto] auto-invoice failed for booking ${booking.id}:`, err instanceof Error ? err.message : err);
    return { action: "skipped", reason: err instanceof Error ? err.message : "error" };
  }
}
