/**
 * The side-effecting building blocks the SMS agent's tools (and approved actions) use, behind
 * one injectable interface so tests can swap any of them. Every one is pinned to the company it
 * is given — the model never chooses an organization, company or contact.
 */
import type { Tables } from "@/server/db/database.types";
import { zonedInstant, type BusyBooking } from "@/server/services/booking-windows";
import { SMS_AGENT_SENDER, type AdminClient } from "@/server/services/front-desk/contracts";
import { OWNER_ALERTS_SUMMARY, ownerAlertGate } from "@/server/services/owner-channel/common";
import { notifyOnlineBooking } from "@/server/services/push/notify";
import { priceQuoteForCompany, type QuotePricing, type QuoteServiceInput } from "@/server/services/quotes/pricing";
import { quoteLinkForCompanyId } from "@/server/services/quotes/public-url";
import { createQuote, sendQuote } from "@/server/services/quotes/service";
import {
  availabilityForTenant,
  bookForTenant,
  defaultBookingDeps,
  type AvailabilityResponse,
  type BookingTenant,
  type BookResponse,
} from "@/server/services/retell/tools/booking";
import { openTimes, presentOpenTimes } from "@/server/services/scheduling/rules";
import type { TenantServiceContext } from "@/server/services/shared";
import type { BusinessFacts } from "@/server/services/sms-agent/facts";
import { emitActivityEventAndDispatch } from "@/server/services/workflow-engine/dispatch";
import {
  deliverMessage,
  resolveOwnerContacts,
  type ConsentContact,
  type DeliverMessageResult,
} from "@/server/services/workflow-engine/messaging";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

export { SMS_AGENT_SENDER };

export interface AgentContact extends ConsentContact {
  id: string;
  organization_id: string;
  company_id: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  email: string | null;
  notes: string | null;
  metadata: unknown;
}

export interface QuoteLine {
  service_key: string;
  quantity?: number;
  measure?: number;
  choices?: Record<string, string>;
}

export interface CustomLine {
  label: string;
  amountCents: number;
}

export interface SentQuote {
  quoteId: string;
  url: string;
  subtotalCents: number;
  totalCents: number;
  quoteNumber: string | null;
  title: string;
}

export interface OpenSlot {
  /** For windows mode: YYYY-MM-DD + window key. For hourly: the ISO start. */
  date: string;
  window: string | null;
  startsAt: string | null;
  label: string;
}

export type AvailabilityResult =
  | { ok: true; slots: OpenSlot[]; mode: "windows" | "hourly" }
  | { ok: false; reason: "no_online_booking" | "error"; message: string };

export type BookSlotResult =
  | { ok: true; bookingId: string; label: string; duplicate: boolean; quote?: SentQuote | null }
  | {
      ok: false;
      reason: "no_online_booking" | "needs_quote" | "not_open" | "deposit_required" | "error";
      message: string;
      alternatives?: OpenSlot[];
    };

/** Just enough of the company to message on its behalf. */
export type CompanyRef = Pick<BusinessFacts, "organizationId" | "companyId" | "businessName">;

export interface AgentServices {
  /** Price-list lines → priced quote (throws CatalogError on unknown service / manual-quote items). */
  priceServices(companyId: string, lines: QuoteLine[]): Promise<QuotePricing>;
  /** Create + send (status sent, numbered) a quote from price-list lines and/or owner-approved custom lines. */
  createAndSendQuote(
    admin: AdminClient,
    facts: BusinessFacts,
    input: { contactId: string; lines?: QuoteLine[]; customLines?: CustomLine[]; title: string },
  ): Promise<SentQuote>;
  checkAvailability(
    admin: AdminClient,
    facts: BusinessFacts,
    input: { preferredDate?: string | null; preferredWindow?: string | null; limit?: number },
  ): Promise<AvailabilityResult>;
  bookSlot(
    admin: AdminClient,
    facts: BusinessFacts,
    input: { contact: AgentContact; date?: string | null; window?: string | null; startsAt?: string | null; quoteId?: string | null; lines?: QuoteLine[]; note?: string | null },
  ): Promise<BookSlotResult>;
  /** Text the customer (company number, consent, STOP footer, message_log sent_by=sms_agent). */
  textCustomer(admin: AdminClient, facts: CompanyRef, contact: AgentContact, body: string): Promise<DeliverMessageResult>;
  /** Tell the owner (their phone from the platform number, else email). Best-effort. */
  alertOwner(admin: AdminClient, facts: CompanyRef, body: string, subject?: string): Promise<{ sent: boolean }>;
  recordQuoteEvent(admin: AdminClient, facts: BusinessFacts, quoteId: string, eventType: string, metadata: Record<string, unknown>): Promise<void>;
  now(): Date;
}

