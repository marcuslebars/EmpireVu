import { z } from "zod";

import { bookingPolicyInputSchema, type BookingWindowDef } from "@/server/services/booking-windows";

/**
 * Industry starter packs — versioned DATA, not code paths.
 *
 * A pack is what an operator applies to a brand-new company so it starts life looking
 * like a business in that trade: a service list (labels, units, descriptions — NEVER
 * prices; convention #4, the owner enters prices into the per-company catalog), the
 * proven recipes with customer messages rewritten for the trade, receptionist notes
 * (FAQs, qualifying questions, urgency keywords, seasonal context) appended to the AI
 * receptionist prompt, review-request timing, and optional booking-window defaults.
 *
 * Every pack is validated by `industryPackSchema` (strict — an unknown key such as
 * `price` or `rateCents` is a parse error) and by src/test/industry-packs.test.ts.
 * Bump `version` whenever a pack's content changes; companies record the id + version
 * they were given (companies.industry_pack), so the Settings page can offer a re-apply.
 */

/** How a pack service is priced once the owner enters a rate. Subset of the catalog's PRICING_TYPES. */
export const PACK_PRICING_TYPES = ["flat", "per_unit", "per_measure"] as const;

/**
 * Template variables a pack message may use. Every one is produced by
 * workflow-engine/context.ts buildMessageTemplateData — see the test that renders each
 * against that shape. Per-recipe, a pack may only use the roots (contact/company/booking/
 * quote) that the base recipe's own messages already use, so a booking variable never
 * appears in a recipe whose trigger has no booking.
 */
export const PACK_TEMPLATE_VARIABLES = [
  "contact.first_name",
  "contact.last_name",
  "company.name",
  "company.booking_url",
  "company.review_url",
  "booking.scheduled_for",
  "booking.when",
  "booking.manage_url",
  "quote.public_url",
  "quote.subtotal",
  "quote.total",
  "quote.deposit",
  "quote.number",
] as const;

/** Filters a pack message may apply (interpolate.ts applyFilter). */
export const PACK_TEMPLATE_FILTERS = ["date", "time"] as const;

const slugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "lowercase-kebab-case");
const durationSchema = z.string().regex(/^\d+[mhdw]$/, 'a duration like "2h" or "3d"');

export const packServiceSchema = z
  .object({
    /** Stable catalog service_key (unique per company). */
    key: z.string().regex(/^[a-z0-9_]{1,80}$/),
    label: z.string().min(2).max(200),
    /** Singular unit noun stored as unit_label — shown to the owner as "per <unit>". */
    unit: z.string().min(2).max(60),
    pricingType: z.enum(PACK_PRICING_TYPES),
    description: z.string().min(10).max(500),
    category: z.string().min(2).max(60),
  })
  .strict();

export const packMessageOverrideSchema = z
  .object({
    /** Index into the base recipe's definition.actions — must be a send_sms / send_email. */
    actionIndex: z.number().int().min(0),
    body: z.string().min(10).max(2000),
    /** Email subject (send_email only). */
    subject: z.string().min(3).max(200).optional(),
  })
  .strict();

export const packWaitOverrideSchema = z
  .object({
    /** Index into the base recipe's definition.actions — must be a duration `wait`. */
    actionIndex: z.number().int().min(0),
    duration: durationSchema,
  })
  .strict();

export const packRecipeSchema = z
  .object({
    slug: slugSchema,
    messages: z.array(packMessageOverrideSchema).default([]),
    waits: z.array(packWaitOverrideSchema).default([]),
    schedule: z
      .object({
        hours_before: z.number().int().min(1).max(24 * 7).optional(),
        stale_days: z.number().int().min(1).max(60).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const packReceptionistSchema = z
  .object({
    /** One or two sentences: what this kind of business does, in the receptionist's words. */
    businessSummary: z.string().min(20).max(600),
    seasonalNotes: z.array(z.string().min(10).max(400)).min(1).max(8),
    qualifyingQuestions: z.array(z.string().min(5).max(200)).min(3).max(10),
    /** Phrases that mean "flag this as urgent" — e.g. "no heat", "roof leak". */
    urgentKeywords: z.array(z.string().min(3).max(60)).min(3).max(20),
    faqs: z
      .array(
        z
          .object({
            question: z.string().min(5).max(200),
            answer: z.string().min(10).max(600),
          })
          .strict(),
      )
      .min(3)
      .max(12),
  })
  .strict();

export const industryPackSchema = z
  .object({
    id: slugSchema,
    version: z.number().int().min(1),
    name: z.string().min(3).max(80),
    /** One line for the picker card. */
    tagline: z.string().min(10).max(140),
    description: z.string().min(20).max(600),
    services: z.array(packServiceSchema).min(3).max(40),
    recipes: z.array(packRecipeSchema).min(1),
    /** How long after a completed job the review-request text goes out. */
    reviewRequest: z.object({ delay: durationSchema }).strict(),
    receptionist: packReceptionistSchema,
    /** Optional half-day booking-window defaults (companies.booking_policy). Applied only on request, never over an existing policy. */
    booking: bookingPolicyInputSchema.optional(),
  })
  .strict();

/*
 * Hand-written types (the schema above is the validator). zod's inferred types turn every
 * property optional under the SPA's non-strict tsconfig, which also compiles src/test, so
 * the code works with these interfaces and the test suite parses every pack with the schema.
 */
export interface PackService {
  key: string;
  label: string;
  unit: string;
  pricingType: (typeof PACK_PRICING_TYPES)[number];
  description: string;
  category: string;
}

export interface PackMessageOverride {
  actionIndex: number;
  body: string;
  subject?: string;
}

export interface PackRecipe {
  slug: string;
  messages?: PackMessageOverride[];
  waits?: Array<{ actionIndex: number; duration: string }>;
  schedule?: { hours_before?: number; stale_days?: number };
}

export interface PackReceptionist {
  businessSummary: string;
  seasonalNotes: string[];
  qualifyingQuestions: string[];
  urgentKeywords: string[];
  faqs: Array<{ question: string; answer: string }>;
}

export interface PackBookingPolicy {
  mode: "windows";
  windows?: BookingWindowDef[];
  capacityPerWindow?: number;
  leadTimeHours?: number;
  horizonDays?: number;
  workingDays?: number[];
}

export interface IndustryPack {
  id: string;
  version: number;
  name: string;
  tagline: string;
  description: string;
  services: PackService[];
  recipes: PackRecipe[];
  reviewRequest: { delay: string };
  receptionist: PackReceptionist;
  booking?: PackBookingPolicy;
}

/** Compile-time guard: a typed pack is acceptable input to the schema. */
export function asSchemaInput(pack: IndustryPack): z.input<typeof industryPackSchema> {
  return pack;
}

/** What a company records about the pack it was given (companies.industry_pack). */
export interface AppliedIndustryPack {
  id: string;
  version: number;
  appliedAt: string;
  /** Recipe slugs the pack installed or tailored on the last apply. */
  recipes: string[];
}

export function parseAppliedIndustryPack(raw: unknown): AppliedIndustryPack | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.version !== "number") return null;
  return {
    id: r.id,
    version: r.version,
    appliedAt: typeof r.appliedAt === "string" ? r.appliedAt : "",
    recipes: Array.isArray(r.recipes) ? r.recipes.filter((s): s is string => typeof s === "string") : [],
  };
}
