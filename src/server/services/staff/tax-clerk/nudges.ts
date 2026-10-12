/**
 * Receipt nudges (sweep `tax_clerk:nudges`), owner texts from the platform number:
 *
 *   weekly  Monday 09:00-12:00 local, only when something needs doing in the last 30 days:
 *           expenses with no receipt picture, job-type buys (materials, subcontractors,
 *           equipment rental) with no job, receipt pictures still missing their total.
 *   tip     once, in the first week the Tax Clerk is on for the company (from its first sweep,
 *           a day later, weekdays 10:00-17:00), only if no receipt has been texted in yet.
 *
 * tax_clerk_notices (unique company + kind + key) is the claim, so each goes once.
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { addDays, localDate, weekdayOf } from "@/server/services/booking-windows";
import { localHour, sendOwnerSms } from "@/server/services/owner-channel/common";
import type { Db, TaxClerkNoticeRow } from "./db-types";
import type { TaxClerkCompany } from "./settings";

export const JOB_CATEGORIES = new Set(["materials", "subcontractor", "equipment"]);
const TIP_WINDOW_MS = 7 * 86_400_000;
const TIP_DELAY_MS = 86_400_000;

export const TIP_TEXT =
  "Tip: text me a photo of any receipt or supplier bill and I'll file it as an expense with the HST. Add words like \"Jones job\", \"personal card\" or \"PO-12\" if you want.";

export interface NudgeCounts {
  noReceipt: number;
  noJob: number;
  toFinish: number;
}

export async function nudgeCounts(admin: AdminClient, company: Pick<TaxClerkCompany, "organizationId" | "companyId">, today: string): Promise<NudgeCounts> {
  const db = admin as Db;
  const since = addDays(today, -30);
  const { data } = await db
    .from("expenses")
    .select("id, category, booking_id, receipt_path")
    .eq("organization_id", company.organizationId)
    .eq("company_id", company.companyId)
    .gte("spent_on", since)
    .lte("spent_on", today)
    .limit(2000);
  const rows = (data ?? []) as Array<{ category: string; booking_id: string | null; receipt_path: string | null }>;
  const { data: review } = await db.from("receipt_texts").select("id").eq("organization_id", company.organizationId).eq("company_id", company.companyId).eq("status", "needs_review").limit(200);
  return {
    noReceipt: rows.filter((r) => !r.receipt_path).length,
    noJob: rows.filter((r) => JOB_CATEGORIES.has(r.category) && !r.booking_id).length,
    toFinish: ((review ?? []) as unknown[]).length,
  };
}

/** The Monday text, or null when there's nothing to say. PURE. */
export function weeklyNudgeText(c: NudgeCounts): string | null {
  const parts: string[] = [];
  if (c.noReceipt) parts.push(`${c.noReceipt} expense${c.noReceipt === 1 ? " has" : "s have"} no receipt`);
  if (c.noJob) parts.push(`${c.noJob} materials buy${c.noJob === 1 ? " has" : "s have"} no job`);
  const first = parts.length ? `Receipts check (last 30 days): ${parts.join(" and ")}.` : "";
  const finish = c.toFinish ? ` ${c.toFinish} receipt picture${c.toFinish === 1 ? " still needs its" : "s still need their"} total.` : "";
  if (!first && !finish) return null;
  return `${first || "Receipts check:"}${finish} Text me a photo of any receipt, or "receipts" for the list.`.replace(/\s+/g, " ").trim();
}

async function claimNotice(admin: AdminClient, company: TaxClerkCompany, kind: TaxClerkNoticeRow["kind"], key: string, nowMs: number, status: TaxClerkNoticeRow["status"] = "claimed"): Promise<TaxClerkNoticeRow | null> {
  const { data, error } = await (admin as Db)
    .from("tax_clerk_notices")
    .insert({ organization_id: company.organizationId, company_id: company.companyId, kind, key, status, created_at: new Date(nowMs).toISOString() })
    .select("*")
    .single();
  return error || !data ? null : (data as TaxClerkNoticeRow);
}

async function settleNotice(admin: AdminClient, row: TaxClerkNoticeRow, status: TaxClerkNoticeRow["status"], body: string | null, nowMs: number): Promise<void> {
  await (admin as Db)
    .from("tax_clerk_notices")
    .update({ status, body: body?.slice(0, 700) ?? null, sent_at: status === "sent" ? new Date(nowMs).toISOString() : null })
    .eq("id", row.id)
    .eq("organization_id", row.organization_id);
}

