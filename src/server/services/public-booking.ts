import { z } from "zod";

import type { Tables } from "@/server/db/database.types";
import { ValidationError } from "@/server/organizations/context";
import { parseBookingPolicy, type BusyBooking } from "@/server/services/booking-windows";
import { companyTimeZone, invoicePublicUrl, loadCompanyForInvoice } from "@/server/services/invoices/common";
import { brandOfCompany, type InvoiceBrand } from "@/server/services/invoices/document";
import { createInvoice, sendInvoice } from "@/server/services/invoices/service";
import { notifyOnlineBooking } from "@/server/services/push/notify";
import { quotePublicBaseUrlFor } from "@/server/services/quotes/config";
import {
  bookableService,
  depositFor,
  flatPrice,
  openTimes,
  parseOnlineBookingSettings,
  presentOpenTimes,
  type BookableService,
  type CatalogService,
  type OnlineBookingSettings,
  type PresentedTime,
} from "@/server/services/scheduling/rules";
import type { TenantServiceContext } from "@/server/services/shared";
// ─────────────────────────────────────────────────────────────────────────────
// SANCTIONED EXCEPTION #2 (approved 2026-07-16): public customer self-booking.
// The SECOND request path allowed to use the Supabase service-role (RLS-bypassing)
// client, held to the same discipline as intake:
//   • the company is resolved from the URL on the SERVER — the request body can
//     never choose which org/company is written;
//   • the only writes are a booking (+ find-or-create of the contact) and, when the
//     brand takes a deposit, that booking's deposit invoice — all pinned to the company;
//   • the requested time must be in the freshly-computed open times, so the payload
//     cannot book an arbitrary, past, or already-taken slot; the service must be one of
//     the company's active ones, and the price / deposit come from the database;
//   • the response echoes only the booked time and the customer's own links.
// docs/online-booking.md
// ─────────────────────────────────────────────────────────────────────────────
import { createSupabaseAdminClient } from "@/server/supabase/admin";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

export interface PublicBookingPage {
  company: { id: string; name: string };
  brand: InvoiceBrand;
  timezone: string;
  mode: "windows" | "hourly";
  services: BookableService[];
  requireService: boolean;
  times: PresentedTime[];
}

export const publicBookingRequestSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(320),
  phone: z.string().trim().max(40).optional(),
  location: z.string().trim().max(300).optional(),
  notes: z.string().max(2000).optional(),
  serviceId: z.string().uuid().nullish(),
  startsAt: z.string(),
  windowKey: z.string().max(32).nullish(),
});

export type PublicBookingRequestInput = z.infer<typeof publicBookingRequestSchema>;

export interface PublicBookingResult {
  ok: true;
  scheduledFor: string;
  dayLabel: string;
  label: string;
  status: "confirmed" | "pending";
  /** The customer's own confirm / reschedule / cancel page. */
  manageUrl: string | null;
  /** Present when the slot is held for a deposit: pay here before holdUntil. */
  deposit: { cents: number; payUrl: string; holdUntil: string } | null;
}

interface ResolvedCompany {
  row: NonNullable<Awaited<ReturnType<typeof loadCompanyForInvoice>>> & { id: string; name: string };
  organizationId: string;
  settings: OnlineBookingSettings;
  policy: ReturnType<typeof parseBookingPolicy>;
  timeZone: string;
  stripeReady: boolean;
}

