/**
 * Money for annual plans: one invoice per term (the existing invoices service — HST, numbering,
 * the /i/{token} page, receipts, the accounting sync), paid through the existing invoice Checkout
 * (a DIRECT charge on the company's Stripe Connect account, quotes/company-stripe.ts). Nothing
 * here charges anybody off-session; the customer always pays on a page they opened.
 *
 * A sign-up or renewal invoice waiting on the customer has reminders paused, so the Bookkeeper's
 * texts and the reminder emails never chase someone who simply didn't finish signing up. When it
 * isn't paid in time it is voided (sign-up after 3 days; renewal when the plan lapses).
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

export interface PlanBillingDeps {
  /** Can this company take a card payment online (Stripe Connect, charges enabled)? */
  stripeReady(companyId: string): Promise<boolean>;
  issueTermInvoice(admin: AdminClient, input: TermInvoiceInput): Promise<IssuedInvoice>;
  /** A Checkout URL for the invoice's balance, or null (→ send them to the invoice page). */
  checkoutUrl(token: string): Promise<string | null>;
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

export const defaultPlanBillingDeps: PlanBillingDeps = {
  stripeReady: async (companyId) => (await import("@/server/services/quotes/company-stripe")).isCompanyStripeReady(companyId),
  issueTermInvoice,
  checkoutUrl: async (token) => {
    try {
      const { createInvoiceCheckout } = await import("@/server/services/invoices/public");
      return (await createInvoiceCheckout(token, "card")).url;
    } catch (err) {
      console.error("[service-plans] checkout could not start:", err instanceof Error ? err.message : err);
      return null;
    }
  },
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

/** The /i/{token} page for an invoice. */
export async function invoicePageUrl(admin: AdminClient, organizationId: string, companyId: string, token: string): Promise<string> {
  const company = await loadCompanyForInvoice(admin as Db, organizationId, companyId);
  return invoicePublicUrl(company, token);
}
