/**
 * The payroll lock, as the timesheet service sees it (docs/ai-staff.md → "Hiring & payroll").
 * Once the owner locks a pay period, its time entries can't be added, edited or deleted until
 * an owner/admin unlocks it (an audited route action). time/service.ts checks here first for a
 * plain message; the time_entries trigger (migration 20261012130000) is the backstop for any
 * client write that skips the service. Stopping a clock left running is still allowed.
 *
 * No runtime imports from the staff registry or the owner channel (time/service.ts loads this).
 */
import { ValidationError } from "@/server/organizations/context";

export const PAY_PERIOD_LOCKED_MESSAGE =
  "Those hours are locked for payroll. An owner or admin can unlock the pay period in Settings > AI front desk > Hiring & payroll.";

export class PayPeriodLockedError extends ValidationError {
  constructor() {
    super(PAY_PERIOD_LOCKED_MESSAGE);
    this.name = "PayPeriodLockedError";
  }
}

/** The DB trigger's error (raise exception 'pay_period_locked'). */
export function isPayPeriodLockedError(error: unknown): boolean {
  const message = error && typeof error === "object" ? String((error as { message?: unknown }).message ?? "") : "";
  return message.includes("pay_period_locked");
}

interface SupabaseLike {
  from(table: string): unknown;
}

/**
 * Is an entry of this company (null = general time) starting at `startedAt` inside a locked pay
 * period? Reads pay_periods with the caller's client (every member may read dates + status).
 * A read error counts as not locked here — the trigger still refuses the write.
 */
export async function isTimeLocked(supabase: SupabaseLike, organizationId: string, companyId: string | null, startedAt: string): Promise<boolean> {
  try {
    const at = new Date(startedAt).toISOString();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q = (supabase as any)
      .from("pay_periods")
      .select("id, company_id")
      .eq("organization_id", organizationId)
      .eq("status", "locked")
      .lte("starts_at", at)
      .gt("ends_at", at)
      .limit(5);
    if (companyId) q = q.eq("company_id", companyId);
    const { data, error } = await q;
    if (error) return false;
    return ((data ?? []) as unknown[]).length > 0;
  } catch {
    return false;
  }
}

/** Throw the plain "locked" error when any of these (company, start) pairs is locked. */
export async function assertTimeUnlocked(supabase: SupabaseLike, organizationId: string, items: Array<{ companyId: string | null; startedAt: string }>): Promise<void> {
  for (const item of items) {
    if (await isTimeLocked(supabase, organizationId, item.companyId, item.startedAt)) throw new PayPeriodLockedError();
  }
}
