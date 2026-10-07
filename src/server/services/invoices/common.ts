/**
 * Shared invoice helpers that work with EITHER database client — the caller's RLS
 * client (dashboard) or the service-role client (webhook, public page, reminder
 * job). Every query here is pinned to the invoice's own organization_id, so it is
 * tenant-safe under both.
 */
import type { Tables } from "@/server/db/database.types";
import { fromJson, toJson } from "@/server/db/json";
import { quotePublicBaseUrlFor } from "@/server/services/quotes/config";
import type { TenantServiceContext } from "@/server/services/shared";
import { emitActivityEventAndDispatch } from "@/server/services/workflow-engine/dispatch";
import { localDateString } from "./math";

export type Db = TenantServiceContext["supabase"];
export type InvoiceRow = Tables<"invoices">;
export type InvoicePaymentRow = Tables<"invoice_payments">;
export type CustomerAccountRow = Tables<"customer_accounts">;

export interface BillTo {
  /** The business (marina) name, or the person's name for an individual. */
  name: string;
  /** "Attn:" line — the contact at a business account. */
  attention: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  taxNumber: string | null;
}

export function readBillTo(raw: unknown): BillTo {
  const b = (raw && typeof raw === "object" ? raw : {}) as Partial<BillTo>;
  const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return {
    name: s(b.name) ?? "Customer",
    attention: s(b.attention),
    email: s(b.email),
    phone: s(b.phone),
    address: s(b.address),
    taxNumber: s(b.taxNumber),
  };
}

function fullName(c: { first_name?: string | null; last_name?: string | null } | null): string | null {
  if (!c) return null;
  const n = [c.first_name, c.last_name].filter((p) => p && p.trim() && p.trim() !== "Lead").join(" ").trim();
  return n || null;
}

/**
 * Who the invoice is addressed to. A business account wins (the marina is the
 * customer; the contact is "Attn:"), and its billing email takes precedence over
 * the contact's own — invoices for a marina go to their accounts inbox.
 */
