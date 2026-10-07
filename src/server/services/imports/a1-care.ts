/**
 * Importing the A1 Marine Care site's live calendar into EmpireVu — the PURE half.
 *
 * The Care site exports a JSON file (a1marinecare/scripts/export-for-empirevu.ts); this
 * module validates it and turns each row into what EmpireVu will write, so the plan can be
 * printed, reviewed and tested before anything touches the database. The job that applies
 * it is src/server/jobs/import-a1-care.ts.
 *
 * Mapping:
 *   quote_leads (shrink-wrap)  → quotes, priced from the Care catalog (shrink_wrap + the
 *                                winterization add-on + hull surcharge). If EmpireVu's price
 *                                differs from what the customer was quoted, the customer's
 *                                number wins (one custom line at the quoted amount).
 *   paid deposits              → deposit_paid_at on the quote (paid on the Care site's Stripe)
 *   booking_requests (upcoming)→ bookings. Shrink wrap lands in its half-day window; every
 *                                other service keeps its time slot (one hour) — they all
 *                                occupy the crew, so they all count toward capacity.
 */
import { z } from "zod";

import { DEFAULT_WINDOWS, zonedInstant, type BookingWindowDef } from "@/server/services/booking-windows";

export const IMPORT_SOURCE = "import:a1marinecare";

/**
 * The approval snapshot for a quote whose deposit was paid on the Care site. Paying the
 * deposit there WAS the customer's acceptance, but it happened outside EmpireVu's
 * approve step, so nothing froze approved_*. Invoicing (and the public page) bill only
 * from that snapshot, so an imported paid quote gets one built from its own stored
 * lines and totals — the amounts it was imported at. Pure.
 */
export function importedApprovalSnapshot(
  quote: { line_items: unknown; subtotal_cents: number; tax_cents: number; total_cents: number; deposit_cents: number },
  paidAt: string,
  customerName: string | null,
): Record<string, unknown> {
  return {
    approved_at: paidAt,
    approved_by_name: customerName ? `${customerName} (paid deposit on the previous site)` : "Paid deposit on the previous site",
    approved_line_items: quote.line_items,
    approved_subtotal_cents: quote.subtotal_cents,
    approved_tax_cents: quote.tax_cents,
    approved_total_cents: quote.total_cents,
    approved_deposit_cents: quote.deposit_cents,
  };
}

const depositSchema = z
  .object({ paidAt: z.string(), stripeSessionId: z.string().nullable().optional(), amountCents: z.number().nullable().optional() })
  .nullable();

const quoteSchema = z.object({
  id: z.string().min(1),
  createdAt: z.string(),
  contactName: z.string(),
  contactEmail: z.string(),
  contactPhone: z.string(),
  boatLength: z.string(),
  boatType: z.string(),
  services: z.array(z.string()).default([]),
  addons: z.array(z.string()).default([]),
  locationSlug: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  estimatedTotalCents: z.number().nullable(),
  requiresManualReview: z.boolean(),
  channel: z.string().nullable().optional(),
  retellCallId: z.string().nullable().optional(),
  emailPlaceholder: z.boolean().optional(),
  depositLinkSentAt: z.string().nullable().optional(),
  deposit: depositSchema.optional(),
});

const bookingSchema = z.object({
  id: z.string().min(1),
  createdAt: z.string(),
  quoteId: z.string().nullable(),
  serviceSlug: z.string(),
  locationSlug: z.string().nullable().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timeSlot: z.string().regex(/^\d{2}:\d{2}$/),
  contactName: z.string(),
  contactEmail: z.string(),
  contactPhone: z.string(),
  notes: z.string().nullable().optional(),
  status: z.string(),
  window: z.string().nullable().optional(),
});

export const exportSchema = z.object({
  source: z.literal("a1marinecare"),
  exportedAt: z.string(),
  timezone: z.string().default("America/Toronto"),
  quotes: z.array(quoteSchema),
  bookings: z.array(bookingSchema),
});

export type A1Export = z.infer<typeof exportSchema>;
export type A1Quote = z.infer<typeof quoteSchema>;
export type A1Booking = z.infer<typeof bookingSchema>;

// ── People ──────────────────────────────────────────────────────────────────────

export interface PersonKey {
  name: string;
  firstName: string;
  lastName: string | null;
  phone: string | null;
  phoneLast10: string | null;
  /** null for the Care site's phone-only placeholder addresses. */
  email: string | null;
}

export function isPlaceholderEmail(email: string): boolean {
  return /@no-email\.a1marinecare\.ca$/i.test(email.trim()) || !/^\S+@\S+\.\S+$/.test(email.trim());
}

export function toE164(raw: string): string | null {
  const d = raw.replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return null;
}

export function personOf(name: string, email: string, phone: string): PersonKey {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const e164 = toE164(phone);
  return {
    name: name.trim() || "Customer",
    firstName: parts[0] ?? "Customer",
    lastName: parts.length > 1 ? parts.slice(1).join(" ") : null,
    phone: e164,
    phoneLast10: e164 ? e164.slice(-10) : null,
    email: isPlaceholderEmail(email) ? null : email.trim().toLowerCase(),
  };
}

