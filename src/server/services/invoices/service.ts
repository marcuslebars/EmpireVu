/**
 * Invoices — the dashboard side. Runs under the caller's RLS client, so an org
 * member can only ever touch their own org's invoices; the explicit scope asserts
 * turn an out-of-org id into a clean 400 instead of an RLS failure.
 *
 * Lifecycle:
 *
 *   draft ─send─▶ sent ─(opened)─▶ viewed ─(part paid)─▶ partially_paid ─▶ paid
 *     │             └─────────────────┴──────────────────────┴──void──▶ void
 *     └──void──▶ void
 *
 * Status past 'draft' is DERIVED from the payments by refresh_invoice_balance
 * (SQL) — nothing here writes paid / partially_paid directly.
 *
 * Money rules:
 *   • totals are recomputed server-side from the lines on every write; a client
 *     never supplies a subtotal, tax or total.
 *   • an invoice with money against it (paid or clearing) can't be edited or
 *     voided — the fix for that is a refund, which is done in Stripe or recorded.
 */
import { randomBytes } from "node:crypto";

import { billableExpenseLines, markExpensesBilled } from "@/server/services/expenses/service";
import { seriesLineItems } from "@/server/services/recurring/service";
import { toJson } from "@/server/db/json";
import {
  assertBookingInOrganization,
  assertCompanyInOrganization,
  assertContactInOrganization,
  type TenantServiceContext,
} from "@/server/services/shared";
import {
  emitInvoiceTrigger,
  invoicePublicUrl,
  loadCompanyForInvoice,
  readBillTo,
  recordInvoiceEvent,
  refreshInvoiceBalance,
  resolveBillTo,
  todayFor,
  type InvoicePaymentRow,
  type InvoiceRow,
} from "./common";
import { InvoiceConflictError, InvoiceNotFoundError, InvoiceValidationError } from "./errors";
import {
  addDays,
  computeInvoiceTotals,
  isOverdue,
  quoteToInvoiceDraft,
  type InvoiceLineInput,
} from "./math";
import { sendInvoiceCopyEmail, sendInvoiceEmail, sendInvoiceSms, sendPaymentReceiptEmail, type DeliveryOutcome } from "./notify";
import { expireOpenInvoiceCheckout } from "./public";
import { formatInvoiceNumber, parseInvoiceSettings, type InvoicePaymentMethod } from "./settings";

export interface InvoiceWriteInput {
  companyId: string;
  contactId?: string | null;
  customerAccountId?: string | null;
  title?: string | null;
  lines: InvoiceLineInput[];
  /** Defaults to the brand's rate (HST 13%). 0 for a tax-exempt invoice. */
  taxRateBps?: number | null;
  /** Money already received (e.g. a deposit) — reduces the balance, not the total. */
  creditCents?: number | null;
  /** Explicit due date (YYYY-MM-DD). Otherwise issue date + terms, set on send. */
  dueDate?: string | null;
  paymentTermsDays?: number | null;
  notes?: string | null;
  internalNotes?: string | null;
  /** Overrides the bill-to address for this invoice only. */
  billToAddress?: string | null;
  quoteId?: string | null;
  bookingId?: string | null;
}

const EDITABLE_STATUSES = ["draft", "sent", "viewed"];

function genPublicToken(): string {
  return randomBytes(16).toString("hex");
}

