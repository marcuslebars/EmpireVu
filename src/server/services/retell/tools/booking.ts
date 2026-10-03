// ─────────────────────────────────────────────────────────────────────────────
// SANCTIONED EXCEPTION #4 (Retell, continued): Marina's booking + deposit tools run with
// the service-role client because Retell has no user session. The company is resolved
// from the CALL (resolveRetellTenant, never a legacy guess), and every read or write is
// pinned to that company: a quote_id from the model is only honoured when it belongs to
// the company the caller dialled.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Marina's `check_availability`, `book_wrap_date` and `send_deposit_link` tools.
 *
 * Replaces the Care site's /api/retell/functions/{availability,book,deposit-link}, with the
 * same argument names. Differences that matter:
 *   • Windows, capacity and lead time are the company's booking policy
 *     (companies.booking_policy), not constants.
 *   • Capacity counts EVERY booking the crew has in that window — including jobs added by
 *     hand in the app — not only phone bookings.
 *   • The deposit link is the quote's hosted page (/q/{token}): the customer approves the
 *     quote and pays the deposit there, on the company's own Stripe account, with the
 *     company's terms shown. Marina still can't and won't take a card on the phone.
 */
import type { Tables } from "@/server/db/database.types";
import {
  checkWindow,
  findOpenWindows,
  isValidDateString,
  parseBookingPolicy,
  parseWindowKey,
  spokenWindowLabel,
  zonedInstant,
  addDays,
  type BookingPolicy,
  type BusyBooking,
  type OpenWindow,
} from "@/server/services/booking-windows";
import { getBusinessTimezone } from "@/server/services/ai";
import { quoteLinkForCompanyId } from "@/server/services/quotes/public-url";
import type { TenantServiceContext } from "@/server/services/shared";
import { deliverMessage, type ConsentContact } from "@/server/services/workflow-engine/messaging";
import { emitActivityEventAndDispatch } from "@/server/services/workflow-engine/dispatch";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { DEFAULT_AGENT_NAME, formatDollars, loadGreetingContext } from "../caller-lookup";
import { getRetellConfig } from "../config";
import type { RetellFunctionRequest } from "../functions";
import { toE164 } from "../payload";
import { createRetellAdminClient, resolveRetellTenant } from "../tenant";
import { spokenDollars } from "./phone-quote";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

export interface AvailabilityArgs {
  preferred_date?: unknown;
  preferred_window?: unknown;
}
export interface BookArgs {
  quote_id?: unknown;
  date?: unknown;
  window?: unknown;
}
export interface DepositLinkArgs {
  quote_id?: unknown;
  phone?: unknown;
  email?: unknown;
}

/** A company Marina may book for: resolved from the call, with a window policy. */
export interface BookingTenant {
  organizationId: string;
  companyId: string;
  companyName: string;
  agentName: string;
  timeZone: string;
  policy: BookingPolicy;
}

export interface QuoteForBooking {
  id: string;
  organization_id: string;
  company_id: string;
  contact_id: string | null;
  public_token: string;
  quote_number: string | null;
  title: string | null;
  status: string;
  subtotal_cents: number;
  deposit_cents: number;
  deposit_flat_cents: number | null;
  deposit_paid_at: string | null;
  input_snapshot: unknown;
}

export interface ContactForMessage extends ConsentContact {
  id: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  email: string | null;
}

export interface BookingDeps {
  /** null when the call isn't mapped to a company that books by window. */
  resolveBookingTenant(req: RetellFunctionRequest<unknown>): Promise<BookingTenant | null>;
  loadBusy(tenant: BookingTenant, fromDate: string, toDate: string): Promise<BusyBooking[]>;
  loadQuote(tenant: BookingTenant, quoteId: string): Promise<QuoteForBooking | null>;
  loadContact(tenant: BookingTenant, contactId: string): Promise<ContactForMessage | null>;
  findBookingForCall(tenant: BookingTenant, quoteId: string, callId: string): Promise<Tables<"bookings"> | null>;
  nextBookingForQuote(tenant: BookingTenant, quoteId: string): Promise<Tables<"bookings"> | null>;
  insertBooking(tenant: BookingTenant, row: NewBooking): Promise<{ booking: Tables<"bookings">; duplicate: boolean }>;
  sendText(tenant: BookingTenant, to: { phone: string; contact: ContactForMessage | null }, body: string): Promise<{ status: string; reason?: string }>;
  sendEmail(tenant: BookingTenant, to: { email: string; contact: ContactForMessage | null }, subject: string, body: string): Promise<{ status: string; reason?: string }>;
  recordQuoteEvent(tenant: BookingTenant, quoteId: string, eventType: string, metadata: Record<string, unknown>): Promise<void>;
  /** Marina told the caller the owner will text the link — make sure the owner knows. Optional; best-effort. */
  reportLinkFailure?(tenant: BookingTenant, failure: { quoteId: string; contactId: string | null; why: string }): Promise<void>;
  /** The customer link — on the tenant company's own quote domain when it has one. */
  quoteUrl(token: string, tenant?: BookingTenant): string | Promise<string>;
  now(): Date;
}

