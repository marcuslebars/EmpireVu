import { z } from "zod";

/**
 * The canonical lead envelope, schemaVersion 1. This is the contract every spoke
 * emits. See docs/LEAD_SCHEMA.md.
 */
export const LEAD_SCHEMA_VERSION = 1 as const;

export const leadLineItemSchema = z.object({
  description: z.string().min(1).max(300),
  quantity: z.number(),
  unitPriceCents: z.number().int(),
});

export const leadEnvelopeSchema = z.object({
  schemaVersion: z.literal(LEAD_SCHEMA_VERSION),
  source: z.string().min(1).max(120),
  sourceSite: z.string().min(1).max(80),
  // "winter-storage-quote": A1 Marine Storage locality / ad lead-capture. Additive —
  // existing spokes are unaffected.
  // "phone-lead": a call handled by the Retell voice receptionist, mapped onto this
  // same envelope so a phone lead flows through the identical intake / dedup / notify
  // path as a web form. Additive.
  formType: z.enum(["quote", "contact", "booking", "winter-storage-quote", "phone-lead"]),
  receivedAt: z.string().datetime(),
  contact: z
    .object({
      name: z.string().max(200).optional(),
      email: z.string().email().max(320).optional(),
      phone: z.string().max(64).optional(),
    })
    .refine((c) => Boolean((c.email && c.email.trim()) || (c.phone && c.phone.trim())), {
      message: "contact requires at least one of email or phone",
    }),
  message: z.string().max(10000).optional(),
  lineItems: z.array(leadLineItemSchema).max(100).optional(),
  // Structured services the caller asked about (phone-lead). A human-readable summary
  // still rides in `message`; this keeps the list machine-usable for Phase 2 quoting.
  services: z.array(z.string().min(1).max(120)).max(50).optional(),
  asset: z
    .object({
      makeModel: z.string().max(200).optional(),
      lengthFt: z.number().optional(),
      type: z.string().max(120).optional(),
      marina: z.string().max(200).optional(),
      // Phone-lead (Retell) additions — boat attributes captured on the call. All
      // optional, so existing spokes and golden fixtures are unaffected.
      engineType: z.string().max(40).optional(),
      engineCount: z.number().int().nonnegative().max(20).optional(),
      onTrailer: z.boolean().optional(),
      location: z.string().max(200).optional(),
    })
    .optional(),
  meta: z
    .object({
      site: z.string().max(200).optional(),
      page: z.string().max(300).optional(),
      preferredDate: z.string().max(40).optional(),
      preferredTime: z.string().max(40).optional(),
      utm: z.record(z.string(), z.string()).optional(),
      // Locality tag from A1 Marine Storage /boat-storage/[town] pages.
      locality: z.string().max(80).optional(),
      // Phone-lead (Retell): `urgent` from post-call analysis escalates the lead to a
      // high-priority notification + needs-attention; `retell.callId` links the lead
      // back to its retell_calls row (raw transcript + analysis).
      urgent: z.boolean().optional(),
      retell: z.object({ callId: z.string().min(1).max(200) }).optional(),

      // ── Self-serve quoting (Phase 5) ───────────────────────────────────────
      // Additive and optional, so every existing spoke and golden fixture is
      // unaffected. They live in `meta` because LEAD_SCHEMA.md fixes the
      // envelope's top level at schemaVersion 1 and says to version rather than
      // mutate it.
      //
      // Declaring them MATTERS: this object is closed, and zod strips unknown
      // keys SILENTLY. A spoke sending logistics without this would have it
      // dropped on the floor with no error, and the auto-quote would see a lead
      // with no transport and no selection.

      /** Transport + add-on choices from the calculator. */
      logistics: z
        .object({
          boatLocation: z.string().max(40).optional(),
          town: z.string().max(80).optional(),
          postalCode: z.string().max(12).optional(),
          transportBand: z.string().max(20).optional(),
          distanceKm: z.number().nonnegative().max(5000).optional(),
          bandResolution: z.string().max(30).optional(),
          pickup: z.boolean().optional(),
          delivery: z.boolean().optional(),
          trailerProvided: z.boolean().optional(),
          inWaterNotice: z.boolean().optional(),
          batteryCount: z.number().int().nonnegative().max(24).optional(),
          extendedMonths: z.number().int().nonnegative().max(24).optional(),
          oilChangeOutboard: z.boolean().optional(),
          springWrapRemoval: z.boolean().optional(),
        })
        .optional(),

      /**
       * What the customer chose, by catalog SERVICE KEY.
       *
       * Required for an auto-quote. The envelope's lineItems carry priced
       * DESCRIPTIONS, which cannot be re-priced against a tenant's catalog
       * without string-matching a customer-facing label. Keys can.
       */
      selection: z
        .object({
          bundleKey: z.string().max(60).optional(),
          variant: z.string().max(40).optional(),
          services: z
            .array(
              z.object({
                serviceKey: z.string().min(1).max(80),
                measure: z.number().positive().max(2000).optional(),
                quantity: z.number().int().positive().max(24).optional(),
              }),
            )
            .max(30)
            .optional(),
        })
        .optional(),

      /** Short reference printed on a downloaded PDF, so the two match. */
      quoteRef: z.string().max(40).optional(),

      /**
       * Explicit SMS consent captured on the form (website forms / embed). `granted`
       * true = the person ticked an opt-in checkbox → the contact is recorded with
       * EXPRESS consent (`express_optin`, does not expire). Absent or false = the
       * inquiry itself is implied consent, exactly as before. `text` is the exact
       * wording shown, kept in raw_leads as the consent record. Additive + optional.
       */
      smsConsent: z
        .object({
          granted: z.boolean(),
          text: z.string().max(600).optional(),
          capturedAt: z.string().datetime().optional(),
        })
        .optional(),
    })
    .optional(),
});

export type LeadEnvelope = z.infer<typeof leadEnvelopeSchema>;
export type LeadLineItem = z.infer<typeof leadLineItemSchema>;

export interface EnvelopeParseResult {
  valid: boolean;
  envelope: LeadEnvelope | null;
  /** Present when valid=false: a short reason for the "needs attention" note. */
  reason: string | null;
}

/** Parse without ever throwing — invalid payloads are sorted, not rejected. */
export function parseLeadEnvelope(body: unknown): EnvelopeParseResult {
  const result = leadEnvelopeSchema.safeParse(body);
  if (result.success) {
    return { valid: true, envelope: result.data, reason: null };
  }
  const first = result.error.issues[0];
  const reason = first ? `${first.path.join(".") || "(root)"}: ${first.message}` : "invalid envelope";
  return { valid: false, envelope: null, reason };
}
