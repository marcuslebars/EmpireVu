/**
 * A business account's statement: every open invoice one brand has issued to it,
 * with balances and aging. Per BRAND (company), because each brand is its own
 * business with its own invoice series and its own Stripe account.
 *
 * Works with either client; every query is pinned to organization_id + the ids.
 */
import { invoicePublicUrl, loadCompanyForInvoice, todayFor, type Db } from "./common";
import { brandOfCompany, paymentOptionsFor } from "./document";
import { agingBucket, isOverdue } from "./math";
import type { StatementDocument } from "./pdf";
import { parseInvoiceSettings } from "./settings";

export async function buildStatement(
  db: Db,
  organizationId: string,
  customerAccountId: string,
  companyId: string,
  now: Date = new Date(),
): Promise<{ statement: StatementDocument; invoiceIds: string[] } | null> {
  const [{ data: account }, company] = await Promise.all([
    db
      .from("customer_accounts")
      .select("id, name, billing_email, billing_address")
      .eq("organization_id", organizationId)
      .eq("id", customerAccountId)
      .maybeSingle(),
    loadCompanyForInvoice(db, organizationId, companyId),
  ]);
  if (!account || !company) return null;

  const { data: invoices, error } = await db
    .from("invoices")
    .select("id, invoice_number, title, issue_date, due_date, status, total_cents, credit_cents, amount_paid_cents, balance_due_cents, public_token, currency")
    .eq("organization_id", organizationId)
    .eq("company_id", companyId)
    .eq("customer_account_id", customerAccountId)
    .in("status", ["sent", "viewed", "partially_paid"])
    .order("issue_date", { ascending: true })
    .limit(500);
  if (error) throw error;

  const today = todayFor(company, now);
  const aging = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, over90: 0 };
  const lines = (invoices ?? [])
    .filter((i) => i.balance_due_cents > 0)
    .map((i) => {
      const b = agingBucket(i.due_date, today);
      if (b === "current") aging.current += i.balance_due_cents;
      if (b === "1_30") aging.d1_30 += i.balance_due_cents;
      if (b === "31_60") aging.d31_60 += i.balance_due_cents;
      if (b === "61_90") aging.d61_90 += i.balance_due_cents;
      if (b === "over_90") aging.over90 += i.balance_due_cents;
      return {
        id: i.id,
        invoiceNumber: i.invoice_number,
        title: i.title,
        issueDate: i.issue_date,
        dueDate: i.due_date,
        totalCents: i.total_cents,
        paidCents: i.credit_cents + i.amount_paid_cents,
        balanceCents: i.balance_due_cents,
        overdue: isOverdue(i, today),
        publicUrl: invoicePublicUrl(company, i.public_token),
      };
    });

  const statement: StatementDocument = {
    brand: brandOfCompany(company),
    payment: paymentOptionsFor(company),
    currency: invoices?.[0]?.currency ?? "CAD",
    statementDate: today,
    customer: { name: account.name, attention: null, address: account.billing_address, email: account.billing_email },
    lines: lines.map(({ id: _id, ...rest }) => rest),
    aging,
    totalDueCents: lines.reduce((s, l) => s + l.balanceCents, 0),
    footerText: parseInvoiceSettings(company.invoice_settings).footerText,
  };
  return { statement, invoiceIds: lines.map((l) => l.id) };
}
