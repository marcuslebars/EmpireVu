/**
 * The Bookkeeper's hold on automatic reminders (a promise to pay, or an active payment plan),
 * read by the email reminder sweep (invoices/reminders.ts) so emails pause too. No runtime
 * imports: it must stay safe to import from the invoices module. Tolerant: any error (e.g. the
 * table isn't migrated yet) means "no hold", so email reminders behave exactly as before.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

/** True when this invoice's automatic reminders are on hold through `today` (YYYY-MM-DD). */
export async function isCollectionsHold(db: unknown, organizationId: string, invoiceId: string, today: string): Promise<boolean> {
  try {
    const { data, error } = await (db as Db)
      .from("invoice_collections")
      .select("hold_until")
      .eq("organization_id", organizationId)
      .eq("invoice_id", invoiceId)
      .maybeSingle();
    if (error || !data) return false;
    const until = (data as { hold_until: string | null }).hold_until;
    return typeof until === "string" && until >= today;
  } catch {
    return false;
  }
}