async function assertAccountInOrganization(ctx: TenantServiceContext, accountId: string | null | undefined): Promise<void> {
  if (!accountId) return;
  const { data, error } = await ctx.supabase
    .from("customer_accounts")
    .select("id")
    .eq("organization_id", ctx.organizationId)
    .eq("id", accountId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new InvoiceValidationError("Business account does not belong to this organization.");
}

/** A contact's business account, so an invoice for a marina's dock manager bills the marina. */
async function accountOfContact(ctx: TenantServiceContext, contactId: string | null | undefined): Promise<string | null> {
  if (!contactId) return null;
  const { data } = await ctx.supabase
    .from("contacts")
    .select("customer_account_id")
    .eq("organization_id", ctx.organizationId)
    .eq("id", contactId)
    .maybeSingle();
  return data?.customer_account_id ?? null;
}

async function termsFor(ctx: TenantServiceContext, accountId: string | null, fallback: number): Promise<number> {
  if (!accountId) return fallback;
  const { data } = await ctx.supabase
    .from("customer_accounts")
    .select("payment_terms_days")
    .eq("organization_id", ctx.organizationId)
    .eq("id", accountId)
    .maybeSingle();
  return data?.payment_terms_days ?? fallback;
}

/**
 * Drafts may be half-finished (no lines yet, a line with no description); everything
 * is checked again by `sendBlockers` before an invoice can go out.
 */
function validateLines(lines: InvoiceLineInput[], draft: boolean): void {
  if (!draft && lines.length === 0) throw new InvoiceValidationError("An invoice needs at least one line.");
  if (lines.length > 100) throw new InvoiceValidationError("An invoice can have at most 100 lines.");
  for (const l of lines) {
    if (!draft && (!l.label || !l.label.trim())) throw new InvoiceValidationError("Every line needs a description.");
    if (!Number.isFinite(l.quantity) || l.quantity <= 0) throw new InvoiceValidationError("Quantities must be above zero.");
    if (!Number.isInteger(Math.round(l.unitPriceCents)) || Math.abs(l.unitPriceCents) > 100_000_000) {
      throw new InvoiceValidationError("A line price is out of range.");
    }
  }
}

function priced(lines: InvoiceLineInput[], taxRateBps: number, creditCents: number, draft = false) {
  validateLines(lines, draft);
  const totals = computeInvoiceTotals(lines, taxRateBps);
  if (totals.subtotalCents < 0) throw new InvoiceValidationError("The invoice total can't be negative.");
  if (creditCents < 0) throw new InvoiceValidationError("A credit can't be negative.");
  // A draft may get its credit before its lines; sending checks it.
  if (!draft && creditCents > totals.totalCents) {
    throw new InvoiceValidationError("The credit (deposit already paid) is more than the invoice total.");
  }
  return {
    line_items: toJson(totals.lineItems),
    subtotal_cents: totals.subtotalCents,
    tax_rate_bps: totals.taxRateBps,
    tax_cents: totals.taxCents,
    total_cents: totals.totalCents,
    credit_cents: creditCents,
  };
}

/** What still stops this invoice going out (empty when it's ready). Drafts can be saved half-done. */
export function sendBlockers(inv: Pick<InvoiceRow, "contact_id" | "customer_account_id" | "line_items" | "total_cents" | "credit_cents">): string[] {
  const out: string[] = [];
  if (!inv.contact_id && !inv.customer_account_id) out.push("choose who it's for");
  const lines = Array.isArray(inv.line_items) ? (inv.line_items as Array<{ label?: unknown }>) : [];
  if (lines.length === 0) out.push("add at least one line");
  else {
    const blank = lines.map((l, i) => (typeof l.label === "string" && l.label.trim() ? null : i + 1)).filter((n): n is number => n !== null);
    if (blank.length) out.push(`give line${blank.length === 1 ? "" : "s"} ${blank.join(", ")} a description`);
  }
  if (lines.length > 0 && inv.total_cents <= 0) out.push("add a price (it totals $0)");
  if (inv.credit_cents > inv.total_cents && inv.total_cents > 0) out.push("the deposit / credit is more than the total");
  return out;
}

export async function getInvoice(ctx: TenantServiceContext, invoiceId: string): Promise<InvoiceRow | null> {
  const { data, error } = await ctx.supabase
    .from("invoices")
    .select("*")
    .eq("organization_id", ctx.organizationId)
    .eq("id", invoiceId)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

async function requireInvoice(ctx: TenantServiceContext, invoiceId: string): Promise<InvoiceRow> {
  const invoice = await getInvoice(ctx, invoiceId);
  if (!invoice) throw new InvoiceNotFoundError();
  return invoice;
}

// ── Create / edit ────────────────────────────────────────────────────────────

export async function createInvoice(ctx: TenantServiceContext, input: InvoiceWriteInput): Promise<InvoiceRow> {
  await assertCompanyInOrganization(ctx, input.companyId);
  await assertContactInOrganization(ctx, input.contactId ?? undefined);
  await assertAccountInOrganization(ctx, input.customerAccountId ?? undefined);
  await assertBookingInOrganization(ctx, input.bookingId ?? undefined);

  const company = await loadCompanyForInvoice(ctx.supabase, ctx.organizationId, input.companyId);
  if (!company) throw new InvoiceValidationError("Company not found.");
  const settings = parseInvoiceSettings(company.invoice_settings);

  const contactId = input.contactId ?? null;
  // Explicit null = "bill the person, not their business"; undefined = use the contact's account.
  const accountId =
    input.customerAccountId !== undefined ? input.customerAccountId : await accountOfContact(ctx, contactId);
  // New invoices are drafts, which may not have a customer yet — sending requires one.

  const terms = input.paymentTermsDays ?? (await termsFor(ctx, accountId, settings.paymentTermsDays));
  const money = priced(input.lines, input.taxRateBps ?? settings.taxRateBps, input.creditCents ?? 0, true);
  const billTo = await resolveBillTo(ctx.supabase, ctx.organizationId, { contactId, customerAccountId: accountId }, input.billToAddress);

  const { data, error } = await ctx.supabase
    .from("invoices")
    .insert({
      organization_id: ctx.organizationId,
      company_id: input.companyId,
      contact_id: contactId,
      customer_account_id: accountId,
      quote_id: input.quoteId ?? null,
      booking_id: input.bookingId ?? null,
      public_token: genPublicToken(),
      status: "draft",
      title: input.title?.trim() || null,
      ...money,
      balance_due_cents: money.total_cents - money.credit_cents,
      due_date: input.dueDate ?? null,
      payment_terms_days: terms,
      bill_to: toJson(billTo),
      notes: input.notes?.trim() || null,
      internal_notes: input.internalNotes?.trim() || null,
      created_by: ctx.actorProfileId,
    })
    .select("*")
    .single();

  if (error) {
    // The partial unique indexes: this quote / booking already has a live invoice.
    if ((error as { code?: string }).code === "23505") {
      const existing = await liveInvoiceFor(ctx, { quoteId: input.quoteId, bookingId: input.bookingId });
      throw new InvoiceConflictError("This is already invoiced.", existing);
    }
    throw error;
  }

  await recordInvoiceEvent(ctx.supabase, {
    organizationId: ctx.organizationId,
    invoiceId: data.id,
    eventType: "created",
    actorProfileId: ctx.actorProfileId,
    metadata: { totalCents: data.total_cents, quoteId: data.quote_id, bookingId: data.booking_id },
  });
  return data;
}

export type InvoiceUpdateInput = Partial<Omit<InvoiceWriteInput, "companyId" | "quoteId" | "bookingId">>;

export async function updateInvoice(ctx: TenantServiceContext, invoiceId: string, input: InvoiceUpdateInput): Promise<InvoiceRow> {
  const existing = await requireInvoice(ctx, invoiceId);
  if (!EDITABLE_STATUSES.includes(existing.status) || existing.amount_paid_cents > 0 || existing.pending_payment_cents > 0) {
    throw new InvoiceConflictError(
      existing.status === "void"
        ? "This invoice is void."
        : "This invoice has payments against it and can't be edited. Void it and issue a new one, or record a refund.",
    );
  }
  await assertContactInOrganization(ctx, input.contactId ?? undefined);
  await assertAccountInOrganization(ctx, input.customerAccountId ?? undefined);

  const contactId = input.contactId !== undefined ? input.contactId : existing.contact_id;
  const accountId = input.customerAccountId !== undefined ? input.customerAccountId : existing.customer_account_id;
  const draft = existing.status === "draft";
  if (!draft && !contactId && !accountId) {
    throw new InvoiceValidationError("Choose who the invoice is for — a contact or a business account.");
  }

  const lines = input.lines ?? (existing.line_items as unknown as InvoiceLineInput[]);
  const money = priced(
    lines,
    input.taxRateBps ?? existing.tax_rate_bps,
    input.creditCents ?? existing.credit_cents,
    draft,
  );
  // Keep the current address only while the customer is unchanged; a new customer
  // brings their own address (unless one is typed in for this invoice).
  const sameCustomer = contactId === existing.contact_id && accountId === existing.customer_account_id;
  const currentBillTo = readBillTo(existing.bill_to);
  const billTo = await resolveBillTo(
    ctx.supabase,
    ctx.organizationId,
    { contactId, customerAccountId: accountId },
    input.billToAddress !== undefined ? input.billToAddress : sameCustomer ? currentBillTo.address : null,
  );

  // A sent invoice's due date follows its terms if only the terms changed.
  let dueDate = input.dueDate !== undefined ? input.dueDate : existing.due_date;
  if (input.dueDate === undefined && input.paymentTermsDays != null && existing.issue_date) {
    dueDate = addDays(existing.issue_date, input.paymentTermsDays);
  }

  const { data, error } = await ctx.supabase
    .from("invoices")
    .update({
      contact_id: contactId,
      customer_account_id: accountId,
      title: input.title !== undefined ? input.title?.trim() || null : existing.title,
      ...money,
      balance_due_cents: money.total_cents - money.credit_cents,
      due_date: dueDate,
      payment_terms_days: input.paymentTermsDays ?? existing.payment_terms_days,
      bill_to: toJson(billTo),
      notes: input.notes !== undefined ? input.notes?.trim() || null : existing.notes,
      internal_notes: input.internalNotes !== undefined ? input.internalNotes?.trim() || null : existing.internal_notes,
    })
    .eq("organization_id", ctx.organizationId)
    .eq("id", invoiceId)
    .select("*")
    .single();
  if (error) throw error;

  // The customer may have the pay page open on the old amount.
  await expireOpenInvoiceCheckout(invoiceId);
  await recordInvoiceEvent(ctx.supabase, {
    organizationId: ctx.organizationId,
    invoiceId,
    eventType: "edited",
    actorProfileId: ctx.actorProfileId,
    metadata: { fromTotalCents: existing.total_cents, toTotalCents: data.total_cents },
  });
  return data.status === "draft" ? data : refreshInvoiceBalance(ctx.supabase, invoiceId);
}

// ── Conversions ──────────────────────────────────────────────────────────────

async function liveInvoiceFor(
  ctx: TenantServiceContext,
  ref: { quoteId?: string | null; bookingId?: string | null },
): Promise<string | null> {
  if (!ref.quoteId && !ref.bookingId) return null;
  let q = ctx.supabase.from("invoices").select("id").eq("organization_id", ctx.organizationId).neq("status", "void");
  q = ref.quoteId ? q.eq("quote_id", ref.quoteId) : q.eq("booking_id", ref.bookingId as string);
  const { data } = await q.limit(1).maybeSingle();
  return data?.id ?? null;
}

/** The message for invoicing a quote the customer hasn't approved. */
export const QUOTE_NOT_APPROVED_MESSAGE =
  "This quote hasn't been approved by the customer yet. Send it to them so they can approve it, then create the invoice.";

/**
 * A quote may be invoiced only once the customer has approved it: status approved
 * (or later — deposit paid, completed) AND a frozen approval snapshot to bill from.
 */
export function isQuoteApprovedForInvoicing(quote: {
  status: string;
  approved_at: string | null;
  approved_line_items: unknown;
}): boolean {
  const approvedStatus = quote.status === "approved" || quote.status === "deposit_paid" || quote.status === "completed";
  const hasSnapshot = Array.isArray(quote.approved_line_items) && quote.approved_line_items.length > 0;
  return approvedStatus && Boolean(quote.approved_at) && hasSnapshot;
}

/**
 * Quote → draft invoice: the lines the customer approved, the quote's tax rate,
 * and the deposit already paid as a credit so only the balance is asked for. Also
 * links the job booked off that quote, so the invoice shows on the booking too.
 */
export async function createInvoiceFromQuote(
  ctx: TenantServiceContext,
  quoteId: string,
  opts: { bookingId?: string | null } = {},
): Promise<InvoiceRow> {
  const { data: quote, error } = await ctx.supabase
    .from("quotes")
    .select("*")
    .eq("organization_id", ctx.organizationId)
    .eq("id", quoteId)
    .maybeSingle();
  if (error) throw error;
  if (!quote) throw new InvoiceNotFoundError("Quote not found.");
  // Only what the customer agreed to can be billed. An unapproved quote has no
  // frozen selection, and its live lines re-price whenever the price list changes —
  // invoicing those would bill a number nobody accepted.
  if (quote.status === "cancelled" || quote.status === "expired") {
    throw new InvoiceConflictError(
      `This quote is ${quote.status === "cancelled" ? "void" : "expired"}. Make a new version and have the customer approve it before invoicing.`,
      null,
      "quote_not_approved",
    );
  }
  if (!isQuoteApprovedForInvoicing(quote)) {
    throw new InvoiceConflictError(QUOTE_NOT_APPROVED_MESSAGE, null, "quote_not_approved");
  }
  if (!quote.company_id) throw new InvoiceValidationError("This quote has no company to invoice from.");
  if (!quote.contact_id) throw new InvoiceValidationError("This quote has no customer to invoice.");

  const existing = await liveInvoiceFor(ctx, { quoteId });
  if (existing) throw new InvoiceConflictError("This quote is already invoiced.", existing);

  let bookingId = opts.bookingId ?? null;
  if (!bookingId) {
    const { data: booking } = await ctx.supabase
      .from("bookings")
      .select("id")
      .eq("organization_id", ctx.organizationId)
      .eq("quote_id", quoteId)
      .neq("status", "cancelled")
      .order("scheduled_for", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (booking && !(await liveInvoiceFor(ctx, { bookingId: booking.id }))) bookingId = booking.id;
  }

  const draft = quoteToInvoiceDraft({
    title: quote.title,
    quote_number: quote.quote_number,
    approved_line_items: quote.approved_line_items,
    approved_subtotal_cents: quote.approved_subtotal_cents,
    tax_rate_bps: quote.tax_rate_bps,
    approved_deposit_cents: quote.approved_deposit_cents,
    deposit_paid_at: quote.deposit_paid_at,
  });

  return createInvoiceWithJobExpenses(ctx, {
    companyId: quote.company_id,
    contactId: quote.contact_id,
    title: draft.title,
    lines: draft.lines,
    taxRateBps: draft.taxRateBps,
    creditCents: draft.creditCents,
    quoteId,
    bookingId,
  });
}

/**
 * createInvoice for a job: the job's billable expenses (receipts marked "bill to the
 * customer") are added as lines at cost before tax, then marked billed on this invoice.
 * Voiding the invoice releases them for the next one.
 */
async function createInvoiceWithJobExpenses(ctx: TenantServiceContext, input: InvoiceWriteInput): Promise<InvoiceRow> {
  const extra = input.bookingId ? await billableExpenseLines(ctx, input.bookingId) : { ids: [], lines: [] };
  const invoice = await createInvoice(ctx, { ...input, lines: [...input.lines, ...extra.lines] });
  await markExpensesBilled(ctx, invoice.id, extra.ids);
  return invoice;
}

/**
 * Booking → draft invoice. A booking made off a quote invoices that quote (its
 * prices are already agreed); a stand-alone booking becomes a one-line draft at
 * $0 for the owner to price before sending.
 */
export async function createInvoiceFromBooking(ctx: TenantServiceContext, bookingId: string): Promise<InvoiceRow> {
  const { data: booking, error } = await ctx.supabase
    .from("bookings")
    .select("*")
    .eq("organization_id", ctx.organizationId)
    .eq("id", bookingId)
    .maybeSingle();
  if (error) throw error;
  if (!booking) throw new InvoiceNotFoundError("Booking not found.");

  const existing = await liveInvoiceFor(ctx, { bookingId });
  if (existing) throw new InvoiceConflictError("This booking is already invoiced.", existing);

  // Set when the job's quote was never approved: its prices weren't agreed, so the
  // job is invoiced as an unpriced $0 draft for the owner to price — never from the
  // quote's live (re-pricing) lines, and never auto-sent (see invoices/auto.ts).
  let unapprovedQuote = false;
  if (booking.quote_id) {
    const quoteInvoice = await liveInvoiceFor(ctx, { quoteId: booking.quote_id });
    if (quoteInvoice) throw new InvoiceConflictError("The quote for this booking is already invoiced.", quoteInvoice);
    try {
      return await createInvoiceFromQuote(ctx, booking.quote_id, { bookingId });
    } catch (err) {
      if (!(err instanceof InvoiceConflictError && err.code === "quote_not_approved")) throw err;
      unapprovedQuote = true;
    }
  }
  if (!booking.company_id) throw new InvoiceValidationError("This booking has no company to invoice from.");
  if (!booking.contact_id) throw new InvoiceValidationError("This booking has no customer to invoice.");
  if (unapprovedQuote) {
    return createInvoiceWithJobExpenses(ctx, {
      companyId: booking.company_id,
      contactId: booking.contact_id,
      title: booking.title,
      lines: [{ label: booking.title, description: booking.description ?? null, quantity: 1, unitPriceCents: 0 }],
      creditCents: 0,
      bookingId,
    });
  }

  // A visit of a recurring job invoices the series' price; a service booked online invoices
  // the price it was booked at, crediting a paid deposit; anything else starts at $0.
  const seriesLines = booking.recurring_job_id ? await seriesLineItems(ctx, booking.recurring_job_id) : [];
  const bookedPrice = booking.price_cents && booking.price_cents > 0 ? booking.price_cents : 0;
  const depositPaid = booking.deposit_paid_at && booking.deposit_cents ? booking.deposit_cents : 0;
  return createInvoiceWithJobExpenses(ctx, {
    companyId: booking.company_id,
    contactId: booking.contact_id,
    title: booking.title,
    lines: seriesLines.length
      ? seriesLines.map((l) => ({ label: l.label, description: null, quantity: l.quantity, unitPriceCents: l.unitPriceCents }))
      : [{ label: booking.title, description: booking.description ?? null, quantity: 1, unitPriceCents: bookedPrice }],
    // The deposit was its own (tax-free) invoice; it comes off the balance here.
    creditCents: !seriesLines.length && bookedPrice > 0 ? Math.min(depositPaid, bookedPrice) : 0,
    bookingId,
  });
}

// ── Send ─────────────────────────────────────────────────────────────────────

export interface SendInvoiceOptions {
  /** Email the invoice (with the PDF attached). Default true. */
  email?: boolean;
  /** Also text the pay link to the contact's phone. Default false. */
  sms?: boolean;
}

export interface SendInvoiceResult {
  invoice: InvoiceRow;
  email: DeliveryOutcome | null;
  sms: DeliveryOutcome | null;
  /** The copy to the brand's inbox, when "Send me a copy" is on. */
  copy: DeliveryOutcome | null;
  publicUrl: string;
}

/**
 * Issue the invoice: allocate its number, stamp the issue and due dates, freeze
 * who it's billed to, and deliver it. Re-sending an open invoice re-delivers it
 * without changing its number or dates.
 *
 * Delivery never throws (same contract as quotes): the invoice is issued and
 * payable whatever the mail provider did, and the outcome rides on the result.
 */
export async function sendInvoice(
  ctx: TenantServiceContext,
  invoiceId: string,
  opts: SendInvoiceOptions = {},
): Promise<SendInvoiceResult> {
  const existing = await requireInvoice(ctx, invoiceId);
  if (existing.status === "void") throw new InvoiceConflictError("This invoice is void.");
  if (existing.status === "paid") throw new InvoiceConflictError("This invoice is already paid.");
  const blockers = sendBlockers(existing);
  if (blockers.length) throw new InvoiceValidationError(`Before sending: ${blockers.join("; ")}.`);

  const company = await loadCompanyForInvoice(ctx.supabase, ctx.organizationId, existing.company_id);
  if (!company) throw new InvoiceValidationError("Company not found.");
  const settings = parseInvoiceSettings(company.invoice_settings);

  let invoice = existing;
  if (existing.status === "draft") {
    const allocated = existing.invoice_number
      ? null
      : await ctx.supabase.rpc("next_invoice_number", { p_company_id: existing.company_id });
    if (allocated?.error) throw allocated.error;
    const invoiceNumber = existing.invoice_number ?? formatInvoiceNumber(settings, String(allocated?.data));

    const issueDate = existing.issue_date ?? todayFor(company);
    const dueDate = existing.due_date ?? addDays(issueDate, existing.payment_terms_days);
    const billTo = await resolveBillTo(
      ctx.supabase,
      ctx.organizationId,
      { contactId: existing.contact_id, customerAccountId: existing.customer_account_id },
      readBillTo(existing.bill_to).address,
    );

    const { data, error } = await ctx.supabase
      .from("invoices")
      .update({
        status: "sent",
        invoice_number: invoiceNumber,
        issue_date: issueDate,
        due_date: dueDate,
        sent_at: new Date().toISOString(),
        bill_to: toJson(billTo),
      })
      .eq("organization_id", ctx.organizationId)
      .eq("id", invoiceId)
      .eq("status", "draft")
      .select("*")
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new InvoiceConflictError("This invoice was changed by someone else — reload and try again.");
    // A deposit can cover the whole thing: derive the real status now.
    invoice = await refreshInvoiceBalance(ctx.supabase, invoiceId);

    await recordInvoiceEvent(ctx.supabase, {
      organizationId: ctx.organizationId,
      invoiceId,
      eventType: "sent",
      actorProfileId: ctx.actorProfileId,
      metadata: { invoiceNumber, dueDate },
    });
    await emitInvoiceTrigger(ctx.supabase, {
      organizationId: ctx.organizationId,
      companyId: invoice.company_id,
      contactId: invoice.contact_id,
      invoiceId,
      quoteId: invoice.quote_id,
      eventType: "invoice.sent",
    });
  } else {
    await recordInvoiceEvent(ctx.supabase, {
      organizationId: ctx.organizationId,
      invoiceId,
      eventType: "resent",
      actorProfileId: ctx.actorProfileId,
    });
  }

  const email = opts.email === false ? null : await sendInvoiceEmail(invoiceId);
  const sms = opts.sms ? await sendInvoiceSms(ctx, invoiceId) : null;
  // "Send me a copy" (Settings → Invoices): the same email + PDF, to the brand's own inbox.
  const copy = settings.sendCopy ? await sendInvoiceCopyEmail(invoiceId, settings.copyEmail, { email, sms }) : null;
  return { invoice, email, sms, copy, publicUrl: invoicePublicUrl(company, invoice.public_token) };
}

// ── Void ─────────────────────────────────────────────────────────────────────

export async function voidInvoice(ctx: TenantServiceContext, invoiceId: string, reason?: string | null): Promise<InvoiceRow> {
  const existing = await requireInvoice(ctx, invoiceId);
  if (existing.status === "void") throw new InvoiceConflictError("This invoice is already void.");
  if (existing.amount_paid_cents > 0 || existing.pending_payment_cents > 0) {
    throw new InvoiceConflictError(
      "This invoice has payments against it. Refund or remove them first, then void it.",
    );
  }
  const { data, error } = await ctx.supabase
    .from("invoices")
    .update({ status: "void", voided_at: new Date().toISOString(), void_reason: reason?.trim() || null })
    .eq("organization_id", ctx.organizationId)
    .eq("id", invoiceId)
    .select("*")
    .single();
  if (error) throw error;
  await expireOpenInvoiceCheckout(invoiceId);
  await recordInvoiceEvent(ctx.supabase, {
    organizationId: ctx.organizationId,
    invoiceId,
    eventType: "voided",
    actorProfileId: ctx.actorProfileId,
    metadata: { reason: reason ?? null },
  });
  return data;
}

// ── Payments recorded by staff ───────────────────────────────────────────────

export const OFFLINE_METHODS: InvoicePaymentMethod[] = ["etransfer", "cheque", "cash", "other", "card", "bank_debit"];

export interface RecordPaymentInput {
  amountCents: number;
  method: InvoicePaymentMethod;
  /** When the money arrived (ISO). Defaults to now. */
  receivedAt?: string | null;
  /** e-Transfer reference, cheque number… */
  reference?: string | null;
  notes?: string | null;
  /** Email the customer a receipt. Default true. */
  sendReceipt?: boolean;
}

/**
 * Record money that arrived outside the pay page: an e-Transfer, a cheque, cash,
 * or a card taken on a terminal. Capped at the balance so a typo can't record an
 * overpayment.
 */
export async function recordPayment(
  ctx: TenantServiceContext,
  invoiceId: string,
  input: RecordPaymentInput,
): Promise<{ invoice: InvoiceRow; payment: InvoicePaymentRow; receipt: DeliveryOutcome | null }> {
  const invoice = await requireInvoice(ctx, invoiceId);
  if (invoice.status === "draft") throw new InvoiceConflictError("Send the invoice before recording a payment against it.");
  if (invoice.status === "void") throw new InvoiceConflictError("This invoice is void.");
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new InvoiceValidationError("Enter the amount received.");
  }
  const outstanding = invoice.balance_due_cents - invoice.pending_payment_cents;
  if (input.amountCents > outstanding) {
    throw new InvoiceValidationError(
      outstanding <= 0
        ? "Nothing is owing on this invoice."
        : `That's more than the ${(outstanding / 100).toFixed(2)} still owing.`,
    );
  }

  const { data: payment, error } = await ctx.supabase
    .from("invoice_payments")
    .insert({
      organization_id: ctx.organizationId,
      company_id: invoice.company_id,
      invoice_id: invoiceId,
      amount_cents: input.amountCents,
      method: input.method,
      status: "succeeded",
      reference: input.reference?.trim() || null,
      notes: input.notes?.trim() || null,
      received_at: input.receivedAt ?? new Date().toISOString(),
      recorded_by: ctx.actorProfileId,
    })
    .select("*")
    .single();
  if (error) throw error;

  const updated = await refreshInvoiceBalance(ctx.supabase, invoiceId);
  await expireOpenInvoiceCheckout(invoiceId);
  await recordInvoiceEvent(ctx.supabase, {
    organizationId: ctx.organizationId,
    invoiceId,
    eventType: "payment_recorded",
    actorProfileId: ctx.actorProfileId,
    metadata: { paymentId: payment.id, amountCents: payment.amount_cents, method: payment.method },
  });

  const receipt = input.sendReceipt === false ? null : await sendPaymentReceiptEmail(payment.id);
  return { invoice: updated, payment, receipt };
}

/**
 * Remove a payment recorded by mistake. Stripe payments can't be removed here —
 * they're real money; refund them in Stripe and the webhook records it.
 */
export async function removePayment(ctx: TenantServiceContext, invoiceId: string, paymentId: string): Promise<InvoiceRow> {
  await requireInvoice(ctx, invoiceId);
  const { data: payment, error } = await ctx.supabase
    .from("invoice_payments")
    .select("*")
    .eq("organization_id", ctx.organizationId)
    .eq("invoice_id", invoiceId)
    .eq("id", paymentId)
    .maybeSingle();
  if (error) throw error;
  if (!payment) throw new InvoiceNotFoundError("Payment not found.");
  if (payment.stripe_payment_intent_id) {
    throw new InvoiceConflictError("Online payments can't be removed — refund it in Stripe and it will update here.");
  }
  if (payment.status !== "succeeded") throw new InvoiceConflictError("This payment has already been removed.");
  const { error: delErr } = await ctx.supabase
    .from("invoice_payments")
    .update({ status: "failed", failure_reason: "Removed — recorded by mistake" })
    .eq("organization_id", ctx.organizationId)
    .eq("id", paymentId);
  if (delErr) throw delErr;

  const updated = await refreshInvoiceBalance(ctx.supabase, invoiceId);
  await recordInvoiceEvent(ctx.supabase, {
    organizationId: ctx.organizationId,
    invoiceId,
    eventType: "payment_removed",
    actorProfileId: ctx.actorProfileId,
    metadata: { paymentId, amountCents: payment.amount_cents, method: payment.method },
  });
  return updated;
}

// ── Reads ────────────────────────────────────────────────────────────────────

export type InvoiceListFilter = "all" | "draft" | "open" | "overdue" | "paid" | "void";

export interface ListInvoicesOptions {
  filter?: InvoiceListFilter;
  companyId?: string;
  contactId?: string;
  customerAccountId?: string;
  quoteId?: string;
  bookingId?: string;
  limit?: number;
}

export interface InvoiceListItem extends InvoiceRow {
  overdue: boolean;
  bill_to_name: string;
}

export interface InvoiceListResult {
  invoices: InvoiceListItem[];
  summary: { outstandingCents: number; overdueCents: number; overdueCount: number; clearingCents: number };
}

export async function listInvoices(ctx: TenantServiceContext, opts: ListInvoicesOptions = {}): Promise<InvoiceListResult> {
  const filter = opts.filter ?? "all";
  let q = ctx.supabase.from("invoices").select("*").eq("organization_id", ctx.organizationId);
  if (opts.companyId) q = q.eq("company_id", opts.companyId);
  if (opts.contactId) q = q.eq("contact_id", opts.contactId);
  if (opts.customerAccountId) q = q.eq("customer_account_id", opts.customerAccountId);
  if (opts.quoteId) q = q.eq("quote_id", opts.quoteId);
  if (opts.bookingId) q = q.eq("booking_id", opts.bookingId);
  if (filter === "draft") q = q.eq("status", "draft");
  if (filter === "paid") q = q.eq("status", "paid");
  if (filter === "void") q = q.eq("status", "void");
  if (filter === "open" || filter === "overdue") q = q.in("status", ["sent", "viewed", "partially_paid"]);

  const { data, error } = await q
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(opts.limit ?? 100, 1), 500));
  if (error) throw error;

  const today = todayFor(null);
  let invoices: InvoiceListItem[] = (data ?? []).map((inv) => ({
    ...inv,
    overdue: isOverdue(inv, today),
    bill_to_name: !inv.contact_id && !inv.customer_account_id ? "No customer yet" : readBillTo(inv.bill_to).name,
  }));
  if (filter === "overdue") invoices = invoices.filter((i) => i.overdue);

  // Summary over every open invoice in scope, not just this page.
  let sq = ctx.supabase
    .from("invoices")
    .select("status, due_date, balance_due_cents, pending_payment_cents")
    .eq("organization_id", ctx.organizationId)
    .in("status", ["sent", "viewed", "partially_paid"]);
  if (opts.companyId) sq = sq.eq("company_id", opts.companyId);
  if (opts.customerAccountId) sq = sq.eq("customer_account_id", opts.customerAccountId);
  if (opts.contactId) sq = sq.eq("contact_id", opts.contactId);
  const { data: open } = await sq.limit(5000);
  const summary = { outstandingCents: 0, overdueCents: 0, overdueCount: 0, clearingCents: 0 };
  for (const inv of open ?? []) {
    summary.outstandingCents += inv.balance_due_cents;
    summary.clearingCents += inv.pending_payment_cents;
    if (isOverdue(inv, today)) {
      summary.overdueCents += inv.balance_due_cents;
      summary.overdueCount += 1;
    }
  }
  return { invoices, summary };
}

