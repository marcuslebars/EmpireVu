/**
 * Per-brand invoice settings, stored in companies.invoice_settings (jsonb).
 *
 * One jsonb rather than a column per knob so a new option never needs a
 * migration. Everything is optional in storage and defaulted HERE, so a company
 * that has never opened the settings screen still produces a sensible invoice:
 * due on receipt, card payments on, nothing else offered until it's configured.
 */
import { z } from "zod";

export const PAYMENT_METHODS = ["card", "bank_debit", "etransfer", "cheque", "cash", "other"] as const;
export type InvoicePaymentMethod = (typeof PAYMENT_METHODS)[number];

/** Methods the customer pays online, through Stripe. The rest are recorded by staff. */
export const ONLINE_METHODS: readonly InvoicePaymentMethod[] = ["card", "bank_debit"];

const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .transform((v) => v.trim())
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));

export const invoiceSettingsSchema = z.object({
  /** Prefix on the invoice number: "INV" → INV-2026-0001. */
  numberPrefix: z
    .string()
    .max(12)
    .regex(/^[A-Za-z0-9-]*$/, "Use letters, numbers and dashes only.")
    .optional()
    .nullable(),
  /** Default days until due for individual customers (0 = due on receipt). */
  paymentTermsDays: z.number().int().min(0).max(365).optional().nullable(),
  /** Default HST/GST rate, basis points (1300 = 13%). */
  taxRateBps: z.number().int().min(0).max(5000).optional().nullable(),
  /** Printed at the bottom of every invoice (thank-you, late fee terms, etc.). */
  footerText: optionalText(2000),

  acceptCard: z.boolean().optional().nullable(),
  /** Canadian pre-authorized debit (Stripe ACSS). Off until the brand turns it on. */
  acceptBankDebit: z.boolean().optional().nullable(),
  acceptEtransfer: z.boolean().optional().nullable(),
  etransferEmail: z.string().email().max(254).optional().nullable().or(z.literal("")),
  /** e.g. "Auto-deposit is on — no security question needed." */
  etransferInstructions: optionalText(500),
  acceptCheque: z.boolean().optional().nullable(),
  chequePayableTo: optionalText(200),
  chequeMailingAddress: optionalText(500),
  acceptCash: z.boolean().optional().nullable(),

  /** Overdue reminders (days AFTER the due date). */
  remindersEnabled: z.boolean().optional().nullable(),
  reminderDays: z.array(z.number().int().min(1).max(180)).max(6).optional().nullable(),
});

export type InvoiceSettingsInput = z.input<typeof invoiceSettingsSchema>;

export interface InvoiceSettings {
  numberPrefix: string;
  paymentTermsDays: number;
  taxRateBps: number;
  footerText: string | null;
  acceptCard: boolean;
  acceptBankDebit: boolean;
  acceptEtransfer: boolean;
  etransferEmail: string | null;
  etransferInstructions: string | null;
  acceptCheque: boolean;
  chequePayableTo: string | null;
  chequeMailingAddress: string | null;
  acceptCash: boolean;
  remindersEnabled: boolean;
  reminderDays: number[];
}

export const DEFAULT_REMINDER_DAYS = [1, 7, 14];

function envTaxRateBps(): number {
  const n = Number(process.env.QUOTE_TAX_RATE_BPS);
  return Number.isFinite(n) && n >= 0 && n <= 5000 ? Math.round(n) : 1300;
}

/**
 * Parse stored settings, tolerating junk: an unparseable value falls back to the
 * defaults field by field rather than failing an invoice send over a bad setting.
 */
export function parseInvoiceSettings(raw: unknown): InvoiceSettings {
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const parsed = invoiceSettingsSchema.safeParse(obj);
  const s: Partial<z.output<typeof invoiceSettingsSchema>> = parsed.success ? parsed.data : salvage(obj);

  const reminderDays = [...new Set((s.reminderDays ?? DEFAULT_REMINDER_DAYS).filter((d) => d > 0))].sort(
    (a, b) => a - b,
  );
  const etransferEmail = typeof s.etransferEmail === "string" && s.etransferEmail.trim() ? s.etransferEmail.trim() : null;

  return {
    numberPrefix: (s.numberPrefix ?? "").trim() || "INV",
    paymentTermsDays: s.paymentTermsDays ?? 0,
    taxRateBps: s.taxRateBps ?? envTaxRateBps(),
    footerText: s.footerText ?? null,
    acceptCard: s.acceptCard ?? true,
    acceptBankDebit: s.acceptBankDebit ?? false,
    // e-Transfer is only offered once there is an address to send it to.
    acceptEtransfer: (s.acceptEtransfer ?? false) && etransferEmail !== null,
    etransferEmail,
    etransferInstructions: s.etransferInstructions ?? null,
    acceptCheque: s.acceptCheque ?? false,
    chequePayableTo: s.chequePayableTo ?? null,
    chequeMailingAddress: s.chequeMailingAddress ?? null,
    acceptCash: s.acceptCash ?? false,
    remindersEnabled: s.remindersEnabled ?? true,
    reminderDays,
  };
}

/** Keep each field that individually validates; drop the rest. */
function salvage(obj: Record<string, unknown>): Partial<z.output<typeof invoiceSettingsSchema>> {
  const out: Record<string, unknown> = {};
  const shape = invoiceSettingsSchema.shape;
  for (const key of Object.keys(shape) as Array<keyof typeof shape>) {
    if (!(key in obj)) continue;
    const r = shape[key].safeParse(obj[key]);
    if (r.success) out[key] = r.data;
  }
  return out as Partial<z.output<typeof invoiceSettingsSchema>>;
}

/** Format an allocated "2026-0001" with the brand's prefix. */
export function formatInvoiceNumber(settings: Pick<InvoiceSettings, "numberPrefix">, allocated: string): string {
  return `${settings.numberPrefix}-${allocated}`;
}