export async function resolveBillTo(
  db: Db,
  organizationId: string,
  ids: { contactId: string | null; customerAccountId: string | null },
  addressOverride?: string | null,
): Promise<BillTo> {
  const [{ data: contact }, { data: account }] = await Promise.all([
    ids.contactId
      ? db
          .from("contacts")
          .select("first_name, last_name, email, phone")
          .eq("organization_id", organizationId)
          .eq("id", ids.contactId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    ids.customerAccountId
      ? db
          .from("customer_accounts")
          .select("name, billing_email, billing_phone, billing_address, tax_number")
          .eq("organization_id", organizationId)
          .eq("id", ids.customerAccountId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const person = fullName(contact);
  const override = addressOverride?.trim() || null;
  if (account) {
    return {
      name: account.name,
      attention: person,
      email: account.billing_email ?? contact?.email ?? null,
      phone: account.billing_phone ?? contact?.phone ?? null,
      address: override ?? account.billing_address ?? null,
      taxNumber: account.tax_number ?? null,
    };
  }
  return {
    name: person ?? contact?.email ?? "Customer",
    attention: null,
    email: contact?.email ?? null,
    phone: contact?.phone ?? null,
    address: override,
    taxNumber: null,
  };
}

/** The company row fields invoices need (branding, tax number, settings, domain). */
export const COMPANY_INVOICE_COLUMNS =
  "id, organization_id, name, timezone, brand_logo_url, brand_primary_color, brand_accent_color, brand_from_name, " +
  "brand_reply_email, brand_reply_phone, brand_website_url, tax_registration_number, business_address, " +
  "invoice_settings, quote_public_base_url, stripe_connected_account_id, stripe_charges_enabled, stripe_acss_debit_enabled";

export type CompanyForInvoice = Pick<
  Tables<"companies">,
  | "id"
  | "organization_id"
  | "name"
  | "timezone"
  | "brand_logo_url"
  | "brand_primary_color"
  | "brand_accent_color"
  | "brand_from_name"
  | "brand_reply_email"
  | "brand_reply_phone"
  | "brand_website_url"
  | "tax_registration_number"
  | "business_address"
  | "invoice_settings"
  | "quote_public_base_url"
  | "stripe_connected_account_id"
  | "stripe_charges_enabled"
  | "stripe_acss_debit_enabled"
>;

export async function loadCompanyForInvoice(db: Db, organizationId: string, companyId: string): Promise<CompanyForInvoice | null> {
  const { data, error } = await db
    .from("companies")
    .select(COMPANY_INVOICE_COLUMNS)
    .eq("organization_id", organizationId)
    .eq("id", companyId)
    .maybeSingle();
  if (error) throw error;
  return fromJson<CompanyForInvoice | null>(data as never);
}

export function companyTimeZone(company: { timezone?: string | null } | null): string {
  return (company?.timezone && company.timezone.trim()) || process.env.BUSINESS_TIMEZONE?.trim() || "America/Toronto";
}

export function todayFor(company: { timezone?: string | null } | null, now: Date = new Date()): string {
  return localDateString(now, companyTimeZone(company));
}

/** `{brand origin}/i/{token}` — on the brand's own quote domain when it has one. */
export function invoicePublicUrl(company: { quote_public_base_url?: string | null } | null, token: string): string {
  return `${quotePublicBaseUrlFor(company)}/i/${token}`;
}

/** Best-effort audit append — the invoice itself is already durable. */
export async function recordInvoiceEvent(
  db: Db,
  args: { organizationId: string; invoiceId: string; eventType: string; actorProfileId?: string | null; metadata?: Record<string, unknown> },
): Promise<void> {
  try {
    const { error } = await db.from("invoice_events").insert({
      organization_id: args.organizationId,
      invoice_id: args.invoiceId,
      event_type: args.eventType,
      actor_profile_id: args.actorProfileId ?? null,
      metadata: toJson(args.metadata ?? {}),
    });
    if (error) throw error;
  } catch (err) {
    console.error(`[invoices] failed to record '${args.eventType}' event:`, err instanceof Error ? err.message : err);
  }
}

export type InvoiceTriggerType = "invoice.sent" | "invoice.paid" | "invoice.overdue" | "invoice.payment_failed";

/**
 * Emit an invoice.* workflow trigger, anchored to the contact (else the company).
 * Best-effort: a trigger must never fail the money movement that produced it.
 */
export async function emitInvoiceTrigger(
  db: Db,
  args: {
    organizationId: string;
    companyId: string | null;
    contactId: string | null;
    invoiceId: string;
    quoteId?: string | null;
    eventType: InvoiceTriggerType;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  const anchorId = args.contactId ?? args.companyId;
  if (!anchorId) return;
  try {
    await emitActivityEventAndDispatch(
      { organizationId: args.organizationId, actorProfileId: null, supabase: db },
      {
        companyId: args.companyId,
        entityId: anchorId,
        entityType: args.contactId ? "contact" : "company",
        eventType: args.eventType,
        metadata: { invoiceId: args.invoiceId, ...(args.quoteId ? { quoteId: args.quoteId } : {}), ...(args.metadata ?? {}) },
      },
    );
  } catch (err) {
    console.error(`[invoices] failed to emit ${args.eventType}:`, err instanceof Error ? err.message : err);
  }
}

/**
 * Re-derive paid / pending / balance / status from the payments (the SQL function
 * is the single source of truth), then run the once-only "it's paid" side effects.
 * Safe to call any number of times.
 */
export async function refreshInvoiceBalance(db: Db, invoiceId: string): Promise<InvoiceRow> {
  const { data, error } = await db.rpc("refresh_invoice_balance", { p_invoice_id: invoiceId });
  if (error) throw error;
  const row = (Array.isArray(data) ? data[0] : data) as InvoiceRow | undefined;
  if (!row) throw new Error(`Invoice ${invoiceId} not found.`);
  if (row.status === "paid") {
    await onInvoicePaid(db, row);
  } else if (row.paid_notified_at) {
    // No longer paid (a refund, a bounced debit, a removed payment): re-arm the
    // once-only "paid" effects for when it really is paid again.
    await db.from("invoices").update({ paid_notified_at: null }).eq("id", row.id).eq("organization_id", row.organization_id).neq("status", "paid");
    return { ...row, paid_notified_at: null };
  }
  return row;
}

/**
 * Exactly-once "invoice paid" effects: the workflow trigger and closing out the
 * quote. The conditional update on paid_notified_at is the guard, so a webhook
 * redelivery and a staff click racing each other still fire this once.
 */
async function onInvoicePaid(db: Db, invoice: InvoiceRow): Promise<void> {
  const { data: claimed } = await db
    .from("invoices")
    .update({ paid_notified_at: new Date().toISOString() })
    .eq("id", invoice.id)
    .eq("organization_id", invoice.organization_id)
    .is("paid_notified_at", null)
    .select("id")
    .maybeSingle();
  if (!claimed) return;

  await recordInvoiceEvent(db, { organizationId: invoice.organization_id, invoiceId: invoice.id, eventType: "paid", metadata: { totalCents: invoice.total_cents } });

  // The quote's balance is now settled: deposit_paid → completed. A quote that never
  // took a deposit has no "completed" edge (see quotes/lifecycle.ts) and is left alone.
  if (invoice.quote_id) {
    try {
      await db
        .from("quotes")
        .update({ status: "completed", completed_at: new Date().toISOString(), balance_paid_at: new Date().toISOString() })
        .eq("id", invoice.quote_id)
        .eq("organization_id", invoice.organization_id)
        .eq("status", "deposit_paid");
    } catch (err) {
      console.error("[invoices] could not complete the quote:", err instanceof Error ? err.message : err);
    }
  }

  await emitInvoiceTrigger(db, {
    organizationId: invoice.organization_id,
    companyId: invoice.company_id,
    contactId: invoice.contact_id,
    invoiceId: invoice.id,
    quoteId: invoice.quote_id,
    eventType: "invoice.paid",
  });

  // A deposit for an online booking → the booking is confirmed. Never throws.
  try {
    const { onDepositInvoicePaid } = await import("@/server/services/scheduling/deposits");
    await onDepositInvoicePaid(db, invoice);
  } catch (err) {
    console.error("[invoices] could not confirm the booking deposit:", err instanceof Error ? err.message : err);
  }

  // Paid → queue a review request, when the brand asks on payment. Never throws.
  // Imported lazily: the review module reaches back into messaging/quotes code.
  try {
    const { scheduleReviewForPaidInvoice } = await import("@/server/services/reviews/service");
    await scheduleReviewForPaidInvoice(db, invoice);
  } catch (err) {
    console.error("[invoices] could not queue a review request:", err instanceof Error ? err.message : err);
  }
}