function serviceContext(admin: AdminClient, facts: Pick<BusinessFacts, "organizationId">): TenantServiceContext {
  return { organizationId: facts.organizationId, actorProfileId: null, supabase: admin as unknown as TenantServiceContext["supabase"] };
}

export function toQuoteServices(lines: QuoteLine[]): QuoteServiceInput[] {
  return lines.map((l) => ({
    serviceId: l.service_key,
    ...(l.quantity ? { quantity: l.quantity } : {}),
    ...(l.measure ? { lengthFt: l.measure } : {}),
    ...(l.choices && Object.keys(l.choices).length ? { modifiers: l.choices } : {}),
  }));
}

export function bookingTenantFor(facts: BusinessFacts): BookingTenant | null {
  if (!facts.bookingPolicy) return null;
  return {
    organizationId: facts.organizationId,
    companyId: facts.companyId,
    companyName: facts.businessName,
    agentName: "the assistant",
    timeZone: facts.timeZone,
    policy: facts.bookingPolicy,
  };
}

function fromWindowsResponse(r: AvailabilityResponse): AvailabilityResult {
  if (r.ok === false) return { ok: false, reason: r.reason === "unsupported" ? "no_online_booking" : "error", message: r.say };
  return { ok: true, mode: "windows", slots: r.slots.map((s) => ({ date: s.date, window: s.window, startsAt: null, label: s.label })) };
}

async function loadBusy(admin: AdminClient, facts: BusinessFacts, now: Date): Promise<BusyBooking[]> {
  const horizon = facts.onlineBooking.horizonDays + 14;
  const { data, error } = await (admin as Db)
    .from("bookings")
    .select("scheduled_for, duration_minutes, window_key")
    .eq("organization_id", facts.organizationId)
    .eq("company_id", facts.companyId)
    .neq("status", "cancelled")
    .gte("scheduled_for", new Date(now.getTime() - 86_400_000).toISOString())
    .lte("scheduled_for", new Date(now.getTime() + horizon * 86_400_000).toISOString())
    .limit(3000);
  if (error) throw error;
  return ((data ?? []) as Array<Pick<Tables<"bookings">, "scheduled_for" | "duration_minutes" | "window_key">>).map((r) => ({
    scheduledFor: r.scheduled_for,
    durationMinutes: r.duration_minutes ?? 30,
    windowKey: r.window_key,
  }));
}

/** Hourly open times (the public booking page's rules), optionally from a preferred day. */
async function hourlyTimes(admin: AdminClient, facts: BusinessFacts, now: Date, preferredDate: string | null) {
  const busy = await loadBusy(admin, facts, now);
  const earliest = preferredDate ? Math.max(now.getTime() + facts.onlineBooking.minNoticeHours * 3_600_000, zonedInstant(preferredDate, "00:00", facts.timeZone).getTime()) : undefined;
  return presentOpenTimes(
    openTimes({ now, timeZone: facts.timeZone, policy: null, settings: facts.onlineBooking, busy, earliestMs: earliest }),
    null,
    facts.timeZone,
  );
}

/** Spread suggestions over different days: first open time of each day, then fill. PURE. */
export function spreadSlots<T extends { day: string }>(times: T[], limit: number): T[] {
  const firstPerDay: T[] = [];
  const seen = new Set<string>();
  for (const t of times) {
    if (!seen.has(t.day)) {
      seen.add(t.day);
      firstPerDay.push(t);
    }
    if (firstPerDay.length >= limit) break;
  }
  if (firstPerDay.length >= limit) return firstPerDay;
  return [...firstPerDay, ...times.filter((t) => !firstPerDay.includes(t))].slice(0, limit);
}

