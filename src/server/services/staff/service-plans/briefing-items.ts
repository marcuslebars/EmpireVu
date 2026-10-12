/**
 * Lines for the Office manager's 07:00 briefing (wired in at integration; this file only reads).
 * One short line each, nothing when there's nothing to say:
 *
 *   "2 plan renewals unpaid (due Fri)"   renewal links sent, not paid yet; due = the earliest term end
 *   "1 plan lapses today if unpaid"      14 days after the term ended
 *
 * Off (no lines) wherever Service plans isn't working (house orgs, no active plan). Never throws.
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import type { Db, ServiceAgreementRow } from "./db-types";
import { addDaysYmd, daysBetween, shortDate } from "./schedule";
import { LAPSE_GRACE_DAYS, servicePlansActiveFor } from "./settings";

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function dueLabel(due: string, localDate: string): string {
  const days = daysBetween(localDate, due);
  if (days < 0) return `was ${shortDate(due)}`;
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days < 7) return WEEKDAY[new Date(`${due}T12:00:00Z`).getUTCDay()];
  return shortDate(due);
}

export async function briefingItems(admin: AdminClient, scope: { organizationId: string; companyId: string; timeZone?: string }, localDate: string): Promise<string[]> {
  try {
    if (!(await servicePlansActiveFor(admin, scope))) return [];
    const { data, error } = await (admin as Db)
      .from("service_agreements")
      .select("id, status, term_end, renewal_texted_at, renewed_by_agreement_id")
      .eq("organization_id", scope.organizationId)
      .eq("company_id", scope.companyId)
      .eq("status", "renewal_due")
      .limit(500);
    if (error) return [];
    const unpaid = ((data ?? []) as Array<Pick<ServiceAgreementRow, "term_end" | "renewal_texted_at" | "renewed_by_agreement_id">>).filter((a) => a.term_end && a.renewal_texted_at && !a.renewed_by_agreement_id);
    if (unpaid.length === 0) return [];
    const items: string[] = [];
    const ends = unpaid.map((a) => a.term_end as string).sort();
    items.push(`${unpaid.length} plan renewal${unpaid.length === 1 ? "" : "s"} unpaid (due ${dueLabel(ends[0], localDate)})`);
    const lapsing = ends.filter((d) => addDaysYmd(d, LAPSE_GRACE_DAYS + 1) === localDate).length;
    if (lapsing) items.push(`${lapsing} plan${lapsing === 1 ? "" : "s"} lapse${lapsing === 1 ? "s" : ""} today if unpaid`);
    return items;
  } catch {
    return [];
  }
}
