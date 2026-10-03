/**
 * SANCTIONED EXCEPTION (service role): invoice delivery.
 *
 * Callers are (a) authed dashboard routes that have already resolved the invoice
 * under RLS, (b) the Stripe Connect webhook (no session — the event signature is
 * the credential) and (c) the reminder job. Every read here is by an invoice /
 * payment id the caller already holds, and every follow-up query is pinned to that
 * invoice's own organization_id + company_id, so no request input can reach
 * another tenant's rows. Listed in docs/EMPIREVU_RUNBOOK.md (service-role surfaces).
 *
 * Contract: NOTHING here throws. The invoice is issued / the payment recorded
 * before any of this runs; a mail or SMS failure is reported in the return value
 * and the invoice audit trail, never by failing the operation that preceded it.
 *
 * Invoices and receipts are TRANSACTIONAL messages (CASL s.6(6): they complete a
 * transaction the customer already agreed to), so they don't need marketing
 * consent — but an explicit SMS opt-out (STOP) is always honoured.
 */
import { sendEmail } from "@/server/outbound/email";
import type { TenantServiceContext } from "@/server/services/shared";
import { deliverMessage } from "@/server/services/workflow-engine/messaging";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { loadCompanyForInvoice, recordInvoiceEvent, type CompanyForInvoice, type Db, type InvoiceRow } from "./common";
import { buildInvoiceDocument, formatMoney } from "./document";
import { renderInvoiceReminder, renderInvoiceSent, renderPaymentReceipt, renderStatement } from "./emails";
import { renderInvoicePdf, renderStatementPdf } from "./pdf";
import { buildStatement } from "./statement";

export interface DeliveryOutcome {
  delivered: boolean;
  /** Operator-facing, present only when it did not go. */
  reason: string | null;
  to?: string | null;
}

const admin = (): Db => createSupabaseAdminClient() as unknown as Db;

interface Bundle {
  invoice: InvoiceRow;
  company: CompanyForInvoice | null;
  contact: { first_name: string | null; phone: string | null; email: string | null; sms_opt_out_at: string | null } | null;
}

