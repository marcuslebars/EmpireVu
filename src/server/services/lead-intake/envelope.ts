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
  formType: z.enum(["quote", "contact", "booking"]),
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
  asset: z
    .object({
      makeModel: z.string().max(200).optional(),
      lengthFt: z.number().optional(),
      type: z.string().max(120).optional(),
      marina: z.string().max(200).optional(),
    })
    .optional(),
  meta: z
    .object({
      site: z.string().max(200).optional(),
      page: z.string().max(300).optional(),
      preferredDate: z.string().max(40).optional(),
      preferredTime: z.string().max(40).optional(),
      utm: z.record(z.string(), z.string()).optional(),
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
