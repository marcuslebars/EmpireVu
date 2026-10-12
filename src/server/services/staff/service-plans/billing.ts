/**
 * Money for annual plans: one invoice per term (the existing invoices service — HST, numbering,
 * the /i/{token} page, receipts, the accounting sync). Nothing here charges anybody off-session;
 * the customer always pays on a page they opened.
 *
 * Paying online (the business takes cards through Stripe Connect): the term invoice is created as
 * a DRAFT — no number, no `invoice.sent`, no owner copy, no reminders, no overdue event — and the
 * customer pays it through a Checkout session WE open on the company's own account (a direct
 * charge) carrying `plan_agreement_id` + `invoice_id`. When Stripe says it's paid, the Connect
 * webhook issues the draft (number, dates) and records the payment on it like any invoice payment
 * (onPlanCheckoutCompleted). An abandoned sign-up's draft is voided after 3 days: no number burnt,
 * the open Checkout expired.
 *
 * Without online payments (or no website for a renewal page) the invoice is issued straight away
 * (e-Transfer etc. on its /i page); a pending one waiting on the customer has reminders paused and
 * never raises `invoice.overdue` (invoices/reminders.ts asks isPendingPlanInvoice).
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { invoicePublicUrl, loadCompanyForInvoice } from "@/server/services/invoices/common";
import type { Db } from "./db-types";
import { tenant } from "./messages";

export interface TermInvoiceInput {
  organizationId: string;
  companyId: string;
  contactId: string;
  title: string;
  lineLabel: string;
  lineDescription: string | null;
  priceCents: number;
  /** YYYY-MM-DD */
  dueDate: string;
  /** Reminders paused until it's paid (sign-ups and renewals the customer pays themselves). */
  pauseReminders: boolean;
  internalNote: string;
}

export interface IssuedInvoice {
  id: string;
  token: string;
  totalCents: number;
  url: string;
}

export interface InvoiceState {
  id: string;
  status: string;
  balanceDueCents: number;
  pendingPaymentCents: number;
  amountPaidCents: number;
  token: string | null;
  totalCents: number;
}

export interface PlanCheckoutInput {
  organizationId: string;
  companyId: string;
  agreementId: string;
  /** The DRAFT term invoice being paid. */
  invoiceId: string;
  /** Where the customer comes back to (the plan / renewal page). */
  returnUrl: string;
}

export interface PlanBillingDeps {
  /** Can this company take a card payment online (Stripe Connect, charges enabled)? */
  stripeReady(companyId: string): Promise<boolean>;
  /** An issued (numbered, sent) term invoice — owner-started plans, renewals paid offline. */
  issueTermInvoice(admin: AdminClient, input: TermInvoiceInput): Promise<IssuedInvoice>;
  /** A DRAFT term invoice, paid online through planCheckoutUrl and issued when paid. */
  draftTermInvoice(admin: AdminClient, input: TermInvoiceInput): Promise<{ id: string; totalCents: number }>;
  /** Issue a draft (number, dates; no email). No-op when it's already issued. */
  issueDraft(admin: AdminClient, organizationId: string, invoiceId: string): Promise<void>;
  /** A Checkout URL for a draft term invoice (reused while open), or null when it can't start. */
  planCheckoutUrl(admin: AdminClient, input: PlanCheckoutInput): Promise<string | null>;
  /** Void an unpaid invoice. False when it can't be (a payment is on it). Never throws. */
  voidUnpaid(admin: AdminClient, organizationId: string, invoiceId: string, reason: string): Promise<boolean>;
}

// The invoices service and Stripe are loaded on first use, so loading the staff registry (every
// SMS / owner text, every scheduler tick) doesn't pull in the Stripe SDK.
const invoices = () => import("@/server/services/invoices/service");