async function loadBundle(db: Db, invoiceId: string): Promise<Bundle | null> {
  const { data: invoice } = await db.from("invoices").select("*").eq("id", invoiceId).maybeSingle();
  if (!invoice) return null;
  const [company, { data: contact }] = await Promise.all([
    loadCompanyForInvoice(db, invoice.organization_id, invoice.company_id),
    invoice.contact_id
      ? db
          .from("contacts")
          .select("first_name, phone, email, sms_opt_out_at")
          .eq("organization_id", invoice.organization_id)
          .eq("id", invoice.contact_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  return { invoice, company, contact: contact ?? null };
}

function firstName(contact: Bundle["contact"]): string | null {
  const n = contact?.first_name?.trim();
  return n && n !== "Lead" ? n : null;
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function pdfName(invoice: InvoiceRow): string {
  return `${(invoice.invoice_number ?? "invoice").replace(/[^A-Za-z0-9-]/g, "")}.pdf`;
}

/** Email the invoice with its PDF attached. */
export async function sendInvoiceEmail(invoiceId: string): Promise<DeliveryOutcome> {
  const db = admin();
  try {
    const b = await loadBundle(db, invoiceId);
    if (!b) return { delivered: false, reason: "Invoice not found." };
    const doc = buildInvoiceDocument(b.invoice, b.company);
    const to = doc.billTo.email;
    if (!to) {
      await recordInvoiceEvent(db, { organizationId: b.invoice.organization_id, invoiceId, eventType: "email_skipped", metadata: { reason: "no email address" } });
      return { delivered: false, reason: "No email address on file — share the invoice link or text it instead." };
    }
    const mail = renderInvoiceSent(doc, { firstName: firstName(b.contact) });
    const pdf = await renderInvoicePdf(doc);
    await sendEmail({
      to,
      subject: mail.subject,
      body: mail.text,
      html: mail.html,
      fromName: mail.fromName ?? undefined,
      replyTo: mail.replyTo ?? undefined,
      attachments: [{ filename: pdfName(b.invoice), content: base64(pdf) }],
    });
    await recordInvoiceEvent(db, { organizationId: b.invoice.organization_id, invoiceId, eventType: "email_sent", metadata: { to } });
    return { delivered: true, reason: null, to };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[invoices] invoice email failed for ${invoiceId}:`, reason);
    await safeEvent(db, invoiceId, "email_failed", { reason });
    return { delivered: false, reason };
  }
}

/** Text the pay link to the contact's phone, from the brand's own number when it has one. */
export async function sendInvoiceSms(ctx: Pick<TenantServiceContext, "organizationId" | "actorProfileId">, invoiceId: string): Promise<DeliveryOutcome> {
  const db = admin();
  try {
    const b = await loadBundle(db, invoiceId);
    if (!b || b.invoice.organization_id !== ctx.organizationId) return { delivered: false, reason: "Invoice not found." };
    const phone = b.contact?.phone?.trim() || null;
    if (!phone) return { delivered: false, reason: "No mobile number on file for this contact." };
    if (b.contact?.sms_opt_out_at) return { delivered: false, reason: "This contact has opted out of texts." };
    const doc = buildInvoiceDocument(b.invoice, b.company);
    const name = firstName(b.contact);
    const body =
      `${name ? `Hi ${name}, ` : ""}${doc.brand.name} here. Invoice${doc.invoiceNumber ? ` ${doc.invoiceNumber}` : ""} ` +
      `for ${formatMoney(doc.balanceCents, doc.currency)} is ready. View${doc.payment.card || doc.payment.bankDebit ? " and pay" : ""}: ${doc.publicUrl}`;
    const result = await deliverMessage({
      context: { organizationId: b.invoice.organization_id, actorProfileId: ctx.actorProfileId, supabase: db },
      channel: "sms",
      to: phone,
      body,
      companyId: b.invoice.company_id,
      contactId: b.invoice.contact_id,
      // Transactional (see header): opt-out was checked above; no marketing consent needed.
      consentContact: null,
    });
    const delivered = result.status === "sent";
    await recordInvoiceEvent(db, {
      organizationId: b.invoice.organization_id,
      invoiceId,
      eventType: delivered ? "sms_sent" : "sms_failed",
      actorProfileId: ctx.actorProfileId,
      metadata: { to: phone, reason: result.reason ?? null },
    });
    return { delivered, reason: delivered ? null : result.reason ?? "Text not sent.", to: phone };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await safeEvent(db, invoiceId, "sms_failed", { reason });
    return { delivered: false, reason };
  }
}

/** Receipt for one payment (online or recorded by staff). */
export async function sendPaymentReceiptEmail(paymentId: string): Promise<DeliveryOutcome> {
  const db = admin();
  let invoiceId: string | null = null;
  try {
    const { data: payment } = await db.from("invoice_payments").select("*").eq("id", paymentId).maybeSingle();
    if (!payment) return { delivered: false, reason: "Payment not found." };
    invoiceId = payment.invoice_id;
    const b = await loadBundle(db, payment.invoice_id);
    if (!b) return { delivered: false, reason: "Invoice not found." };
    const doc = buildInvoiceDocument(b.invoice, b.company);
    const to = doc.billTo.email;
    if (!to) return { delivered: false, reason: "No email address on file." };
    const mail = renderPaymentReceipt(
      doc,
      { amountCents: payment.amount_cents, method: payment.method, receivedAt: payment.received_at, pending: payment.status === "pending" },
      { firstName: firstName(b.contact) },
    );
    const attachments = doc.state === "paid" ? [{ filename: pdfName(b.invoice), content: base64(await renderInvoicePdf(doc)) }] : undefined;
    await sendEmail({
      to,
      subject: mail.subject,
      body: mail.text,
      html: mail.html,
      fromName: mail.fromName ?? undefined,
      replyTo: mail.replyTo ?? undefined,
      attachments,
    });
    await recordInvoiceEvent(db, { organizationId: b.invoice.organization_id, invoiceId: b.invoice.id, eventType: "receipt_sent", metadata: { to, paymentId } });
    return { delivered: true, reason: null, to };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[invoices] receipt failed for payment ${paymentId}:`, reason);
    if (invoiceId) await safeEvent(db, invoiceId, "receipt_failed", { reason, paymentId });
    return { delivered: false, reason };
  }
}

/** One overdue reminder. The caller (reminder job) owns the "which one, and when". */
export async function sendInvoiceReminderEmail(invoiceId: string, opts: { index: number; daysOverdue: number }): Promise<DeliveryOutcome> {
  const db = admin();
  try {
    const b = await loadBundle(db, invoiceId);
    if (!b) return { delivered: false, reason: "Invoice not found." };
    const doc = buildInvoiceDocument(b.invoice, b.company);
    const to = doc.billTo.email;
    if (!to) return { delivered: false, reason: "No email address on file." };
    const mail = renderInvoiceReminder(doc, { firstName: firstName(b.contact), daysOverdue: opts.daysOverdue, index: opts.index });
    const pdf = await renderInvoicePdf(doc);
    await sendEmail({
      to,
      subject: mail.subject,
      body: mail.text,
      html: mail.html,
      fromName: mail.fromName ?? undefined,
      replyTo: mail.replyTo ?? undefined,
      attachments: [{ filename: pdfName(b.invoice), content: base64(pdf) }],
    });
    await recordInvoiceEvent(db, { organizationId: b.invoice.organization_id, invoiceId, eventType: "reminder_sent", metadata: { to, ...opts } });
    return { delivered: true, reason: null, to };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await safeEvent(db, invoiceId, "reminder_failed", { reason, ...opts });
    return { delivered: false, reason };
  }
}

/** Email a business account its statement (PDF attached, each invoice linked). */
export async function sendStatementEmail(
  ctx: Pick<TenantServiceContext, "organizationId">,
  args: { customerAccountId: string; companyId: string; to?: string | null },
): Promise<DeliveryOutcome> {
  const db = admin();
  try {
    const st = await buildStatement(db, ctx.organizationId, args.customerAccountId, args.companyId);
    if (!st) return { delivered: false, reason: "Account not found." };
    const to = args.to?.trim() || st.statement.customer.email;
    if (!to) return { delivered: false, reason: "This account has no billing email." };
    const mail = renderStatement(st.statement, { firstName: null });
    const pdf = await renderStatementPdf(st.statement);
    await sendEmail({
      to,
      subject: mail.subject,
      body: mail.text,
      html: mail.html,
      fromName: mail.fromName ?? undefined,
      replyTo: mail.replyTo ?? undefined,
      attachments: [{ filename: `statement-${st.statement.statementDate}.pdf`, content: base64(pdf) }],
    });
    for (const id of st.invoiceIds) {
      await recordInvoiceEvent(db, { organizationId: ctx.organizationId, invoiceId: id, eventType: "statement_sent", metadata: { to } });
    }
    return { delivered: true, reason: null, to };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error("[invoices] statement email failed:", reason);
    return { delivered: false, reason };
  }
}

async function safeEvent(db: Db, invoiceId: string, eventType: string, metadata: Record<string, unknown>): Promise<void> {
  try {
    const { data } = await db.from("invoices").select("organization_id").eq("id", invoiceId).maybeSingle();
    if (data) await recordInvoiceEvent(db, { organizationId: data.organization_id, invoiceId, eventType, metadata });
  } catch {
    // Already in a failure path; the console line above is the record.
  }
}
