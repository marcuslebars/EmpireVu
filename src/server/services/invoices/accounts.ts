/**
 * Business customer accounts (marinas, clubs, fleet owners) — dashboard CRUD under
 * the caller's RLS client.
 *
 * An account is the BILL-TO for a business; the people there are ordinary contacts
 * linked by contacts.customer_account_id. Invoicing any linked contact bills the
 * account (see invoices/service.ts).
 */
import type { TenantServiceContext } from "@/server/services/shared";
import { assertContactInOrganization } from "@/server/services/shared";
import type { CustomerAccountRow } from "./common";
import { InvoiceNotFoundError, InvoiceValidationError } from "./errors";

export interface CustomerAccountInput {
  name?: string;
  billingEmail?: string | null;
  billingPhone?: string | null;
  billingAddress?: string | null;
  taxNumber?: string | null;
  paymentTermsDays?: number | null;
  notes?: string | null;
}

function clean(v: string | null | undefined): string | null {
  const t = v?.trim();
  return t ? t : null;
}

function columns(input: CustomerAccountInput) {
  return {
    ...(input.name !== undefined ? { name: input.name.trim() } : {}),
    ...(input.billingEmail !== undefined ? { billing_email: clean(input.billingEmail) } : {}),
    ...(input.billingPhone !== undefined ? { billing_phone: clean(input.billingPhone) } : {}),
    ...(input.billingAddress !== undefined ? { billing_address: clean(input.billingAddress) } : {}),
    ...(input.taxNumber !== undefined ? { tax_number: clean(input.taxNumber) } : {}),
    ...(input.paymentTermsDays !== undefined ? { payment_terms_days: input.paymentTermsDays } : {}),
    ...(input.notes !== undefined ? { notes: clean(input.notes) } : {}),
  };
}

export interface CustomerAccountSummary extends CustomerAccountRow {
  contact_count: number;
  open_balance_cents: number;
  overdue_count: number;
}

export async function listCustomerAccounts(
  ctx: TenantServiceContext,
  opts: { includeArchived?: boolean; search?: string } = {},
): Promise<CustomerAccountSummary[]> {
  let q = ctx.supabase.from("customer_accounts").select("*").eq("organization_id", ctx.organizationId);
  if (!opts.includeArchived) q = q.is("archived_at", null);
  if (opts.search?.trim()) q = q.ilike("name", `%${opts.search.trim().replace(/[%_]/g, "")}%`);
  const { data: accounts, error } = await q.order("name", { ascending: true }).limit(500);
  if (error) throw error;
  const ids = (accounts ?? []).map((a) => a.id);
  if (ids.length === 0) return [];

  const [{ data: contacts }, { data: invoices }] = await Promise.all([
    ctx.supabase.from("contacts").select("customer_account_id").eq("organization_id", ctx.organizationId).in("customer_account_id", ids),
    ctx.supabase
      .from("invoices")
      .select("customer_account_id, balance_due_cents, due_date, status")
      .eq("organization_id", ctx.organizationId)
      .in("customer_account_id", ids)
      .in("status", ["sent", "viewed", "partially_paid"]),
  ]);
  const today = new Date().toISOString().slice(0, 10);
  return (accounts ?? []).map((a) => {
    const mine = (invoices ?? []).filter((i) => i.customer_account_id === a.id);
    return {
      ...a,
      contact_count: (contacts ?? []).filter((c) => c.customer_account_id === a.id).length,
      open_balance_cents: mine.reduce((s, i) => s + i.balance_due_cents, 0),
      overdue_count: mine.filter((i) => i.due_date && i.due_date < today && i.balance_due_cents > 0).length,
    };
  });
}

export async function getCustomerAccount(
  ctx: TenantServiceContext,
  accountId: string,
): Promise<{ account: CustomerAccountRow; contacts: Array<{ id: string; first_name: string; last_name: string | null; email: string | null; phone: string | null }> }> {
  const { data: account, error } = await ctx.supabase
    .from("customer_accounts")
    .select("*")
    .eq("organization_id", ctx.organizationId)
    .eq("id", accountId)
    .maybeSingle();
  if (error) throw error;
  if (!account) throw new InvoiceNotFoundError("Business account not found.");
  const { data: contacts } = await ctx.supabase
    .from("contacts")
    .select("id, first_name, last_name, email, phone")
    .eq("organization_id", ctx.organizationId)
    .eq("customer_account_id", accountId)
    .order("first_name", { ascending: true });
  return { account, contacts: contacts ?? [] };
}

export async function createCustomerAccount(ctx: TenantServiceContext, input: CustomerAccountInput & { name: string }): Promise<CustomerAccountRow> {
  if (!input.name?.trim()) throw new InvoiceValidationError("Give the business a name.");
  const { data, error } = await ctx.supabase
    .from("customer_accounts")
    .insert({ organization_id: ctx.organizationId, name: input.name.trim(), created_by: ctx.actorProfileId, ...columns(input) })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

export async function updateCustomerAccount(ctx: TenantServiceContext, accountId: string, input: CustomerAccountInput & { archived?: boolean }): Promise<CustomerAccountRow> {
  if (input.name !== undefined && !input.name.trim()) throw new InvoiceValidationError("Give the business a name.");
  const { data, error } = await ctx.supabase
    .from("customer_accounts")
    .update({
      ...columns(input),
      ...(input.archived !== undefined ? { archived_at: input.archived ? new Date().toISOString() : null } : {}),
    })
    .eq("organization_id", ctx.organizationId)
    .eq("id", accountId)
    .select("*")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new InvoiceNotFoundError("Business account not found.");
  return data;
}

/** Link a contact to an account (or unlink with null). */
export async function setContactAccount(
  ctx: TenantServiceContext,
  contactId: string,
  accountId: string | null,
  opts: { fromAccountId?: string } = {},
): Promise<void> {
  await assertContactInOrganization(ctx, contactId);
  if (accountId) {
    const { data } = await ctx.supabase
      .from("customer_accounts")
      .select("id")
      .eq("organization_id", ctx.organizationId)
      .eq("id", accountId)
      .maybeSingle();
    if (!data) throw new InvoiceValidationError("Business account not found.");
  }
  let q = ctx.supabase
    .from("contacts")
    .update({ customer_account_id: accountId })
    .eq("organization_id", ctx.organizationId)
    .eq("id", contactId);
  // Unlinking from a specific account only clears THAT link.
  if (!accountId && opts.fromAccountId) q = q.eq("customer_account_id", opts.fromAccountId);
  const { error } = await q;
  if (error) throw error;
}
