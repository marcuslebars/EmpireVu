/**
 * The Profit advisor's background passes (docs/ai-staff.md → "Profit advisor"):
 *
 *   profit_advisor:weekly   every 10 min. On the owner's day (default Friday) from their time
 *                           (default 15:00) until 20:00 local, ONE money text — only when 2+ jobs
 *                           were finished in the last 7 days or the next 30 days look tight.
 *   profit_advisor:pricing  every 30 min. The first Tuesday of the month (caught up through Friday),
 *                           09:00–17:00 local: the pricing check, and up to 2 price_change questions.
 *
 * Each run is claimed first in profit_advisor_runs (unique company + kind + key: the local date /
 * the month), so overlapping workers do it once. A failed weekly text is retried after 30 minutes,
 * up to 3 tries, inside the same window.
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { findOwnerCompanies, sendOwnerSms } from "@/server/services/owner-channel/common";
import { zonedInstant } from "@/server/services/booking-windows";
import type { Db, ProfitRunRow, RunKind } from "./db-types";
import { forecastFor } from "./forecast-data";
import { addDays, daysBetween, firstTuesdayOf, localDay, localHHMM, weekdayOfDate } from "./format";
import { loadJobProfits } from "./jobs";
import { askPriceChange, defaultPriceChangeDeps, type PriceChangeDeps } from "./price-change";
import { MAX_ASKS_PER_RUN } from "./pricing";
import { runPricingCheck } from "./pricing-check";
import type { ProfitCompany } from "./settings";
import { summarizeJobs } from "./summary";
import { weeklyText } from "./texts";

const RETRY_AFTER_MS = 30 * 60_000;
const MAX_ATTEMPTS = 3;

export interface SweepDeps {
  sendOwnerSms: typeof sendOwnerSms;
  priceChange: PriceChangeDeps;
}

export const defaultSweepDeps: SweepDeps = { sendOwnerSms, priceChange: defaultPriceChangeDeps };

/** "Northshore Roofing: " when the owner's cell owns more than one business, else "". */
async function businessPrefix(admin: AdminClient, company: ProfitCompany): Promise<string> {
  try {
    return company.ownerPhone && (await findOwnerCompanies(admin, company.ownerPhone)).length > 1 ? `${company.name}: ` : "";
  } catch {
    return "";
  }
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String((err as { message?: unknown })?.message ?? err)).slice(0, 300);

/** Claim one run (insert; a failed one is re-claimed after 30 min, up to 3 tries). Null → someone else has it. */
export async function claimRun(admin: AdminClient, company: Pick<ProfitCompany, "organizationId" | "companyId">, kind: RunKind, runKey: string, nowMs: number): Promise<ProfitRunRow | null> {
  const db = admin as Db;
  const at = new Date(nowMs).toISOString();
  const { data, error } = await db
    .from("profit_advisor_runs")
    .insert({ organization_id: company.organizationId, company_id: company.companyId, kind, run_key: runKey, status: "claimed", attempts: 1, created_at: at, updated_at: at })
    .select("*");
  if (!error) return ((data ?? []) as ProfitRunRow[])[0] ?? null;
  if ((error as { code?: string }).code !== "23505") throw error;
  const { data: existing } = await db.from("profit_advisor_runs").select("*").eq("company_id", company.companyId).eq("kind", kind).eq("run_key", runKey).maybeSingle();
  const row = existing as ProfitRunRow | null;
  if (!row || row.status !== "failed" || row.attempts >= MAX_ATTEMPTS || nowMs - Date.parse(row.updated_at) < RETRY_AFTER_MS) return null;
  const { data: again } = await db
    .from("profit_advisor_runs")
    .update({ status: "claimed", attempts: row.attempts + 1, updated_at: at })
    .eq("id", row.id)
    .eq("status", "failed")
    .eq("attempts", row.attempts)
    .select("*");
  return ((again ?? []) as ProfitRunRow[])[0] ?? null;
}

async function finishRun(admin: AdminClient, id: string, nowMs: number, patch: Partial<Pick<ProfitRunRow, "status" | "body" | "detail" | "last_error">>): Promise<void> {
  const { error } = await (admin as Db).from("profit_advisor_runs").update({ ...patch, updated_at: new Date(nowMs).toISOString() }).eq("id", id);
  if (error) console.error("[profit-advisor] run update failed", id, error.message);
}

/** The weekly window: [same local time a week ago, this week's send time). */
export function weekWindow(today: string, time: string, timeZone: string): { fromIso: string; toIso: string } {
  return { fromIso: zonedInstant(addDays(today, -7), time, timeZone).toISOString(), toIso: zonedInstant(today, time, timeZone).toISOString() };
}

export type WeeklyOutcome = "off" | "not_now" | "claimed_elsewhere" | "skipped" | "sent" | "failed";