async function resolveCompany(admin: AdminClient, companyId: string): Promise<ResolvedCompany | null> {
  if (!z.string().uuid().safeParse(companyId).success) return null;
  const { data, error } = await admin
    .from("companies")
    .select("id, organization_id, online_booking_settings, booking_policy")
    .eq("id", companyId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = await loadCompanyForInvoice(admin as never, data.organization_id, data.id);
  if (!row) return null;
  return {
    row: row as ResolvedCompany["row"],
    organizationId: data.organization_id,
    settings: parseOnlineBookingSettings(data.online_booking_settings),
    policy: parseBookingPolicy(data.booking_policy ?? null),
    timeZone: companyTimeZone(row),
    stripeReady: Boolean(row.stripe_connected_account_id && row.stripe_charges_enabled),
  };
}

async function loadServices(admin: AdminClient, company: ResolvedCompany): Promise<CatalogService[]> {
  if (!company.settings.showServices) return [];
  const { data, error } = await admin
    .from("service_catalog_items")
    .select("id, label, description, pricing_type, rate_cents, minimum_cents, unit_label")
    .eq("organization_id", company.organizationId)
    .eq("company_id", company.row.id)
    .eq("active", true)
    .order("sort_order", { ascending: true })
    .limit(100);
  if (error) throw error;
  return (data ?? []) as CatalogService[];
}

async function loadBusy(admin: AdminClient, company: ResolvedCompany, now: Date): Promise<BusyBooking[]> {
  const horizonDays = (company.policy ? company.policy.horizonDays : company.settings.horizonDays) + 14;
  const { data, error } = await admin
    .from("bookings")
    .select("scheduled_for, duration_minutes, window_key")
    .eq("organization_id", company.organizationId)
    .eq("company_id", company.row.id)
    .neq("status", "cancelled")
    .gte("scheduled_for", new Date(now.getTime() - 86_400_000).toISOString())
    .lte("scheduled_for", new Date(now.getTime() + horizonDays * 86_400_000).toISOString())
    .limit(3000);
  if (error) throw error;
  return ((data ?? []) as Array<Pick<Tables<"bookings">, "scheduled_for" | "duration_minutes" | "window_key">>).map((r) => ({
    scheduledFor: r.scheduled_for,
    durationMinutes: r.duration_minutes ?? 30,
    windowKey: r.window_key,
  }));
}

async function timesFor(admin: AdminClient, company: ResolvedCompany, now: Date): Promise<PresentedTime[]> {
  const busy = await loadBusy(admin, company, now);
  return presentOpenTimes(openTimes({ now, timeZone: company.timeZone, policy: company.policy, settings: company.settings, busy }), company.policy, company.timeZone);
}

export async function getPublicBookingPage(companyId: string, now: Date = new Date()): Promise<PublicBookingPage | null> {
  const admin = createSupabaseAdminClient();
  const company = await resolveCompany(admin, companyId);
  if (!company || !company.settings.enabled) return null;
  const [services, times] = await Promise.all([loadServices(admin, company), timesFor(admin, company, now)]);
  return {
    company: { id: company.row.id, name: company.row.name },
    brand: brandOfCompany(company.row),
    timezone: company.timeZone,
    mode: company.policy ? "windows" : "hourly",
    services: services.map((s) => bookableService(s, company.settings, company.stripeReady)),
    requireService: company.settings.requireService && services.length > 0,
    times,
  };
}

function splitName(name: string): { firstName: string; lastName: string | null } {
  const parts = name.trim().split(/\s+/);
  if (!parts[0]) return { firstName: "Customer", lastName: null };
  return { firstName: parts[0], lastName: parts.length > 1 ? parts.slice(1).join(" ") : null };
}

async function findOrCreateContact(admin: AdminClient, company: ResolvedCompany, input: PublicBookingRequestInput): Promise<string> {
  const email = input.email.trim();
  const { data: existing, error: findError } = await admin
    .from("contacts")
    .select("id, phone")
    .eq("organization_id", company.organizationId)
    .eq("company_id", company.row.id)
    .ilike("email", email)
    .limit(1)
    .maybeSingle();
  if (findError) throw findError;
  const found = existing as { id: string; phone: string | null } | null;
  if (found) {
    // Fill a missing phone so reminders can text them; never overwrite one we have.
    if (!found.phone && input.phone?.trim()) {
      await admin.from("contacts").update({ phone: input.phone.trim() }).eq("organization_id", company.organizationId).eq("id", found.id);
    }
    return found.id;
  }
  const { firstName, lastName } = splitName(input.name);
  const { data: created, error: createError } = await admin
    .from("contacts")
    .insert({
      company_id: company.row.id,
      email,
      first_name: firstName,
      last_name: lastName,
      organization_id: company.organizationId,
      phone: input.phone?.trim() || null,
      stage: "lead",
      // Implied consent (Task 8): the customer initiated contact by self-booking (CASL).
      sms_consent_at: new Date().toISOString(),
      consent_source: "implied_inquiry",
    })
    .select("id")
    .single();
  if (createError) throw createError;
  return (created as { id: string }).id;
}

/** booking.created for automations + the owner's timeline (no session here, so replicate the two writes). */
async function dispatchCreated(admin: AdminClient, company: ResolvedCompany, booking: Tables<"bookings">, contactId: string): Promise<void> {
  try {
    const { data: eventData, error: eventError } = await admin
      .from("activity_events")
      .insert({
        actor_user_id: null,
        company_id: company.row.id,
        entity_id: booking.id,
        entity_type: "booking",
        event_type: "booking.created",
        metadata_json: { bookingId: booking.id, scheduledFor: booking.scheduled_for, status: booking.status, source: "public_booking" },
        organization_id: company.organizationId,
        related_entity_id: contactId,
        related_entity_type: "contact",
      })
      .select("id")
      .single();
    if (eventError) throw eventError;
    const { error: jobError } = await admin.from("workflow_event_jobs").insert({
      activity_event_id: (eventData as { id: string }).id,
      available_at: new Date().toISOString(),
      company_id: company.row.id,
      max_attempts: 5,
      organization_id: company.organizationId,
      status: "pending",
    });
    if (jobError) throw jobError;
  } catch (dispatchError) {
    console.error("[public-booking] workflow dispatch failed (non-fatal):", dispatchError);
  }
}

export async function createPublicBooking(companyId: string, input: PublicBookingRequestInput, now: Date = new Date()): Promise<PublicBookingResult> {
  const admin = createSupabaseAdminClient();
  const company = await resolveCompany(admin, companyId);
  if (!company || !company.settings.enabled) throw new ValidationError("This booking link is not valid.");

  // The service: one of the company's own active ones (never a price from the request).
  let service: CatalogService | null = null;
  if (input.serviceId) {
    service = (await loadServices(admin, company)).find((s) => s.id === input.serviceId) ?? null;
    if (!service) throw new ValidationError("Please choose one of the services listed.");
  } else if (company.settings.requireService && (await loadServices(admin, company)).length > 0) {
    throw new ValidationError("Please choose a service.");
  }

  // The time: one of the open times we'd offer right now.
  const times = await timesFor(admin, company, now);
  const match = times.find((t) => Date.parse(t.startsAt) === Date.parse(input.startsAt) && (t.windowKey ?? null) === (input.windowKey ?? null));
  if (!match) throw new ValidationError("That time is no longer available. Please choose another.");

  const contactId = await findOrCreateContact(admin, company, input);
  const price = service ? flatPrice(service) : null;
  const deposit = depositFor(price, company.settings, company.stripeReady);
  const holdUntil = deposit ? new Date(now.getTime() + company.settings.holdMinutes * 60_000).toISOString() : null;
  const name = input.name.trim();
  const notes = input.notes?.trim();

  const { data: bookingData, error: bookingError } = await admin
    .from("bookings")
    .insert({
      organization_id: company.organizationId,
      company_id: company.row.id,
      contact_id: contactId,
      created_by: null,
      title: service ? `${service.label} — ${name}` : `Booking — ${name}`,
      description: notes ? `Customer note: ${notes}` : "Booked online.",
      location: input.location?.trim() || null,
      duration_minutes: match.durationMinutes,
      scheduled_for: match.startsAt,
      window_key: match.windowKey,
      status: !deposit && company.settings.autoConfirm ? "confirmed" : "pending",
      source: "public_booking",
      service_item_id: service?.id ?? null,
      price_cents: price,
      deposit_cents: deposit,
      hold_expires_at: holdUntil,
    })
    .select("*")
    .single();
  if (bookingError) throw bookingError;
  const booking = bookingData as Tables<"bookings">;

  let depositOut: PublicBookingResult["deposit"] = null;
  if (deposit && service) {
    const ctx = { organizationId: company.organizationId, actorProfileId: null, supabase: admin } as unknown as TenantServiceContext;
    try {
      const invoice = await createInvoice(ctx, {
        companyId: company.row.id,
        contactId,
        customerAccountId: null,
        title: `Deposit — ${service.label}`,
        lines: [
          {
            label: `Deposit — ${service.label}`,
            description: `Holds your booking for ${match.dayLabel}, ${match.label}. Credited on your final invoice.`,
            quantity: 1,
            unitPriceCents: deposit,
          },
        ],
        taxRateBps: 0,
        paymentTermsDays: 0,
      });
      const sent = await sendInvoice(ctx, invoice.id, { email: true });
      await admin.from("bookings").update({ deposit_invoice_id: invoice.id }).eq("organization_id", company.organizationId).eq("id", booking.id);
      depositOut = { cents: deposit, payUrl: sent.publicUrl ?? invoicePublicUrl(company.row, invoice.public_token), holdUntil: holdUntil! };
    } catch (err) {
      // Couldn't set up the payment: release the slot rather than hold it for nothing.
      console.error("[public-booking] deposit invoice failed:", err instanceof Error ? err.message : err);
      await admin.from("bookings").update({ status: "cancelled", hold_expires_at: null }).eq("organization_id", company.organizationId).eq("id", booking.id);
      throw new ValidationError("We couldn't set up the deposit payment. Please try again, or call us to book.");
    }
  }

  await dispatchCreated(admin, company, booking, contactId);
  await notifyOnlineBooking({
    organizationId: company.organizationId,
    companyId: company.row.id,
    bookingId: booking.id,
    title: `New online booking: ${name}`,
    body: `${service?.label ?? "Booking"} · ${match.dayLabel}, ${match.label}${deposit ? ` · waiting for a $${(deposit / 100).toFixed(2)} deposit` : ""}`,
  });

  return {
    ok: true,
    scheduledFor: booking.scheduled_for,
    dayLabel: match.dayLabel,
    label: match.label,
    status: booking.status === "confirmed" ? "confirmed" : "pending",
    manageUrl: booking.manage_token ? `${quotePublicBaseUrlFor(company.row)}/v/${booking.manage_token}` : null,
    deposit: depositOut,
  };
}
