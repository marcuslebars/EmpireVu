/**
 * Shared reads/writes for the Bookkeeper. Every query is pinned to organization_id AND
 * company_id; ids from a text (the model, a customer) are only ever looked up inside that scope.
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { invoicePublicUrl } from "@/server/services/invoices/common";
import { parseInvoiceSettings } from "@/server/services/invoices/settings";
import type { TenantServiceContext } from "@/server/services/shared";
import { deliverMessage, type ConsentContact, type DeliverMessageResult } from "@/server/services/workflow-engine/messaging";
import { CONTACT_COLUMNS, INVOICE_COLUMNS, type BookkeeperContact, type BookkeeperInvoice, type Db, type InvoiceCollectionsRow } from "./db-types";
import { localParts } from "./format";
import { chunks, isDoneForYouOrg, readCollectionsSettings, type CollectionsSettings } from "./settings";

/** message_log.sent_by for the Bookkeeper's texts. */
export const BOOKKEEPER_SENDER = "bookkeeper";
export const OPEN_INVOICE_STATUSES = ["sent", "viewed", "partially_paid"];

export interface CompanyCtx {
  organizationId: string;
  companyId: string;
  /** The name customers know (brand_from_name, else the company name). */
  name: string;
  timeZone: string;
  doneForYou: boolean;
  platformBrand: string;
  /** The VERIFIED owner cell, else null (no owner texts). */
  ownerPhone: string | null;
  ownerFirstName: string | null;
  settings: CollectionsSettings;
  /** For the pay link (/i/{token}) on the brand's own host. */
  quoteBaseCompany: { quote_public_base_url: string | null; platform_brand: string | null };
  emailReminders: { enabled: boolean; days: number[] };
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function ownerFirstName(db: Db, organizationId: string): Promise<string | null> {
  try {
    const { data } = await db.from("organization_memberships").select("profile_id, role").eq("organization_id", organizationId).eq("role", "owner").limit(1);
    const profileId = ((data ?? []) as Array<{ profile_id: string }>)[0]?.profile_id;
    if (!profileId) return null;
    const { data: profile } = await db.from("profiles").select("full_name").eq("id", profileId).maybeSingle();
    const first = (profile as { full_name: string | null } | null)?.full_name?.trim().split(/\s+/)[0] ?? "";
    return /^[A-Za-zÀ-ÿ'-]{2,30}$/.test(first) ? first : null;
  } catch {
    return null;
  }
}

/** The company as the Bookkeeper sees it. Null → not that org's company. */
export async function loadCompanyCtx(admin: AdminClient, organizationId: string, companyId: string): Promise<CompanyCtx | null> {
  const db = admin as Db;
  const { data } = await db
    .from("companies")
    .select("id, organization_id, name, brand_from_name, timezone, owner_phone_e164, owner_phone_verified_at, ai_settings, quote_public_base_url, invoice_settings")
    .eq("organization_id", organizationId)
    .eq("id", companyId)
    .maybeSingle();
  if (!data) return null;
  const c = data as Record<string, unknown>;
  const { data: org } = await db.from("organizations").select("platform_brand").eq("id", organizationId).maybeSingle();
  const doneForYou = isDoneForYouOrg(org);
  const platformBrand = str((org as Record<string, unknown> | null)?.platform_brand) ?? "empirevu";
  const invoiceSettings = parseInvoiceSettings(c.invoice_settings ?? null);
  return {
    organizationId,
    companyId,
    name: str(c.brand_from_name) ?? str(c.name) ?? "us",
    timeZone: str(c.timezone) ?? process.env.BUSINESS_TIMEZONE?.trim() ?? "America/Toronto",
    doneForYou,
    platformBrand,
    ownerPhone: str(c.owner_phone_e164) && c.owner_phone_verified_at ? str(c.owner_phone_e164) : null,
    ownerFirstName: await ownerFirstName(db, organizationId),
    settings: readCollectionsSettings(c.ai_settings, { doneForYou }),
    quoteBaseCompany: { quote_public_base_url: str(c.quote_public_base_url), platform_brand: doneForYou ? "crankleads" : platformBrand },
    emailReminders: { enabled: invoiceSettings.remindersEnabled, days: invoiceSettings.reminderDays },
  };
}

export function todayIn(ctx: Pick<CompanyCtx, "timeZone">, nowMs: number): string {
  return localParts(nowMs, ctx.timeZone).date;
}

export function payLink(ctx: Pick<CompanyCtx, "quoteBaseCompany">, invoice: Pick<BookkeeperInvoice, "public_token">): string {
  return invoicePublicUrl(ctx.quoteBaseCompany, invoice.public_token);
}

export function tenantCtx(admin: AdminClient, organizationId: string): TenantServiceContext {
  return { organizationId, actorProfileId: null, supabase: admin as TenantServiceContext["supabase"] };
}

export async function loadInvoice(admin: AdminClient, scope: { organizationId: string; companyId: string }, invoiceId: unknown): Promise<BookkeeperInvoice | null> {
  if (typeof invoiceId !== "string" || !invoiceId.trim()) return null;
  const { data } = await (admin as Db)
    .from("invoices")
    .select(INVOICE_COLUMNS)
    .eq("organization_id", scope.organizationId)
    .eq("company_id", scope.companyId)
    .eq("id", invoiceId.trim())
    .maybeSingle();
  return (data as BookkeeperInvoice | null) ?? null;
}

export async function loadContact(admin: AdminClient, scope: { organizationId: string; companyId: string }, contactId: string | null): Promise<BookkeeperContact | null> {
  if (!contactId) return null;
  const { data } = await (admin as Db)
    .from("contacts")
    .select(CONTACT_COLUMNS)
    .eq("organization_id", scope.organizationId)
    .eq("id", contactId)
    .maybeSingle();
  const contact = data as BookkeeperContact | null;
  // A contact pinned to another company of the org is not this company's customer.
  if (!contact || (contact.company_id && contact.company_id !== scope.companyId)) return null;
  return contact;
}

/** Open invoices with a balance for one contact (newest due first). */
export async function openInvoicesForContact(admin: AdminClient, scope: { organizationId: string; companyId: string }, contactId: string): Promise<BookkeeperInvoice[]> {
  const { data } = await (admin as Db)
    .from("invoices")
    .select(INVOICE_COLUMNS)
    .eq("organization_id", scope.organizationId)
    .eq("company_id", scope.companyId)
    .eq("contact_id", contactId)
    .in("status", OPEN_INVOICE_STATUSES)
    .gt("balance_due_cents", 0)
    .order("due_date", { ascending: true })
    .limit(20);
  return (data ?? []) as BookkeeperInvoice[];
}

/** What's still owed after money that is clearing (a bank debit). PURE. */
export function owingCents(invoice: Pick<BookkeeperInvoice, "balance_due_cents" | "pending_payment_cents">): number {
  return Math.max(0, invoice.balance_due_cents - (invoice.pending_payment_cents ?? 0));
}

export function isOpen(invoice: Pick<BookkeeperInvoice, "status" | "balance_due_cents" | "pending_payment_cents">): boolean {
  return OPEN_INVOICE_STATUSES.includes(invoice.status) && owingCents(invoice) > 0;
}

/**
 * CASL: an invoice the customer owes is an existing business relationship, dated from when the
 * invoice went out — so the consent anchor is the later of the contact's own consent and that
 * date. deliverMessage's checkConsent then enforces opt-out and the consent window. PURE.
 */
export function reminderConsent(contact: BookkeeperContact, invoice: Pick<BookkeeperInvoice, "sent_at" | "issue_date">): ConsentContact {
  const anchors = [contact.sms_consent_at, invoice.sent_at, invoice.issue_date ? `${invoice.issue_date}T12:00:00Z` : null]
    .filter((x): x is string => Boolean(x) && Number.isFinite(Date.parse(x as string)))
    .sort((a, b) => Date.parse(b) - Date.parse(a));
  return {
    sms_opt_out_at: contact.sms_opt_out_at,
    email_opt_out_at: contact.email_opt_out_at,
    consent_source: contact.consent_source,
    sms_consent_at: anchors[0] ?? null,
  };
}

/** Text a customer from the company's number (consent-checked, STOP footer, message_log sent_by=bookkeeper). */
export async function textCustomer(
  admin: AdminClient,
  ctx: Pick<CompanyCtx, "organizationId" | "companyId">,
  contact: BookkeeperContact,
  body: string,
  consent: ConsentContact,
): Promise<DeliverMessageResult> {
  return deliverMessage({
    context: tenantCtx(admin, ctx.organizationId),
    channel: "sms",
    to: contact.phone?.trim() || null,
    body,
    companyId: ctx.companyId,
    contactId: contact.id,
    consentContact: consent,
    sentBy: BOOKKEEPER_SENDER,
  });
}

/** Get (or create) the collections row for an invoice. */
export async function ensureCollections(admin: AdminClient, invoice: Pick<BookkeeperInvoice, "id" | "organization_id" | "company_id" | "contact_id">): Promise<InvoiceCollectionsRow> {
  const db = admin as Db;
  const existing = await db.from("invoice_collections").select("*").eq("organization_id", invoice.organization_id).eq("invoice_id", invoice.id).maybeSingle();
  if (existing.data) return existing.data as InvoiceCollectionsRow;
  const { data, error } = await db
    .from("invoice_collections")
    .insert({ organization_id: invoice.organization_id, company_id: invoice.company_id, invoice_id: invoice.id, contact_id: invoice.contact_id })
    .select("*")
    .single();
  if (!error && data) return data as InvoiceCollectionsRow;
  // Lost a race (23505): read the winner's row.
  const again = await db.from("invoice_collections").select("*").eq("organization_id", invoice.organization_id).eq("invoice_id", invoice.id).maybeSingle();
  if (again.data) return again.data as InvoiceCollectionsRow;
  throw error ?? new Error("Could not create the collections row.");
}

/**
 * Collections rows for these invoices, read in chunks. THROWS on any read error: callers must
 * skip the company this run rather than carry on without its holds and spacing.
 */
export async function collectionsFor(admin: AdminClient, organizationId: string, invoiceIds: string[]): Promise<Map<string, InvoiceCollectionsRow>> {
  const out = new Map<string, InvoiceCollectionsRow>();
  for (const ids of chunks(invoiceIds)) {
    const { data, error } = await (admin as Db).from("invoice_collections").select("*").eq("organization_id", organizationId).in("invoice_id", ids);
    if (error) throw error;
    for (const r of (data ?? []) as InvoiceCollectionsRow[]) out.set(r.invoice_id, r);
  }
  return out;
}
