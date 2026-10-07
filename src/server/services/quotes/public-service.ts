/**
 * The public (unauthenticated) side of a quote: everything reachable from
 * /q/{public_token}.
 *
 * These run under the SERVICE-ROLE client, because the customer has no Supabase
 * session — the unguessable token IS the credential. That makes the token the
 * whole security boundary, so every function here:
 *   • looks a quote up ONLY by exact token (never by id from the request),
 *   • returns a narrowed shape, never the raw row — no internal ids, no
 *     stripe ids, no org internals leak to the page, and
 *   • re-derives money server-side from the stored inputs at approval, so a
 *     tampered client total can never become a charge.
 */

import { UserFacingError } from "@/server/errors";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { emitQuoteTrigger } from "@/server/services/quotes/workflow-triggers";
import type { TenantServiceContext } from "@/server/services/shared";
import { createTask } from "@/server/services/tasks";
import { assertTransition, evaluateTransition, type QuoteStatus } from "./lifecycle";
import { priceQuoteForCompany, type QuotePricing, type QuotePricingInput } from "./pricing";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

const admin = (): Db => createSupabaseAdminClient() as Db;

/** How the page should render. Derived from status, never stored. */
export type QuotePageState = "active" | "expired" | "replaced" | "confirmed" | "cancelled";

export interface PublicQuoteLine {
  serviceId: string;
  label: string;
  description: string;
  quantity: number;
  unitPriceCents: number;
  amountCents: number;
  optional: boolean;
  selected: boolean;
  custom: boolean;
}