export interface NewBooking {
  quoteId: string;
  contactId: string | null;
  window: OpenWindow;
  title: string;
  description: string;
  callId: string | null;
}

const SAY_NO_CALENDAR =
  "I can't book that from here, but I've got your details — the owner will call you to set the date.";
const SAY_CALENDAR_ERROR = "I can't see the calendar right now — the owner will call you within the hour to set the date.";
const SAY_QUOTE_NOT_FOUND = "I couldn't find that quote on my end. Let me redo it quickly.";

function text(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function joinOr(labels: string[]): string {
  return labels.join(", or ");
}

/** "Mobile shrink wrap — Dana Lee (24 ft bowrider)". */
function bookingTitle(quote: QuoteForBooking, contact: ContactForMessage | null): string {
  const who = contact ? [contact.first_name, contact.last_name].filter(Boolean).join(" ") : "";
  const what = quote.title?.split(" — ")[0] || "Booking";
  const boat = quote.title?.includes(" — ") ? quote.title.split(" — ").slice(1).join(" — ") : null;
  return [what, who ? `— ${who}` : null, boat ? `(${boat})` : null].filter(Boolean).join(" ");
}

// ── check_availability ─────────────────────────────────────────────────────────

export type AvailabilityResponse =
  | { ok: true; preferred_open?: boolean; slots: { date: string; window: string; label: string }[]; say: string }
  | { ok: false; reason: "unsupported" | "error"; say: string };

export async function runAvailability(
  req: RetellFunctionRequest<AvailabilityArgs>,
  deps: BookingDeps = defaultBookingDeps,
): Promise<AvailabilityResponse> {
  const tenant = await deps.resolveBookingTenant(req);
  if (!tenant) return { ok: false, reason: "unsupported", say: SAY_NO_CALENDAR };

  const preferredDate = isValidDateString(req.args.preferred_date) ? req.args.preferred_date : null;
  const preferredWindow = parseWindowKey(req.args.preferred_window, tenant.policy);
  const now = deps.now();

  try {
    const slots = await openWindows(deps, tenant, now, { preferredDate, preferredWindow, limit: 3 });
    if (slots.length === 0) {
      return {
        ok: true,
        slots: [],
        say: `I don't have an opening in the next ${Math.round(tenant.policy.horizonDays / 7)} weeks — the owner will call you to squeeze it in.`,
      };
    }
    const preferredOpen = Boolean(
      preferredDate && preferredWindow && slots[0].date === preferredDate && slots[0].windowKey === preferredWindow,
    );
    return {
      ok: true,
      preferred_open: preferredOpen,
      slots: slots.map((s) => ({ date: s.date, window: s.windowKey, label: s.label })),
      say: preferredOpen
        ? `${slots[0].label} is open.`
        : `The next openings are ${joinOr(slots.map((s) => s.label))}.`,
    };
  } catch (err) {
    console.error("[retell:availability] failed:", err instanceof Error ? err.message : err);
    return { ok: false, reason: "error", say: SAY_CALENDAR_ERROR };
  }
}

async function openWindows(
  deps: BookingDeps,
  tenant: BookingTenant,
  now: Date,
  q: { preferredDate: string | null; preferredWindow: string | null; limit: number },
): Promise<OpenWindow[]> {
  const from = new Intl.DateTimeFormat("en-CA", { timeZone: tenant.timeZone }).format(now);
  const to = addDays(from, tenant.policy.horizonDays + 2 + Math.ceil(tenant.policy.leadTimeHours / 24));
  const bookings = await deps.loadBusy(tenant, from, to);
  return findOpenWindows({ now, timeZone: tenant.timeZone, policy: tenant.policy, bookings, ...q });
}

// ── book_wrap_date ─────────────────────────────────────────────────────────────

export type BookResponse =
  | { ok: true; booking_id: string; date: string; window: string; label: string; duplicate: boolean; say: string }
  | {
      ok: false;
      reason: "missing_info" | "unsupported" | "quote_not_found" | "not_bookable" | "slot_taken" | "error";
      missing?: string[];
      alternatives?: { date: string; window: string; label: string }[];
      say: string;
    };

export async function runBook(req: RetellFunctionRequest<BookArgs>, deps: BookingDeps = defaultBookingDeps): Promise<BookResponse> {
  const tenant = await deps.resolveBookingTenant(req);
  if (!tenant) return { ok: false, reason: "unsupported", say: SAY_NO_CALENDAR };

  const quoteId = text(req.args.quote_id);
  const date = isValidDateString(req.args.date) ? (req.args.date as string) : null;
  const windowKey = parseWindowKey(req.args.window, tenant.policy);
  const missing: string[] = [];
  if (!quoteId) missing.push("quote_id");
  if (!date) missing.push("date");
  if (!windowKey) missing.push("window");
  if (missing.length > 0) {
    const windows = tenant.policy.windows.map((w) => w.key).join(" or ");
    return { ok: false, reason: "missing_info", missing, say: `I need the quote, the date, and ${windows}.` };
  }

  try {
    const quote = await deps.loadQuote(tenant, quoteId!);
    if (!quote) return { ok: false, reason: "quote_not_found", say: SAY_QUOTE_NOT_FOUND };

    // Same call + same quote → same booking (a retried or repeated tool call).
    if (req.call.callId) {
      const existing = await deps.findBookingForCall(tenant, quote.id, req.call.callId);
      if (existing) return alreadyBooked(existing, tenant);
    }

    const now = deps.now();
    const dayBookings = await deps.loadBusy(tenant, addDays(date!, -1), addDays(date!, 1));
    const check = checkWindow({ now, timeZone: tenant.timeZone, policy: tenant.policy, bookings: dayBookings, date: date!, windowKey: windowKey! });
    if ("reason" in check) {
      const alternatives = await openWindows(deps, tenant, now, {
        preferredDate: check.reason === "full" ? date : null,
        preferredWindow: windowKey,
        limit: 3,
      });
      const lead = check.reason === "full" ? "That window just filled up. Closest openings are" : "That's too soon for the crew to route. The next openings are";
      return {
        ok: false,
        reason: check.reason === "full" ? "slot_taken" : "not_bookable",
        alternatives: alternatives.map((s) => ({ date: s.date, window: s.windowKey, label: s.label })),
        say: alternatives.length ? `${lead} ${joinOr(alternatives.map((s) => s.label))}.` : `${lead.split(".")[0]}. The owner will call you to find a date.`,
      };
    }

    const contact = quote.contact_id ? await deps.loadContact(tenant, quote.contact_id) : null;
    const { booking, duplicate } = await deps.insertBooking(tenant, {
      quoteId: quote.id,
      contactId: quote.contact_id,
      window: check.window,
      title: bookingTitle(quote, contact),
      description: [
        `Booked by ${tenant.agentName} on the phone.`,
        `Quoted ${formatDollars(quote.subtotal_cents)} + HST${quote.quote_number ? ` (${quote.quote_number})` : ""}.`,
        req.call.callId ? `Retell call ${req.call.callId}.` : null,
      ]
        .filter(Boolean)
        .join("\n"),
      callId: req.call.callId,
    });
    if (duplicate) return alreadyBooked(booking, tenant);

    return {
      ok: true,
      booking_id: booking.id,
      date: check.window.date,
      window: check.window.windowKey,
      label: check.window.label,
      duplicate: false,
      say: `You're booked for ${check.window.label}. We'll text to confirm the arrival time the day before.`,
    };
  } catch (err) {
    console.error("[retell:book] failed:", err instanceof Error ? err.message : err);
    return { ok: false, reason: "error", say: "The booking didn't save. The owner will call you within the hour to lock it in." };
  }
}

function labelForBooking(b: Pick<Tables<"bookings">, "scheduled_for" | "window_key">, tenant: BookingTenant): string {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: tenant.timeZone }).format(new Date(b.scheduled_for));
  const w = tenant.policy.windows.find((x) => x.key === b.window_key) ?? tenant.policy.windows[0];
  return spokenWindowLabel(date, w);
}