export const defaultAgentServices: AgentServices = {
  async priceServices(companyId, lines) {
    return priceQuoteForCompany(companyId, { services: toQuoteServices(lines) });
  },

  async createAndSendQuote(admin, facts, input) {
    const ctx = serviceContext(admin, facts);
    const quote = await createQuote(ctx, {
      companyId: facts.companyId,
      contactId: input.contactId,
      services: toQuoteServices(input.lines ?? []),
      customLines: (input.customLines ?? []).map((l) => ({ label: l.label, amountCents: l.amountCents })),
      title: input.title,
      source: "sms_agent",
    });
    const sent = await sendQuote(ctx, quote.id);
    const url = await quoteLinkForCompanyId(facts.companyId, sent.quote.public_token, admin as Db);
    return {
      quoteId: sent.quote.id,
      url,
      subtotalCents: sent.quote.subtotal_cents,
      totalCents: sent.quote.total_cents,
      quoteNumber: sent.quote.quote_number,
      title: input.title,
    };
  },

  async checkAvailability(admin, facts, input) {
    const now = this.now();
    try {
      const tenant = bookingTenantFor(facts);
      if (tenant) {
        return fromWindowsResponse(
          await availabilityForTenant(tenant, { preferred_date: input.preferredDate ?? undefined, preferred_window: input.preferredWindow ?? undefined }, {
            ...defaultBookingDeps,
            now: () => now,
          }),
        );
      }
      if (facts.bookingMode !== "hourly") {
        return { ok: false, reason: "no_online_booking", message: "Online booking isn't set up — the owner sets dates." };
      }
      const times = spreadSlots(await hourlyTimes(admin, facts, now, input.preferredDate ?? null), input.limit ?? 4);
      return {
        ok: true,
        mode: "hourly",
        slots: times.map((t) => ({ date: t.day, window: null, startsAt: t.startsAt, label: `${t.dayLabel}, ${t.label}` })),
      };
    } catch (err) {
      console.error("[sms-agent] availability failed:", err instanceof Error ? err.message : err);
      return { ok: false, reason: "error", message: "Couldn't read the calendar." };
    }
  },

  async bookSlot(admin, facts, input) {
    const now = this.now();
    const tenant = bookingTenantFor(facts);
    if (tenant) {
      let quoteId = input.quoteId ?? null;
      let created: SentQuote | null = null;
      if (!quoteId) {
        if (!input.lines?.length) {
          return { ok: false, reason: "needs_quote", message: "This business books jobs from a price-list quote — get the services first (or send the booking link)." };
        }
        created = await this.createAndSendQuote(admin, facts, {
          contactId: input.contact.id,
          lines: input.lines,
          title: input.lines.map((l) => facts.priceList.find((p) => p.key === l.service_key)?.label ?? l.service_key).join(", "),
        });
        quoteId = created.quoteId;
      }
      const result: BookResponse = await bookForTenant(
        tenant,
        { quote_id: quoteId, date: input.date ?? undefined, window: input.window ?? undefined },
        { ...defaultBookingDeps, now: () => now },
        { callId: null, source: "sms_agent", bookedBy: "Booked by the text-message assistant." },
      );
      if (result.ok === true) return { ok: true, bookingId: result.booking_id, label: result.label, duplicate: result.duplicate, quote: created };
      return {
        ok: false,
        reason: result.reason === "missing_info" || result.reason === "quote_not_found" ? "needs_quote" : result.reason === "error" || result.reason === "unsupported" ? "error" : "not_open",
        message: result.say,
        alternatives: result.alternatives?.map((a) => ({ date: a.date, window: a.window, startsAt: null, label: a.label })),
      };
    }

    if (facts.bookingMode !== "hourly") {
      return { ok: false, reason: "no_online_booking", message: "Online booking isn't set up." };
    }
    if (facts.onlineBooking.depositMode !== "none") {
      return { ok: false, reason: "deposit_required", message: "Bookings here take a deposit — send the booking link so they can pay it." };
    }
    const times = await hourlyTimes(admin, facts, now, null);
    const startsAt = input.startsAt ? Date.parse(input.startsAt) : NaN;
    const match = times.find((t) => Date.parse(t.startsAt) === startsAt);
    if (!match) {
      return {
        ok: false,
        reason: "not_open",
        message: "That time isn't open.",
        alternatives: spreadSlots(times, 3).map((t) => ({ date: t.day, window: null, startsAt: t.startsAt, label: `${t.dayLabel}, ${t.label}` })),
      };
    }
    const db = admin as Db;
    const { data: dup } = await db
      .from("bookings")
      .select("id")
      .eq("organization_id", facts.organizationId)
      .eq("company_id", facts.companyId)
      .eq("contact_id", input.contact.id)
      .eq("scheduled_for", match.startsAt)
      .neq("status", "cancelled")
      .limit(1);
    const label = `${match.dayLabel}, ${match.label}`;
    if (((dup ?? []) as unknown[]).length > 0) return { ok: true, bookingId: (dup as Array<{ id: string }>)[0].id, label, duplicate: true };

    const name = [input.contact.first_name, input.contact.last_name].filter(Boolean).join(" ") || "Customer";
    const { data, error } = await db
      .from("bookings")
      .insert({
        organization_id: facts.organizationId,
        company_id: facts.companyId,
        contact_id: input.contact.id,
        created_by: null,
        title: `Booking — ${name}`,
        description: ["Booked by the text-message assistant.", input.note ? `Job: ${input.note.slice(0, 500)}` : null].filter(Boolean).join("\n"),
        duration_minutes: match.durationMinutes,
        scheduled_for: match.startsAt,
        window_key: null,
        status: facts.onlineBooking.autoConfirm ? "confirmed" : "pending",
        source: SMS_AGENT_SENDER,
      })
      .select("*")
      .single();
    if (error) throw error;
    const booking = data as Tables<"bookings">;
    try {
      await emitActivityEventAndDispatch(serviceContext(admin, facts), {
        companyId: facts.companyId,
        entityId: booking.id,
        entityType: "booking",
        eventType: "booking.created",
        metadata: { bookingId: booking.id, scheduledFor: booking.scheduled_for, status: booking.status, source: SMS_AGENT_SENDER },
        relatedEntityId: input.contact.id,
        relatedEntityType: "contact",
      });
    } catch (err) {
      console.error("[sms-agent] booking.created dispatch failed (non-fatal):", err instanceof Error ? err.message : err);
    }
    await notifyOnlineBooking({
      organizationId: facts.organizationId,
      companyId: facts.companyId,
      bookingId: booking.id,
      title: `Booked by text: ${name}`,
      body: label,
    }).catch(() => undefined);
    return { ok: true, bookingId: booking.id, label, duplicate: false };
  },

  async textCustomer(admin, facts, contact, body) {
    return deliverMessage({
      context: serviceContext(admin, facts),
      channel: "sms",
      to: contact.phone,
      body,
      companyId: facts.companyId,
      contactId: contact.id,
      consentContact: contact,
      smsFrom: "company",
      sentBy: SMS_AGENT_SENDER,
    });
  },

  async alertOwner(admin, facts, body, subject) {
    try {
      // Per-company budget (30/hour, then one summary): a flood can't flood the owner.
      const gate = await ownerAlertGate(admin, facts.companyId);
      if (gate === "drop") return { sent: false };
      if (gate === "summary") body = OWNER_ALERTS_SUMMARY;
      const ctx = serviceContext(admin, facts);
      const { data: company } = await (admin as Db)
        .from("companies")
        .select("owner_email, owner_phone_e164")
        .eq("id", facts.companyId)
        .maybeSingle();
      const owner = await resolveOwnerContacts(ctx, company as Pick<Tables<"companies">, "owner_email" | "owner_phone_e164"> | null, {
        allowPlatformFallback: false,
      });
      if (owner.phone) {
        const r = await deliverMessage({ context: ctx, channel: "sms", to: owner.phone, body, companyId: facts.companyId, contactId: null, consentContact: null, smsFrom: "platform" });
        if (r.status === "sent") return { sent: true };
      }
      if (owner.email) {
        const r = await deliverMessage({
          context: ctx,
          channel: "email",
          to: owner.email,
          subject: subject ?? `${facts.businessName}: a customer text needs you`,
          body,
          companyId: facts.companyId,
          contactId: null,
          consentContact: null,
        });
        return { sent: r.status === "sent" };
      }
      return { sent: false };
    } catch (err) {
      console.error("[sms-agent] owner alert failed:", err instanceof Error ? err.message : err);
      return { sent: false };
    }
  },

  async recordQuoteEvent(admin, facts, quoteId, eventType, metadata) {
    try {
      await (admin as Db).from("quote_events").insert({
        organization_id: facts.organizationId,
        quote_id: quoteId,
        event_type: eventType,
        actor_profile_id: null,
        metadata,
      });
    } catch (err) {
      console.error(`[sms-agent] failed to record '${eventType}':`, err instanceof Error ? err.message : err);
    }
  },

  now: () => new Date(),
};

/** Owner-facing pings that aren't urgent go out 08:00–21:00 company time only. PURE. */
export function withinOwnerHours(now: Date, timeZone: string): boolean {
  const hour = Number(new Intl.DateTimeFormat("en-CA", { timeZone, hour: "2-digit", hourCycle: "h23" }).format(now));
  return hour >= 8 && hour < 21;
}

