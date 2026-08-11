import { z } from "zod";

/**
 * The canonical lead envelope, schemaVersion 1. This is the contract every spoke
 * emits and the winter Jobber adapter is written against. See docs/LEAD_SCHEMA.md.
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
  // "winter-storage-quote": A1 Marine Storage locality / ad lead-capture (feeds the
  // Jobber sync worker). Additive — existing spokes are unaffected.
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