function alreadyBooked(b: Tables<"bookings">, tenant: BookingTenant): BookResponse {
  const label = labelForBooking(b, tenant);
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: tenant.timeZone }).format(new Date(b.scheduled_for));
  return {
    ok: true,
    booking_id: b.id,
    date,
    window: b.window_key ?? "",
    label,
    duplicate: true,
    say: `You're already booked for ${label}.`,
  };
}

// ── send_deposit_link ──────────────────────────────────────────────────────────

export type DepositLinkResponse =
  | { ok: true; sent_by: Array<"sms" | "email">; amount_dollars: number; say: string }
  | {
      ok: false;
      reason: "missing_info" | "unsupported" | "quote_not_found" | "already_paid" | "not_payable" | "no_channel" | "send_failed" | "error";
      say: string;
    };

const SAY_LINK_FAILED =
  "The link didn't send just now, so I've noted the spot as held — the owner will text it to you within the hour. Is this the best number for that?";

export async function runDepositLink(
  req: RetellFunctionRequest<DepositLinkArgs>,
  deps: BookingDeps = defaultBookingDeps,
): Promise<DepositLinkResponse> {
  const tenant = await deps.resolveBookingTenant(req);
  if (!tenant) return { ok: false, reason: "unsupported", say: SAY_LINK_FAILED };

  const quoteId = text(req.args.quote_id);
  if (!quoteId) return { ok: false, reason: "missing_info", say: "I need the quote first — let me price it." };

  let contactIdForAlert: string | null = null;
  const tellOwner = async (why: string) => {
    try {
      await deps.reportLinkFailure?.(tenant, { quoteId, contactId: contactIdForAlert, why });
    } catch (err) {
      console.error("[retell:deposit-link] owner alert failed:", err instanceof Error ? err.message : err);
    }
  };

  try {
    const quote = await deps.loadQuote(tenant, quoteId);
    if (!quote) return { ok: false, reason: "quote_not_found", say: SAY_QUOTE_NOT_FOUND };
    if (quote.deposit_paid_at) {
      return {
        ok: false,
        reason: "already_paid",
        say: "Good news — the deposit for that one is already paid, so the spot is held. Nothing more to pay today.",
      };
    }
    contactIdForAlert = quote.contact_id ?? null;
    if (!["sent", "viewed", "approved"].includes(quote.status)) {
      await tellOwner("the quote isn't ready to pay");
      return { ok: false, reason: "not_payable", say: SAY_LINK_FAILED };
    }

    const contact = quote.contact_id ? await deps.loadContact(tenant, quote.contact_id) : null;
    const phone = toE164(text(req.args.phone)) ?? toE164(contact?.phone ?? null) ?? toE164(req.call.fromNumber);
    const email = text(req.args.email) ?? contact?.email ?? null;
    if (!phone && !email) return { ok: false, reason: "no_channel", say: "I need a mobile number or an email to send the link to." };

    const booking = await deps.nextBookingForQuote(tenant, quote.id);
    const holds = booking ? labelForBooking(booking, tenant).replace(/(\d+)(st|nd|rd|th)\b/, "$1") : "your date";
    const deposit = spokenDollars(quote.deposit_cents);
    const url = await deps.quoteUrl(quote.public_token, tenant);
    const firstName = contact?.first_name?.trim() || "there";
    const offInvoice = quote.deposit_flat_cents != null ? " (it comes off your final invoice)" : "";
    const body =
      `Hi ${firstName}, it's ${tenant.agentName} from ${tenant.companyName}. Here's your quote — ` +
      `${spokenDollars(quote.subtotal_cents)} + HST. Tap to approve it and pay the ${deposit} deposit ` +
      `that holds ${holds}${offInvoice}: ${url}`;

    const sentBy: Array<"sms" | "email"> = [];
    let lastReason: string | undefined;
    if (phone) {
      const r = await deps.sendText(tenant, { phone, contact }, body);
      if (r.status === "sent") sentBy.push("sms");
      else lastReason = r.reason;
    }
    if (email && (sentBy.length === 0 || text(req.args.email))) {
      const r = await deps.sendEmail(
        tenant,
        { email, contact },
        `Hold your date — ${deposit} deposit`,
        `${body}\n\n— ${tenant.agentName}, ${tenant.companyName}`,
      );
      if (r.status === "sent") sentBy.push("email");
      else lastReason = lastReason ?? r.reason;
    }

    if (sentBy.length === 0) {
      console.error(`[retell:deposit-link] nothing sent for quote ${quote.id}: ${lastReason ?? "unknown"}`);
      await tellOwner(phone && email ? "text and email both failed" : phone ? "the text failed" : "the email failed");
      return { ok: false, reason: "send_failed", say: SAY_LINK_FAILED };
    }

    await deps.recordQuoteEvent(tenant, quote.id, "deposit_link_sent", {
      channels: sentBy,
      by: "marina",
      callId: req.call.callId,
    });

    const where = sentBy.includes("sms") ? "texted you" : "emailed you";
    return {
      ok: true,
      sent_by: sentBy,
      amount_dollars: Math.round(quote.deposit_cents) / 100,
      say:
        `I've just ${where} the link. Tap it to approve the quote and pay the ${deposit} deposit` +
        `${quote.deposit_flat_cents != null ? " — it comes straight off your final invoice" : ""}.`,
    };
  } catch (err) {
    console.error("[retell:deposit-link] failed:", err instanceof Error ? err.message : err);
    await tellOwner("something went wrong sending it");
    return { ok: false, reason: "error", say: SAY_LINK_FAILED };
  }
}

