/**
 * The import's hold on automatic reminders: an imported open balance (invoices.import_hold) gets
 * no reminder email, no Bookkeeper text and no invoice.overdue automation until the owner says Y
 * to chase_imported_balances. Read by the email reminder sweep (invoices/reminders.ts). The
 * Bookkeeper's text sweep already skips these: an imported balance is also reminders_paused.
 *
 * No runtime imports: it must stay safe to import from the invoices module. Tolerant: any error
 * (e.g. the column isn't migrated yet) means "no hold", so reminders behave exactly as before.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

/** True while this invoice is an imported balance the owner hasn't OK'd for reminders. */
export async function isImportHold(db: unknown, organizationId: string, invoiceId: string): Promise<boolean> {
  try {
    const { data, error } = await (db as Db).from("invoices").select("import_hold").eq("organization_id", organizationId).eq("id", invoiceId).maybeSingle();
    if (error || !data) return false;
    return (data as { import_hold?: boolean | null }).import_hold === true;
  } catch {
    return false;
  }
}
