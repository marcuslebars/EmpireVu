/**
 * Custom reminder wording — shared by the reminder email (server) and the settings
 * preview (browser), so what the owner previews is exactly what the customer gets.
 * Pure: no imports, no I/O.
 */

export const REMINDER_PLACEHOLDERS = [
  { key: "first_name", label: "Customer first name", sample: "Pat" },
  { key: "customer_name", label: "Customer name", sample: "Pat Smith" },
  { key: "invoice_number", label: "Invoice number", sample: "INV-2026-0042" },
  { key: "amount_due", label: "Amount due", sample: "$565.00" },
  { key: "due_date", label: "Due date", sample: "October 1, 2026" },
  { key: "days_overdue", label: "Days overdue", sample: "7" },
  { key: "company_name", label: "Your business name", sample: "A1 Marine Care" },
] as const;

export type ReminderPlaceholder = (typeof REMINDER_PLACEHOLDERS)[number]["key"];
export type ReminderValues = Record<ReminderPlaceholder, string>;

export const REMINDER_SUBJECT_MAX = 150;
export const REMINDER_MESSAGE_MAX = 2000;

/** What the built-in reminders say, written as templates — the editor's starting point. */
export const DEFAULT_REMINDER_SUBJECT = "Past due: invoice {invoice_number} ({amount_due})";
export const DEFAULT_REMINDER_MESSAGE =
  "Hi {first_name},\n\n" +
  "A friendly reminder that invoice {invoice_number} for {amount_due} was due on {due_date}. " +
  "If you've already paid, thank you — please ignore this.";

/** Fill {placeholders}. Unknown ones are left as typed so a typo is visible, not silently dropped. */
export function fillReminderTemplate(template: string, values: ReminderValues): string {
  return template.replace(/\{\s*([a-z_]+)\s*\}/g, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key as ReminderPlaceholder] : whole,
  );
}

/** Placeholders in a template that don't exist (for the editor's warning). */
export function unknownPlaceholders(template: string): string[] {
  const known = new Set<string>(REMINDER_PLACEHOLDERS.map((p) => p.key));
  const out = new Set<string>();
  for (const m of template.matchAll(/\{\s*([a-z_]+)\s*\}/g)) if (!known.has(m[1])) out.add(m[1]);
  return [...out];
}

export function sampleReminderValues(companyName?: string | null): ReminderValues {
  const v = Object.fromEntries(REMINDER_PLACEHOLDERS.map((p) => [p.key, p.sample])) as ReminderValues;
  if (companyName?.trim()) v.company_name = companyName.trim();
  return v;
}
