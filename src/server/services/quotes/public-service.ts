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
import { calculateQuote } from "@a1/pricing-engine";

import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { assertTransition, evaluateTransition, type QuoteStatus } from "./lifecycle";
import { priceQuote, type QuotePricing, type QuotePricingInput } from "./pricing";

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
  /** Frozen at approval; present only once approved. */
  approvedByName: string | null;
  approvedAt: string | null;
  /** Set once the deposit is paid, for the confirmation state. */
  depositPaidAt: string | null;
  org: {
    name: string | null;
    logoUrl: string | null;
    brandPrimary: string | null;
    brandAccent: string | null;
    cancellationPolicy: string | null;
    termsText: string | null;
    replyPhone: string | null;
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

/** Org theming for the page. Missing columns degrade to null, never to a crash. */
function orgTheme(org: Db | null): PublicQuote["org"] {
  const settings = (org?.settings ?? {}) as Record<string, unknown>;
  const str = (k: string): string | null => {
    const v = settings[k];
    return typeof v === "string" && v.trim().length > 0 ? v : null;
  };
  return {
    name: org?.name ?? null,
    logoUrl: str("quote_logo_url") ?? str("logo_url"),
    brandPrimary: str("brand_primary"),
    brandAccent: str("brand_accent"),
    cancellationPolicy: str("cancellation_policy"),
    termsText: str("quote_terms_text"),
    replyPhone: str("reply_phone"),
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

async function loadOrg(organizationId: string): Promise<Db | null> {
  const db = admin();
  const { data } = await db.from("organizations").select("*").eq("id", organizationId).maybeSingle();
  return data ?? null;
}

function shape(row: Db, org: Db | null, state: QuotePageState): PublicQuote {
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
    approvedByName: row.approved_by_name ?? null,
    approvedAt: row.approved_at ?? null,
    depositPaidAt: row.deposit_paid_at ?? null,
    org: orgTheme(org),
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
      const org = await loadOrg(updated.organization_id);
      return shape(updated, org, derivePageState(updated, now));
    }
  }

  const org = await loadOrg(row.organization_id);
  return shape(row, org, derivePageState(row, now));
}

/** Recompute totals for a customer's optional-line selection. Never trusts client money. */
export async function repriceForSelection(
  token: string,
  selectedServiceIds: string[],
): Promise<QuotePricing | null> {
  const row = await loadRow(token);
  if (!row) return null;

  const snap = (row.input_snapshot ?? {}) as Partial<QuotePricingInput>;
  const selected = new Set(selectedServiceIds);

  const services = (snap.services ?? []).map((s) => ({
    ...s,
    // Required lines are unaffected; optional lines take the customer's choice.
    selected: s.optional ? selected.has(s.serviceId) : true,
  }));
  const customLines = (snap.customLines ?? []).map((l, i) => ({
    ...l,
    selected: l.optional ? selected.has(`custom:${i}`) : true,
  }));

  return priceQuote({
    services,
    customLines,
    hullType: snap.hullType ?? undefined,
    bundleId: snap.bundleId ?? undefined,
    taxRateBps: row.tax_rate_bps,
    depositRateBps: row.deposit_rate_bps,
  });
}

export interface ApprovalInput {
  token: string;
  fullName: string;
  termsAccepted: boolean;
  selectedServiceIds: string[];
  ip?: string | null;
  userAgent?: string | null;
}

export class QuoteApprovalError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "not_approvable" | "terms" | "name",
  ) {
    super(message);
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
    throw new QuoteApprovalError(`This quote can no longer be approved (${state}).`, "not_approvable");
  }
  if (!input.termsAccepted) {
    throw new QuoteApprovalError("The terms must be accepted.", "terms");
  }
  const name = input.fullName.trim();
  if (name.length < 2) {
    throw new QuoteApprovalError("A full name is required.", "name");
  }

  const pricing = await repriceForSelection(input.token, input.selectedServiceIds);
  if (!pricing) throw new QuoteApprovalError("Quote not found.", "not_found");

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

/** Exported for the engine-availability check in tests. */
export const __enginePresent = typeof calculateQuote === "function";