export interface PublicQuote {
  token: string;
  quoteNumber: string | null;
  title: string | null;
  introMessage: string | null;
  currency: string;
  state: QuotePageState;
  status: QuoteStatus;
  sentAt: string | null;
  validUntil: string | null;
  lineItems: PublicQuoteLine[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  depositCents: number;
  taxRateBps: number;
  depositRateBps: number;
  /** Fixed deposit policy, when the quote was issued under one (null = percentage). */
  depositFlatCents: number | null;
  /** Frozen at approval; present only once approved. */
  approvedByName: string | null;
  approvedAt: string | null;
  /** Set once the deposit is paid, for the confirmation state. */
  depositPaidAt: string | null;
  /**
   * The brand the customer sees. Sourced entirely from the company — the
   * platform is never named on a customer-facing surface.
   */
  brand: {
    name: string | null;
    logoUrl: string | null;
    primaryColor: string | null;
    accentColor: string | null;
    websiteUrl: string | null;
    replyEmail: string | null;
    replyPhone: string | null;
    termsText: string | null;
    cancellationPolicy: string | null;
  };
}

/** Approval is only offered in this state. Everything else is read-only. */
export function isApprovable(state: QuotePageState): boolean {
  return state === "active";
}

/**
 * How the page should render. Exported so the state table can be tested directly —
 * this is the function that decides whether an Approve button exists.
 */
export function derivePageState(row: Db, now: Date): QuotePageState {
  const status = row.status as QuoteStatus;

  // A replaced quote reads as replaced even if it also expired — the customer
  // needs to be pointed at the new quote, not told to ask for a refresh.
  if (row.superseded_by) return "replaced";
  if (status === "cancelled") return "cancelled";
  if (status === "approved" || status === "deposit_paid" || status === "completed") return "confirmed";
  if (status === "expired") return "expired";

  // Not yet swept by the cron but past its date — render as expired rather than
  // letting someone approve a stale price because a job hasn't run.
  const validUntil = row.valid_until ?? row.expires_at;
  if (validUntil && new Date(validUntil).getTime() <= now.getTime()) return "expired";

  return "active";
}

/**
 * Brand identity for the customer-facing page, resolved from the COMPANY.
 *
 * EmpireVu is the backend. A customer looking at a quote sees the brand they
 * hired and nothing about the platform running it — so there is deliberately no
 * platform fallback here. A company with no branding set renders neutral (plain
 * text, default palette), never anything EmpireVu-shaped.
 */
function companyBrand(company: Db | null): PublicQuote["brand"] {
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.trim().length > 0 ? v.trim() : null;

  return {
    name: str(company?.name),
    logoUrl: str(company?.brand_logo_url),
    primaryColor: str(company?.brand_primary_color),
    accentColor: str(company?.brand_accent_color),
    websiteUrl: str(company?.brand_website_url),
    replyEmail: str(company?.brand_reply_email),
    replyPhone: str(company?.brand_reply_phone),
    termsText: str(company?.quote_terms_text),
    cancellationPolicy: str(company?.cancellation_policy_text),
  };
}

function toPublicLines(raw: unknown): PublicQuoteLine[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((l: Db) => ({
    serviceId: String(l.serviceId ?? ""),
    label: String(l.label ?? ""),
    description: String(l.description ?? ""),
    quantity: Number(l.quantity ?? 1),
    unitPriceCents: Number(l.unitPriceCents ?? 0),
    amountCents: Number(l.amountCents ?? 0),
    optional: l.optional === true,
    selected: l.selected !== false,
    custom: l.custom === true,
  }));
}

async function loadRow(token: string): Promise<Db | null> {
  const db = admin();
  const { data, error } = await db.from("quotes").select("*").eq("public_token", token).maybeSingle();
  if (error) throw error;
  return data ?? null;
}

async function loadCompany(companyId: string | null): Promise<Db | null> {
  if (!companyId) return null;
  const db = admin();
  const { data } = await db.from("companies").select("*").eq("id", companyId).maybeSingle();
  return data ?? null;
}

function shape(row: Db, company: Db | null, state: QuotePageState): PublicQuote {
  return {
    token: row.public_token,
    quoteNumber: row.quote_number ?? null,
    title: row.title ?? null,
    introMessage: row.intro_message ?? null,
    currency: row.currency ?? "CAD",
    state,
    status: row.status as QuoteStatus,
    sentAt: row.sent_at ?? null,
    validUntil: row.valid_until ?? row.expires_at ?? null,
    // Once approved, show the FROZEN selection — not the live line_items, which an
    // admin could still have edited on a draft successor.
    lineItems: toPublicLines(row.approved_line_items ?? row.line_items),
    subtotalCents: row.approved_subtotal_cents ?? row.subtotal_cents,
    taxCents: row.approved_tax_cents ?? row.tax_cents,
    totalCents: row.approved_total_cents ?? row.total_cents,
    depositCents: row.approved_deposit_cents ?? row.deposit_cents,
    taxRateBps: row.tax_rate_bps,
    depositRateBps: row.deposit_rate_bps,
    depositFlatCents: row.deposit_flat_cents ?? null,
    approvedByName: row.approved_by_name ?? null,
    approvedAt: row.approved_at ?? null,
    depositPaidAt: row.deposit_paid_at ?? null,
    brand: companyBrand(company),
  };
}

/**
 * Fetch a quote for the public page and, on a first open of a sent quote, move it
 * to 'viewed'. Idempotent: the transition is attempted only from 'sent', and
 * first_viewed_at is written only when empty, so a refresh or a mail-client
 * prefetch cannot re-fire it.
 */
export async function getPublicQuote(token: string, now = new Date()): Promise<PublicQuote | null> {
  const row = await loadRow(token);
  if (!row) return null;

  if (row.status === "sent" && evaluateTransition("sent", "viewed") === "apply") {
    const db = admin();
    const { data: updated } = await db
      .from("quotes")
      .update({ status: "viewed", first_viewed_at: row.first_viewed_at ?? now.toISOString() })
      .eq("id", row.id)
      .eq("status", "sent") // guard: only one open wins the race
      .select("*")
      .maybeSingle();

    if (updated) {
      await recordPublicEvent(updated.organization_id, updated.id, "viewed", {});
      await emitQuoteTrigger(db, {
        organizationId: updated.organization_id,
        companyId: updated.company_id,
        contactId: updated.contact_id,
        quoteId: updated.id,
        eventType: "quote.viewed",
      });
      const company = await loadCompany(updated.company_id);
      return shape(updated, company, derivePageState(updated, now));
    }
  }

  const company = await loadCompany(row.company_id);
  return shape(row, company, derivePageState(row, now));
}

/**
 * The selection key of a stored line: `custom:{i}` (i = its position among the
 * custom lines, which is how the input snapshot orders them) for hand-priced
 * lines, the service id otherwise. The public page keys its checkboxes the same way.
 */
function storedLineKeys(raw: unknown): Array<{ key: string; line: PublicQuoteLine }> {
  let customIndex = 0;
  return toPublicLines(raw).map((line) => ({ key: line.custom ? `custom:${customIndex++}` : line.serviceId, line }));
}

/** The optional lines the quote was sent with ticked. */
function defaultSelection(row: Db): Set<string> {
  return new Set(storedLineKeys(row.line_items).filter((k) => k.line.optional && k.line.selected).map((k) => k.key));
}

/** The customer's choice, reduced to keys of optional lines that exist on the quote. */
function normalizedSelection(row: Db, selectedServiceIds: string[]): Set<string> {
  const optional = new Set(storedLineKeys(row.line_items).filter((k) => k.line.optional).map((k) => k.key));
  return new Set(selectedServiceIds.filter((id) => optional.has(id)));
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((v) => b.has(v));
}

/** The amounts the quote was SENT with — exactly what the customer was shown. */
function storedPricing(row: Db): QuotePricing {
  return {
    currency: "CAD",
    lineItems: toPublicLines(row.line_items).map((l) => ({ ...l, bundleEligible: false })),
    bundleId: row.bundle_id ?? null,
    bundleSavingsCents: 0,
    subtotalCents: row.subtotal_cents,
    taxRateBps: row.tax_rate_bps,
    taxCents: row.tax_cents,
    totalCents: row.total_cents,
    depositRateBps: row.deposit_rate_bps,
    depositFlatCents: row.deposit_flat_cents ?? null,
    depositCents: row.deposit_cents,
  };
}

/** Price a selection from the tenant's CURRENT catalog, under the terms the quote was issued with. */
async function priceSelection(row: Db, selected: Set<string>): Promise<QuotePricing | null> {
  if (!row.company_id) return null;
  const snap = (row.input_snapshot ?? {}) as Partial<QuotePricingInput>;
  const services = (snap.services ?? []).map((s) => ({
    ...s,
    // Required lines are unaffected; optional lines take the customer's choice.
    selected: s.optional ? selected.has(s.serviceId) : true,
  }));
  const customLines = (snap.customLines ?? []).map((l, i) => ({
    ...l,
    selected: l.optional ? selected.has(`custom:${i}`) : true,
  }));
  // Priced from the tenant's own catalog, so a customer toggling options gets
  // their supplier's prices — never a built-in default.
  return priceQuoteForCompany(row.company_id, {
    services,
    customLines,
    hullType: snap.hullType ?? undefined,
    bundleId: snap.bundleId ?? undefined,
    taxRateBps: row.tax_rate_bps,
    depositRateBps: row.deposit_rate_bps,
    // The policy the quote was ISSUED under — never the company's current one, so a
    // policy change can't move the deposit on a quote the customer already holds.
    depositFlatCents: row.deposit_flat_cents ?? null,
  });
}

/**
 * True when today's catalog still prices the quote's sent selection to exactly the
 * stored amounts — i.e. the prices behind this quote haven't moved since it was sent.
 */
function samePrices(fresh: QuotePricing, row: Db): boolean {
  if (fresh.subtotalCents !== row.subtotal_cents || fresh.totalCents !== row.total_cents || fresh.depositCents !== row.deposit_cents) {
    return false;
  }
  const stored = toPublicLines(row.line_items);
  return stored.length === fresh.lineItems.length && stored.every((l, i) => l.amountCents === fresh.lineItems[i]?.amountCents);
}

/**
 * The customer's options would be priced from a price list that has changed since
 * the quote was sent. Nothing is approved or charged; the owner is told.
 */
export class QuotePricesChangedError extends UserFacingError {
  constructor(businessName: string | null) {
    super(
      `Prices on this quote have changed. We've let ${businessName ?? "the business"} know — they'll send you an updated quote.`,
      { status: 409, code: "prices_changed" },
    );
    this.name = "QuotePricesChangedError";
  }
}

export type SelectionPricing =
  | { kind: "ok"; pricing: QuotePricing }
  | { kind: "prices_changed" };

/**
 * Totals for a customer's optional-line selection. Never trusts client money.
 *
 *   • The selection the quote was sent with → the STORED amounts, exactly. The
 *     customer is charged what the page showed, whatever the price list says today.
 *   • A different selection → priced from today's catalog, but only if that catalog
 *     still reproduces the stored amounts for the sent selection. If it doesn't,
 *     prices moved under the quote and any toggled total would be a new number the
 *     customer was never quoted → "prices_changed".
 */
export async function priceForSelection(token: string, selectedServiceIds: string[]): Promise<SelectionPricing | null> {
  const row = await loadRow(token);
  if (!row || !row.company_id) return null;
  return priceRowForSelection(row, selectedServiceIds);
}

async function priceRowForSelection(row: Db, selectedServiceIds: string[]): Promise<SelectionPricing | null> {
  const chosen = normalizedSelection(row, selectedServiceIds);
  const sent = defaultSelection(row);
  if (sameSet(chosen, sent)) return { kind: "ok", pricing: storedPricing(row) };

  const [asSent, forChoice] = await Promise.all([priceSelection(row, sent), priceSelection(row, chosen)]);
  if (!asSent || !forChoice) return null;
  if (!samePrices(asSent, row)) return { kind: "prices_changed" };
  return { kind: "ok", pricing: forChoice };
}

/** Back-compat: the pricing for a selection, or null (also when prices changed). */
export async function repriceForSelection(token: string, selectedServiceIds: string[]): Promise<QuotePricing | null> {
  const result = await priceForSelection(token, selectedServiceIds);
  return result?.kind === "ok" ? result.pricing : null;
}

/**
 * Tell the owner a customer tried to approve a quote whose prices have since
 * changed — once per quote (an event marks it), as a task on their list.
 * Best-effort: the customer's message doesn't depend on it.
 */
async function notifyOwnerPricesChanged(row: Db, attempted: { totalCents: number | null }): Promise<void> {
  try {
    const db = admin();
    const { data: already } = await db
      .from("quote_events")
      .select("id")
      .eq("quote_id", row.id)
      .eq("event_type", "approval_blocked_prices_changed")
      .limit(1)
      .maybeSingle();
    await recordPublicEvent(row.organization_id, row.id, "approval_blocked_prices_changed", {
      quotedTotalCents: row.total_cents,
      attemptedTotalCents: attempted.totalCents,
    });
    if (already) return;
    const ctx = { organizationId: row.organization_id, actorProfileId: null, supabase: db } as TenantServiceContext;
    await createTask(ctx, {
      title: `Send an updated quote${row.quote_number ? ` for ${row.quote_number}` : ""} — prices changed`.slice(0, 200),
      description:
        "Your customer tried to approve this quote with different options, but prices in your price list have changed since it was sent, " +
        "so it wasn't approved and nothing was charged. Open the quote, use Make a new version, check the prices and send it to them.",
      companyId: row.company_id,
      contactId: row.contact_id,
      priority: "high",
    });
  } catch (err) {
    console.error("[quotes] couldn't notify the owner about changed prices:", err instanceof Error ? err.message : err);
  }
}

export interface ApprovalInput {
  token: string;
  fullName: string;
  termsAccepted: boolean;
  selectedServiceIds: string[];
  /**
   * The total the page showed when the customer pressed Approve. When given, an
   * approval whose computed total differs is refused rather than charged.
   */
  expectedTotalCents?: number | null;
  ip?: string | null;
  userAgent?: string | null;
}

export class QuoteApprovalError extends UserFacingError {
  constructor(
    message: string,
    override readonly code: "not_found" | "not_approvable" | "terms" | "name",
  ) {
    super(message, { status: code === "not_found" ? 404 : code === "not_approvable" ? 409 : 400, code });
    this.name = "QuoteApprovalError";
  }
}

/**
 * Record an approval and freeze the amounts.
 *
 * The money written here is recomputed from the STORED pricing inputs plus the
 * customer's selection — the client sends which options it wants, never what they
 * cost. Everything downstream (the Checkout Session, the balance invoice) reads
 * these frozen columns, so a tampered payload cannot change a charge.
 *
 * Idempotent by design: approving an already-approved quote returns the existing
 * frozen approval rather than re-freezing it, so a double-tap on Approve yields
 * one approval (and, upstream, one Checkout Session).
 */
export async function approveQuote(input: ApprovalInput, now = new Date()): Promise<Db> {
  const row = await loadRow(input.token);
  if (!row) throw new QuoteApprovalError("Quote not found.", "not_found");

  const state = derivePageState(row, now);

  // Already approved (or paid) — hand back what was frozen. Not an error: the
  // customer may simply have double-tapped, or come back from a cancelled card
  // screen.
  if (row.approved_at) return row;

  if (!isApprovable(state)) {
    throw new QuoteApprovalError(
      state === "expired"
        ? "This quote has expired. Please contact us for an updated quote."
        : state === "replaced"
          ? "This quote has been replaced by an updated one. Please use the link in your most recent email."
          : "This quote can no longer be approved.",
      "not_approvable",
    );
  }
  if (!input.termsAccepted) {
    throw new QuoteApprovalError("The terms must be accepted.", "terms");
  }
  const name = input.fullName.trim();
  if (name.length < 2) {
    throw new QuoteApprovalError("A full name is required.", "name");
  }

  // The amounts frozen here are what the deposit charges and the invoice bills, so
  // they must be the amounts the customer was shown — never a fresh re-price.
  const priced = await priceRowForSelection(row, input.selectedServiceIds);
  if (!priced) throw new QuoteApprovalError("Quote not found.", "not_found");
  const shown = typeof input.expectedTotalCents === "number" ? input.expectedTotalCents : null;
  if (priced.kind === "prices_changed" || (shown !== null && priced.pricing.totalCents !== shown)) {
    await notifyOwnerPricesChanged(row, { totalCents: priced.kind === "ok" ? priced.pricing.totalCents : null });
    const company = await loadCompany(row.company_id);
    throw new QuotePricesChangedError(companyBrand(company).name);
  }
  const pricing = priced.pricing;

  assertTransition(row.status as QuoteStatus, "approved");

  const db = admin();
  const { data, error } = await db
    .from("quotes")
    .update({
      status: "approved",
      approved_at: now.toISOString(),
      approved_by_name: name,
      approved_ip: input.ip ?? null,
      approved_user_agent: input.userAgent ?? null,
      terms_accepted: true,
      approved_line_items: pricing.lineItems,
      approved_subtotal_cents: pricing.subtotalCents,
      approved_tax_cents: pricing.taxCents,
      approved_total_cents: pricing.totalCents,
      approved_deposit_cents: pricing.depositCents,
      // Keep the live columns in step so admin views agree with the page.
      line_items: pricing.lineItems,
      subtotal_cents: pricing.subtotalCents,
      tax_cents: pricing.taxCents,
      total_cents: pricing.totalCents,
      deposit_cents: pricing.depositCents,
    })
    .eq("id", row.id)
    // Guard the race: only the first approval of a not-yet-approved row wins.
    .is("approved_at", null)
    .select("*")
    .maybeSingle();

  if (error) throw error;
  // Lost the race — someone approved between our read and write. Return theirs.
  if (!data) return (await loadRow(input.token))!;

  await recordPublicEvent(data.organization_id, data.id, "approved", {
    approvedByName: name,
    totalCents: data.approved_total_cents,
    depositCents: data.approved_deposit_cents,
  });
  await emitQuoteTrigger(db, {
    organizationId: data.organization_id,
    companyId: data.company_id,
    contactId: data.contact_id,
    quoteId: data.id,
    eventType: "quote.approved",
  });

  return data;
}

/** Append a quote_event from the public side (service role). Best-effort. */
export async function recordPublicEvent(
  organizationId: string,
  quoteId: string,
  eventType: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    const db = admin();
    await db.from("quote_events").insert({
      organization_id: organizationId,
      quote_id: quoteId,
      event_type: eventType,
      metadata,
    });
  } catch (err) {
    console.error(`[quotes] failed to record public '${eventType}' event:`, err);
  }
}