export interface NudgeDeps {
  sendOwnerSms: typeof sendOwnerSms;
}

export const defaultNudgeDeps: NudgeDeps = { sendOwnerSms };

export async function runCompanyWeeklyNudge(admin: AdminClient, company: TaxClerkCompany, nowMs: number, deps: NudgeDeps = defaultNudgeDeps): Promise<"sent" | "nothing" | "not_due" | "claimed_elsewhere" | "failed"> {
  if (!company.settings.nudges.weekly || !company.settings.receipts.enabled || !company.ownerPhone) return "not_due";
  const today = localDate(new Date(nowMs), company.timeZone);
  const hour = localHour(nowMs, company.timeZone);
  if (weekdayOf(today) !== 1 || hour < 9 || hour >= 12) return "not_due";
  const row = await claimNotice(admin, company, "weekly_nudge", today, nowMs);
  if (!row) return "claimed_elsewhere";
  const text = weeklyNudgeText(await nudgeCounts(admin, company, today));
  if (!text) {
    await settleNotice(admin, row, "skipped", null, nowMs);
    return "nothing";
  }
  const sent = await deps.sendOwnerSms(admin, { to: company.ownerPhone, body: text, organizationId: company.organizationId, companyId: company.companyId, platformBrand: company.platformBrand });
  await settleNotice(admin, row, sent.status === "sent" ? "sent" : "failed", text, nowMs);
  return sent.status === "sent" ? "sent" : "failed";
}

export async function runCompanyTip(admin: AdminClient, company: TaxClerkCompany, nowMs: number, deps: NudgeDeps = defaultNudgeDeps): Promise<"sent" | "not_due" | "skipped" | "claimed_elsewhere" | "failed"> {
  if (!company.settings.nudges.tip || !company.settings.receipts.enabled || !company.ownerPhone) return "not_due";
  const db = admin as Db;
  const { data: seen } = await db.from("tax_clerk_notices").select("*").eq("organization_id", company.organizationId).eq("company_id", company.companyId).in("kind", ["first_seen", "receipt_tip"]);
  const rows = (seen ?? []) as TaxClerkNoticeRow[];
  if (rows.some((r) => r.kind === "receipt_tip")) return "not_due";
  const first = rows.find((r) => r.kind === "first_seen");
  if (!first) {
    await claimNotice(admin, company, "first_seen", "once", nowMs, "skipped");
    return "not_due";
  }
  const age = nowMs - Date.parse(first.created_at);
  if (age < TIP_DELAY_MS) return "not_due";
  if (age > TIP_WINDOW_MS) {
    await claimNotice(admin, company, "receipt_tip", "once", nowMs, "skipped");
    return "skipped";
  }
  const today = localDate(new Date(nowMs), company.timeZone);
  const hour = localHour(nowMs, company.timeZone);
  const day = weekdayOf(today);
  if (day === 0 || day === 6 || hour < 10 || hour >= 17) return "not_due";
  const { data: texted } = await db.from("receipt_texts").select("id").eq("organization_id", company.organizationId).eq("company_id", company.companyId).limit(1);
  if (((texted ?? []) as unknown[]).length) {
    await claimNotice(admin, company, "receipt_tip", "once", nowMs, "skipped");
    return "skipped";
  }
  const row = await claimNotice(admin, company, "receipt_tip", "once", nowMs);
  if (!row) return "claimed_elsewhere";
  const sent = await deps.sendOwnerSms(admin, { to: company.ownerPhone, body: TIP_TEXT, organizationId: company.organizationId, companyId: company.companyId, platformBrand: company.platformBrand });
  await settleNotice(admin, row, sent.status === "sent" ? "sent" : "failed", TIP_TEXT, nowMs);
  return sent.status === "sent" ? "sent" : "failed";
}

export async function sweepNudges(admin: AdminClient, nowMs: number, companies: TaxClerkCompany[], deps: NudgeDeps = defaultNudgeDeps): Promise<void> {
  for (const company of companies) {
    try {
      await runCompanyTip(admin, company, nowMs, deps);
      await runCompanyWeeklyNudge(admin, company, nowMs, deps);
    } catch (err) {
      console.error("[tax-clerk] nudge failed for a company:", err instanceof Error ? err.message : err);
    }
  }
}