// ── Quotes ──────────────────────────────────────────────────────────────────────

const HULLS = ["bowrider", "cuddy", "cruiser", "pontoon", "tritoon", "sailboat", "pwc", "other"];

export interface PlannedImportQuote {
  a1Id: string;
  person: PersonKey;
  createdAt: string;
  lengthFt: number;
  hullType: string;
  services: Array<{ serviceId: string; lengthFt?: number; engineCount?: number }>;
  quotedCents: number | null;
  manualReview: boolean;
  paid: { at: string; stripeSessionId: string | null } | null;
  linkSent: boolean;
  notes: string;
}

/** "winterization:outboard:2" → { engine, count }. */
export function parseWinterizationAddon(addons: string[]): { engine: "outboard" | "sterndrive" | "inboard"; count: number } | null {
  for (const a of addons) {
    const [kind, engine, count] = a.split(":");
    if (kind === "winterization" && (engine === "outboard" || engine === "sterndrive" || engine === "inboard")) {
      return { engine, count: Math.max(1, Math.min(4, Number(count) || 1)) };
    }
  }
  return null;
}

export function planQuote(q: A1Quote): PlannedImportQuote {
  const lengthFt = Math.round(Number.parseFloat(q.boatLength)) || 0;
  const hullType = HULLS.includes(q.boatType) ? q.boatType : "other";
  const winter = parseWinterizationAddon(q.addons);
  const services: PlannedImportQuote["services"] = [{ serviceId: "shrink_wrap", lengthFt }];
  if (winter) services.push({ serviceId: `winterization_${winter.engine}`, engineCount: winter.count });
  return {
    a1Id: q.id,
    person: personOf(q.contactName, q.contactEmail, q.contactPhone),
    createdAt: q.createdAt,
    lengthFt,
    hullType,
    services,
    quotedCents: q.estimatedTotalCents,
    manualReview: q.requiresManualReview || lengthFt <= 0,
    paid: q.deposit ? { at: q.deposit.paidAt, stripeSessionId: q.deposit.stripeSessionId ?? null } : null,
    linkSent: Boolean(q.depositLinkSentAt),
    notes: [
      `Imported from a1marinecare quote ${q.id} (quoted ${q.createdAt.slice(0, 10)}${q.channel === "marina" ? " by Marina on the phone" : ""}).`,
      q.deposit ? `Deposit paid on the Care site's Stripe${q.deposit.stripeSessionId ? ` (${q.deposit.stripeSessionId})` : ""}.` : null,
      q.notes?.trim() || null,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

// ── Bookings ────────────────────────────────────────────────────────────────────

export const SHRINK_WRAP_SLUG = "shrink-wrapping";
const MORNING_SLOTS = new Set(["08:00", "09:00", "10:00", "11:00"]);

export interface PlannedImportBooking {
  a1Id: string;
  a1QuoteId: string | null;
  person: PersonKey;
  /** When they booked on the Care site — their implied-consent date. */
  createdAt: string;
  scheduledFor: string;
  durationMinutes: number;
  windowKey: string | null;
  status: "pending" | "confirmed";
  title: string;
  description: string;
  /** The idempotency key stored in bookings.source_call_id. */
  sourceRef: string;
}

function serviceName(slug: string): string {
  if (slug === SHRINK_WRAP_SLUG) return "Mobile shrink wrap";
  return slug.replace(/-/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export function planBooking(b: A1Booking, timeZone: string, windows: BookingWindowDef[] = DEFAULT_WINDOWS): PlannedImportBooking {
  const person = personOf(b.contactName, b.contactEmail, b.contactPhone);
  const isWrap = b.serviceSlug === SHRINK_WRAP_SLUG;
  let windowKey: string | null = null;
  let scheduledFor: string;
  let durationMinutes = 60;
  if (isWrap) {
    const wanted = b.window === "afternoon" || b.window === "morning" ? b.window : MORNING_SLOTS.has(b.timeSlot) ? "morning" : "afternoon";
    const w = windows.find((x) => x.key === wanted) ?? windows[0];
    windowKey = w.key;
    scheduledFor = zonedInstant(b.date, w.start, timeZone).toISOString();
    durationMinutes = w.durationMinutes;
  } else {
    scheduledFor = zonedInstant(b.date, b.timeSlot, timeZone).toISOString();
  }
  return {
    a1Id: b.id,
    a1QuoteId: b.quoteId,
    person,
    createdAt: b.createdAt,
    scheduledFor,
    durationMinutes,
    windowKey,
    status: b.status.toLowerCase() === "confirmed" ? "confirmed" : "pending",
    title: `${serviceName(b.serviceSlug)} — ${person.name}`,
    description: [`Imported from a1marinecare booking ${b.id}.`, b.notes?.trim() || null].filter(Boolean).join("\n"),
    sourceRef: `a1:${b.id}`,
  };
}

export interface ImportPlan {
  quotes: PlannedImportQuote[];
  bookings: PlannedImportBooking[];
}

export function planImport(raw: unknown): ImportPlan {
  const data = exportSchema.parse(raw);
  return {
    quotes: data.quotes.map(planQuote),
    bookings: data.bookings.map((b) => planBooking(b, data.timezone)),
  };
}