async function issueTermInvoice(admin: AdminClient, input: TermInvoiceInput): Promise<IssuedInvoice> {
  const { createInvoice, sendInvoice } = await invoices();
  const ctx = tenant(admin, input.organizationId);
  const draft = await createInvoice(ctx, {
    companyId: input.companyId,
    contactId: input.contactId,
    title: input.title,
    lines: [{ label: input.lineLabel, description: input.lineDescription, quantity: 1, unitPriceCents: input.priceCents }],
    dueDate: input.dueDate,
    paymentTermsDays: 0,
    internalNotes: input.internalNote,
  });
  // Issue it (number + dates) without emailing it: the customer pays on the page right away, or
  // gets the link in our own text.
  const sent = await sendInvoice(ctx, draft.id, { email: false, sms: false });
  if (input.pauseReminders) {
    await (admin as Db).from("invoices").update({ reminders_paused: true }).eq("organization_id", input.organizationId).eq("id", draft.id);
  }
  return { id: draft.id, token: sent.invoice.public_token, totalCents: sent.invoice.total_cents, url: sent.publicUrl };
}

async function draftTermInvoice(admin: AdminClient, input: TermInvoiceInput): Promise<{ id: string; totalCents: number }> {
  const { createInvoice } = await invoices();
  const draft = await createInvoice(tenant(admin, input.organizationId), {
    companyId: input.companyId,
    contactId: input.contactId,
    title: input.title,
    lines: [{ label: input.lineLabel, description: input.lineDescription, quantity: 1, unitPriceCents: input.priceCents }],
    dueDate: input.dueDate,
    paymentTermsDays: 0,
    internalNotes: input.internalNote,
  });
  // Paused from the start: once issued at payment it's paid anyway, but never chase a plan invoice.
  await (admin as Db).from("invoices").update({ reminders_paused: true }).eq("organization_id", input.organizationId).eq("id", draft.id);
  return { id: draft.id, totalCents: draft.total_cents };
}

async function issueDraft(admin: AdminClient, organizationId: string, invoiceId: string): Promise<void> {
  const { data } = await (admin as Db).from("invoices").select("status").eq("organization_id", organizationId).eq("id", invoiceId).maybeSingle();
  if ((data as { status?: string } | null)?.status !== "draft") return;
  const { sendInvoice } = await invoices();
  await sendInvoice(tenant(admin, organizationId), invoiceId, { email: false, sms: false });
}

async function planCheckoutUrl(admin: AdminClient, input: PlanCheckoutInput): Promise<string | null> {
  try {
    const db = admin as Db;
    const { data } = await db
      .from("invoices")
      .select("id, status, total_cents, currency, title, invoice_number, stripe_checkout_session_id")
      .eq("organization_id", input.organizationId)
      .eq("company_id", input.companyId)
      .eq("id", input.invoiceId)
      .maybeSingle();
    const invoice = data as { id: string; status: string; total_cents: number; currency: string | null; title: string | null; stripe_checkout_session_id: string | null } | null;
    if (!invoice || invoice.status !== "draft" || !(invoice.total_cents > 0)) return null;
    const { getPlatformStripe, onAccount, requireChargeableCompany } = await import("@/server/services/quotes/company-stripe");
    const brand = await requireChargeableCompany(input.companyId);
    const stripe = getPlatformStripe();
    const acct = onAccount(brand);
    const previous = invoice.stripe_checkout_session_id;
    if (previous) {
      // A double tap, or coming back to pay: reuse the open session; expire anything stale.
      const existing = await stripe.checkout.sessions.retrieve(previous, undefined, acct).catch(() => null);
      if (existing?.status === "open") {
        if (existing.url && existing.amount_total === invoice.total_cents) return existing.url;
        await stripe.checkout.sessions.expire(existing.id, undefined, acct).catch(() => undefined);
      } else if (existing?.status === "complete") {
        return null; // paid already; the webhook is on its way
      }
    }
    const meta = { org_id: input.organizationId, company_id: input.companyId, invoice_id: invoice.id, plan_agreement_id: input.agreementId, method: "card" };
    const session = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        payment_method_types: ["card"],
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: (invoice.currency ?? "CAD").toLowerCase(),
              unit_amount: invoice.total_cents,
              product_data: { name: `${brand.name ?? "Service plan"} — ${invoice.title ?? "Service plan"}`.slice(0, 250) },
            },
          },
        ],
        payment_intent_data: {
          description: invoice.title ?? "Service plan",
          ...(brand.statementDescriptorSuffix ? { statement_descriptor_suffix: brand.statementDescriptorSuffix } : {}),
          metadata: meta,
        },
        metadata: meta,
        client_reference_id: invoice.id,
        success_url: `${input.returnUrl}?paid=1`,
        cancel_url: input.returnUrl,
      },
      { ...acct, idempotencyKey: `plan-pay-${invoice.id}-${invoice.total_cents}-${previous ?? "first"}` },
    );
    if (session.status !== "open" || !session.url) return null;
    await db.from("invoices").update({ stripe_checkout_session_id: session.id }).eq("organization_id", input.organizationId).eq("id", invoice.id);
    return session.url;
  } catch (err) {
    console.error("[service-plans] checkout could not start:", err instanceof Error ? err.message : err);
    return null;
  }
}