// ── Production wiring ───────────────────────────────────────────────────────────

function admin(): Db {
  return createSupabaseAdminClient() as Db;
}

function serviceContext(tenant: BookingTenant): TenantServiceContext {
  return { organizationId: tenant.organizationId, actorProfileId: null, supabase: createSupabaseAdminClient() };
}

export const defaultBookingDeps: BookingDeps = {
  async resolveBookingTenant(req) {
    const adminClient = createRetellAdminClient();
    const tenant = await resolveRetellTenant(adminClient, {
      toNumber: req.call.toNumber,
      agentId: req.call.agentId,
      legacySourceSite: getRetellConfig().sourceSite,
    });
    // Same rule as quoting: never act on the legacy env guess.
    if (!tenant.organizationId || !tenant.companyId || tenant.resolvedBy === "legacy") return null;
    const { data: company } = await admin()
      .from("companies")
      .select("booking_policy, timezone")
      .eq("id", tenant.companyId)
      .eq("organization_id", tenant.organizationId)
      .maybeSingle();
    const policy = parseBookingPolicy(company?.booking_policy ?? null);
    if (!policy) return null;
    const greeting = await loadGreetingContext(adminClient, tenant.companyId);
    return {
      organizationId: tenant.organizationId,
      companyId: tenant.companyId,
      companyName: greeting.companyName || "us",
      agentName: greeting.agentName || DEFAULT_AGENT_NAME,
      timeZone: company?.timezone || getBusinessTimezone(),
      policy,
    };
  },

  async loadBusy(tenant, fromDate, toDate) {
    const { data, error } = await admin()
      .from("bookings")
      .select("scheduled_for, duration_minutes, window_key")
      .eq("organization_id", tenant.organizationId)
      .eq("company_id", tenant.companyId)
      .neq("status", "cancelled")
      .gte("scheduled_for", zonedInstant(fromDate, "00:00", tenant.timeZone).toISOString())
      .lt("scheduled_for", zonedInstant(addDays(toDate, 1), "00:00", tenant.timeZone).toISOString());
    if (error) throw error;
    return ((data ?? []) as Array<{ scheduled_for: string; duration_minutes: number | null; window_key: string | null }>).map(
      (b) => ({ scheduledFor: b.scheduled_for, durationMinutes: b.duration_minutes ?? 30, windowKey: b.window_key }),
    );
  },

  async loadQuote(tenant, quoteId) {
    if (!/^[0-9a-f-]{36}$/i.test(quoteId)) return null;
    const { data, error } = await admin()
      .from("quotes")
      .select(
        "id, organization_id, company_id, contact_id, public_token, quote_number, title, status, subtotal_cents, deposit_cents, deposit_flat_cents, deposit_paid_at, input_snapshot",
      )
      .eq("id", quoteId)
      .eq("organization_id", tenant.organizationId)
      .eq("company_id", tenant.companyId)
      .maybeSingle();
    if (error) throw error;
    return (data as QuoteForBooking | null) ?? null;
  },

  async loadContact(tenant, contactId) {
    const { data } = await admin()
      .from("contacts")
      .select("id, first_name, last_name, phone, email, sms_opt_out_at, email_opt_out_at, sms_consent_at, consent_source")
      .eq("id", contactId)
      .eq("organization_id", tenant.organizationId)
      .maybeSingle();
    return (data as ContactForMessage | null) ?? null;
  },

  async findBookingForCall(tenant, quoteId, callId) {
    const { data } = await admin()
      .from("bookings")
      .select("*")
      .eq("organization_id", tenant.organizationId)
      .eq("quote_id", quoteId)
      .eq("source_call_id", callId)
      .maybeSingle();
    return (data as Tables<"bookings"> | null) ?? null;
  },

  async nextBookingForQuote(tenant, quoteId) {
    const { data } = await admin()
      .from("bookings")
      .select("*")
      .eq("organization_id", tenant.organizationId)
      .eq("quote_id", quoteId)
      .neq("status", "cancelled")
      .order("scheduled_for", { ascending: true })
      .limit(1)
      .maybeSingle();
    return (data as Tables<"bookings"> | null) ?? null;
  },

  async insertBooking(tenant, row) {
    const db = admin();
    const { data, error } = await db
      .from("bookings")
      .insert({
        organization_id: tenant.organizationId,
        company_id: tenant.companyId,
        contact_id: row.contactId,
        quote_id: row.quoteId,
        title: row.title,
        description: row.description,
        scheduled_for: row.window.startsAt,
        duration_minutes: row.window.durationMinutes,
        status: "pending",
        window_key: row.window.windowKey,
        source: "marina",
        source_call_id: row.callId,
        created_by: null,
      })
      .select("*")
      .single();

    if (error) {
      // The (quote_id, source_call_id) unique index: a concurrent retry got there first.
      if ((error as { code?: string }).code === "23505" && row.callId) {
        const existing = await defaultBookingDeps.findBookingForCall(tenant, row.quoteId, row.callId);
        if (existing) return { booking: existing, duplicate: true };
      }
      throw error;
    }
    const booking = data as Tables<"bookings">;

    // booking.created → automations (reminders, owner alert). Best-effort: the booking is saved.
    try {
      await emitActivityEventAndDispatch(serviceContext(tenant), {
        companyId: tenant.companyId,
        entityId: booking.id,
        entityType: "booking",
        eventType: "booking.created",
        metadata: {
          bookingId: booking.id,
          scheduledFor: booking.scheduled_for,
          status: booking.status,
          source: "marina",
          window: row.window.windowKey,
          quoteId: row.quoteId,
        },
        relatedEntityId: booking.contact_id,
        relatedEntityType: booking.contact_id ? "contact" : null,
      });
    } catch (err) {
      console.error("[retell:book] booking.created dispatch failed (non-fatal):", err instanceof Error ? err.message : err);
    }
    return { booking, duplicate: false };
  },

  async sendText(tenant, to, body) {
    return deliverMessage({
      context: serviceContext(tenant),
      channel: "sms",
      to: to.phone,
      body,
      companyId: tenant.companyId,
      contactId: to.contact?.id ?? null,
      consentContact: to.contact,
    });
  },

  async sendEmail(tenant, to, subject, body) {
    return deliverMessage({
      context: serviceContext(tenant),
      channel: "email",
      to: to.email,
      subject,
      body,
      fromName: tenant.companyName,
      companyId: tenant.companyId,
      contactId: to.contact?.id ?? null,
      consentContact: to.contact,
    });
  },

  async recordQuoteEvent(tenant, quoteId, eventType, metadata) {
    try {
      await admin().from("quote_events").insert({
        organization_id: tenant.organizationId,
        quote_id: quoteId,
        event_type: eventType,
        actor_profile_id: null,
        metadata,
      });
    } catch (err) {
      console.error(`[retell] failed to record '${eventType}':`, err instanceof Error ? err.message : err);
    }
  },

  async reportLinkFailure(tenant, failure) {
    await emitActivityEventAndDispatch(serviceContext(tenant), {
      companyId: tenant.companyId,
      entityId: failure.contactId ?? tenant.companyId,
      entityType: failure.contactId ? "contact" : "company",
      eventType: "quote.deposit_link_failed",
      metadata: { quoteId: failure.quoteId, contactId: failure.contactId, failureReason: failure.why },
    });
  },

  async quoteUrl(token, tenant) {
    return quoteLinkForCompanyId(tenant?.companyId, token, admin());
  },

  now() {
    return new Date();
  },
};
