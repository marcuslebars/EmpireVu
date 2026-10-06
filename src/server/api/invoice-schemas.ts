import { z } from "zod";

/** One invoice line as the dashboard sends it. Prices in cents; discounts may be negative. */
export const invoiceLineSchema = z.object({
  // May be blank on a draft; sending checks every line has one.
  label: z.string().trim().max(300),
  description: z.string().max(2000).nullable().optional(),
  quantity: z.number().positive().max(100_000),
  unitPriceCents: z.number().int().min(-100_000_000).max(100_000_000),
});

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date.");

export const invoiceWriteSchema = z.object({
  contactId: z.string().uuid().nullable().optional(),
  customerAccountId: z.string().uuid().nullable().optional(),
  title: z.string().max(300).nullable().optional(),
  // A draft can be saved with no lines yet; sending needs at least one.
  lines: z.array(invoiceLineSchema).max(100),
  taxRateBps: z.number().int().min(0).max(5000).nullable().optional(),
  creditCents: z.number().int().min(0).max(100_000_000).nullable().optional(),
  dueDate: ymd.nullable().optional(),
  paymentTermsDays: z.number().int().min(0).max(365).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  internalNotes: z.string().max(5000).nullable().optional(),
  billToAddress: z.string().max(1000).nullable().optional(),
});

export const invoiceCreateSchema = invoiceWriteSchema.extend({
  companyId: z.string().uuid(),
});

export const invoiceUpdateSchema = invoiceWriteSchema.partial();

export const recordPaymentSchema = z.object({
  amountCents: z.number().int().positive().max(100_000_000),
  method: z.enum(["etransfer", "cheque", "cash", "other", "card", "bank_debit"]),
  receivedAt: z.string().datetime({ offset: true }).nullable().optional(),
  reference: z.string().max(200).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  sendReceipt: z.boolean().optional(),
});

export const customerAccountSchema = z.object({
  name: z.string().trim().min(1).max(200),
  billingEmail: z.string().trim().email().max(254).nullable().optional().or(z.literal("")),
  billingPhone: z.string().max(40).nullable().optional(),
  billingAddress: z.string().max(1000).nullable().optional(),
  taxNumber: z.string().max(60).nullable().optional(),
  paymentTermsDays: z.number().int().min(0).max(365).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
});