export const defaultPlanBillingDeps: PlanBillingDeps = {
  stripeReady: async (companyId) => (await import("@/server/services/quotes/company-stripe")).isCompanyStripeReady(companyId),
  issueTermInvoice,
  draftTermInvoice,
  issueDraft,
  planCheckoutUrl,
  voidUnpaid: async (admin, organizationId, invoiceId, reason) => {
    try {
      const { voidInvoice } = await invoices();
      await voidInvoice(tenant(admin, organizationId), invoiceId, reason);
      return true;
    } catch (err) {
      console.error(`[service-plans] could not void invoice ${invoiceId}:`, err instanceof Error ? err.message : err);
      return false;
    }
  },
};

export async function invoiceStates(admin: AdminClient, organizationId: string, ids: string[]): Promise<Map<string, InvoiceState>> {
  const out = new Map<string, InvoiceState>();
  const unique = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < unique.length; i += 200) {
    const { data, error } = await (admin as Db)
      .from("invoices")
      .select("id, status, balance_due_cents, pending_payment_cents, amount_paid_cents, public_token, total_cents")
      .eq("organization_id", organizationId)
      .in("id", unique.slice(i, i + 200));
    if (error) throw error;
    for (const r of (data ?? []) as Array<Record<string, unknown>>) {
      out.set(String(r.id), {
        id: String(r.id),
        status: String(r.status ?? ""),
        balanceDueCents: Number(r.balance_due_cents ?? 0),
        pendingPaymentCents: Number(r.pending_payment_cents ?? 0),
        amountPaidCents: Number(r.amount_paid_cents ?? 0),
        token: typeof r.public_token === "string" ? r.public_token : null,
        totalCents: Number(r.total_cents ?? 0),
      });
    }
  }
  return out;
}

/** Paid in full (a deposit or credit covering it counts). */
export function isPaid(state: InvoiceState | undefined): boolean {
  return Boolean(state && (state.status === "paid" || (state.status !== "void" && state.status !== "draft" && state.balanceDueCents <= 0)));
}

/** Money is in for the whole term, whatever the invoice's status (a payment that raced a void). */
export function moneyIn(state: InvoiceState | undefined): boolean {
  return Boolean(state && (isPaid(state) || (state.totalCents > 0 && state.amountPaidCents >= state.totalCents)));
}

/** The /i/{token} page for an invoice. */
export async function invoicePageUrl(admin: AdminClient, organizationId: string, companyId: string, token: string): Promise<string> {
  const company = await loadCompanyForInvoice(admin as Db, organizationId, companyId);
  return invoicePublicUrl(company, token);
}