export interface InvoiceDetail {
  invoice: InvoiceRow & { overdue: boolean };
  payments: InvoicePaymentRow[];
  events: Array<{ id: string; event_type: string; metadata: unknown; created_at: string }>;
  publicUrl: string;
  /** Which online methods the brand can actually take right now. */
  online: { card: boolean; bankDebit: boolean; stripeReady: boolean };
}

export async function getInvoiceDetail(ctx: TenantServiceContext, invoiceId: string): Promise<InvoiceDetail> {
  const invoice = await requireInvoice(ctx, invoiceId);
  const [company, { data: payments }, { data: events }] = await Promise.all([
    loadCompanyForInvoice(ctx.supabase, ctx.organizationId, invoice.company_id),
    ctx.supabase
      .from("invoice_payments")
      .select("*")
      .eq("organization_id", ctx.organizationId)
      .eq("invoice_id", invoiceId)
      .order("received_at", { ascending: false }),
    ctx.supabase
      .from("invoice_events")
      .select("id, event_type, metadata, created_at")
      .eq("organization_id", ctx.organizationId)
      .eq("invoice_id", invoiceId)
      .order("created_at", { ascending: false })
      .limit(100),
  ]);
  const settings = parseInvoiceSettings(company?.invoice_settings ?? null);
  const stripeReady = Boolean(company?.stripe_connected_account_id && company?.stripe_charges_enabled);
  return {
    invoice: { ...invoice, overdue: isOverdue(invoice, todayFor(company)) },
    payments: payments ?? [],
    events: events ?? [],
    publicUrl: invoicePublicUrl(company, invoice.public_token),
    online: { card: stripeReady && settings.acceptCard, bankDebit: stripeReady && settings.acceptBankDebit, stripeReady },
  };
}