/** One company's weekly money text. */
export async function runCompanyWeekly(admin: AdminClient, company: ProfitCompany, nowMs: number, deps: SweepDeps = defaultSweepDeps): Promise<WeeklyOutcome> {
  const s = company.settings;
  if (!company.active || !s.enabled || !s.weekly.enabled || !company.ownerPhone) return "off";
  const today = localDay(nowMs, company.timeZone);
  const hhmm = localHHMM(nowMs, company.timeZone);
  if (weekdayOfDate(today) !== s.weekly.day || hhmm < s.weekly.time || hhmm >= "20:00") return "not_now";
  const run = await claimRun(admin, company, "weekly", today, nowMs);
  if (!run) return "claimed_elsewhere";
  try {
    const { fromIso, toIso } = weekWindow(today, s.weekly.time, company.timeZone);
    const jobs = await loadJobProfits(admin, company, fromIso, toIso, nowMs);
    const summary = summarizeJobs(jobs.rows, jobs.missingRateNames);
    const forecast = await forecastFor(admin, company, nowMs);
    const tight = Boolean(forecast?.tight30.tight);
    const detail = { jobs: summary.jobs, billedCents: summary.billedCents, profitCents: summary.profitCents, tight, short30Cents: forecast?.tight30.shortCents ?? null };
    if (summary.jobs < 2 && !tight) {
      await finishRun(admin, run.id, nowMs, { status: "skipped", detail: { ...detail, reason: "quiet_week" } });
      return "skipped";
    }
    const body = `${await businessPrefix(admin, company)}${weeklyText(summary, forecast, Number(today.slice(0, 4)))}`;
    const sent = await deps.sendOwnerSms(admin, { to: company.ownerPhone, body, organizationId: company.organizationId, companyId: company.companyId, platformBrand: company.platformBrand });
    if (sent.status === "sent") {
      await finishRun(admin, run.id, nowMs, { status: "sent", body, detail });
      return "sent";
    }
    if (sent.status === "blocked") {
      await finishRun(admin, run.id, nowMs, { status: "skipped", body, detail: { ...detail, reason: sent.reason ?? "blocked" } });
      return "skipped";
    }
    await finishRun(admin, run.id, nowMs, { status: "failed", body, detail, last_error: sent.reason ?? "send failed" });
    return "failed";
  } catch (err) {
    console.error("[profit-advisor] weekly failed", company.companyId, errText(err));
    await finishRun(admin, run.id, nowMs, { status: "failed", last_error: errText(err) });
    return "failed";
  }
}

/** Is today the monthly check's day (first Tuesday, caught up through that Friday) and 09:00–17:00? PURE. */
export function pricingDue(today: string, hhmm: string): boolean {
  const first = firstTuesdayOf(today);
  const late = daysBetween(first, today);
  return late >= 0 && late <= 3 && hhmm >= "09:00" && hhmm < "17:00";
}

export type PricingOutcome = { outcome: "off" | "not_now" | "claimed_elsewhere" | "done" | "failed"; asked: number };

/** One company's monthly pricing check (+ up to 2 price_change questions). */
export async function runCompanyPricing(admin: AdminClient, company: ProfitCompany, nowMs: number, deps: SweepDeps = defaultSweepDeps): Promise<PricingOutcome> {
  const s = company.settings;
  if (!company.active || !s.enabled || !s.pricingCheck.enabled) return { outcome: "off", asked: 0 };
  const today = localDay(nowMs, company.timeZone);
  if (!pricingDue(today, localHHMM(nowMs, company.timeZone))) return { outcome: "not_now", asked: 0 };
  const run = await claimRun(admin, company, "pricing", today.slice(0, 7), nowMs);
  if (!run) return { outcome: "claimed_elsewhere", asked: 0 };
  try {
    const report = await runPricingCheck(admin, company, nowMs);
    const margin = report.companyMargin ?? 0;
    const candidates = report.items
      .filter((i) => i.proposal)
      .sort((a, b) => (a.margin ?? 0) - (b.margin ?? 0) || b.jobs - a.jobs)
      .slice(0, MAX_ASKS_PER_RUN);
    let asked = 0;
    for (const item of candidates) {
      const id = await askPriceChange(admin, company, { proposal: item.proposal!, stats: item, companyMargin: margin, windowDays: report.windowDays, runKey: today.slice(0, 7) }, nowMs, deps.priceChange).catch((err: unknown) => {
        console.error("[profit-advisor] price question failed", company.companyId, errText(err));
        return null;
      });
      if (id) asked += 1;
    }
    await finishRun(admin, run.id, nowMs, {
      status: asked > 0 ? "sent" : "skipped",
      detail: { asked, underpriced: report.items.filter((i) => i.underpriced).length, items: report.items.length, companyMarginPct: report.companyMargin != null ? Math.round(report.companyMargin * 100) : null },
    });
    return { outcome: "done", asked };
  } catch (err) {
    console.error("[profit-advisor] pricing check failed", company.companyId, errText(err));
    await finishRun(admin, run.id, nowMs, { status: "failed", last_error: errText(err) });
    return { outcome: "failed", asked: 0 };
  }
}
