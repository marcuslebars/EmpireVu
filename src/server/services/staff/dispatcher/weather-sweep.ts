/**
 * The daily weather check (~15:00 company time, catch-up until 20:00): weather-sensitive jobs in
 * the next 48 hours whose window crosses a threshold get a proposed new time (the next open time
 * after the job whose own forecast is fine), and the owner gets ONE weather_reschedule approval
 * per company per day listing every job, old → new time and the forecast reason. Nothing moves
 * without the owner's Y (moves.ts applyMoves).
 *
 * Claimed per company per local day in dispatch_runs (unique), so overlapping workers ask once.
 */
import type { BusyBooking } from "@/server/services/booking-windows";
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { createDispatchApproval, defaultDispatchApprovalDeps, WEATHER_RESCHEDULE_KIND, type DispatchApprovalDeps } from "./approvals";
import type { DispatchCompany } from "./company";
import type { Db } from "./db-types";
import { ensureCompanyLocation, type Geocoder } from "./geocode";
import { isOpenJob, jobPhrase, loadJobs, serviceLabels, type Job } from "./jobs";
import { buildMoveSummary, type PlannedMove } from "./moves";
import { isWeatherSensitiveJob } from "./settings";
import { loadSlotContext, openSlotsFor } from "./slots";
import { hhmmToMinutes, localDate, localMinutes } from "./time";
import { assessWindow, customerReason, getCompanyForecast, type Forecast, type WeatherProvider, type WeatherRisk } from "./weather";

export const WEATHER_HORIZON_MS = 48 * 3_600_000;
/** The daily check runs from check_at until this local time (catch-up if a worker was down). */
export const WEATHER_LATEST = "20:00";
const HOUR = 3_600_000;

export interface WeatherDeps {
  provider: WeatherProvider;
  geocoder: Geocoder | null;
  approvals?: DispatchApprovalDeps;
}

export interface AtRiskJob {
  job: Job;
  risk: WeatherRisk;
}

/** Weather-sensitive open jobs in the next 48h whose window is at risk. */
export async function findAtRiskJobs(admin: AdminClient, company: DispatchCompany, forecast: Forecast, nowMs: number): Promise<{ checked: number; atRisk: AtRiskJob[] }> {
  const jobs = (await loadJobs(admin, company, new Date(nowMs).toISOString(), new Date(nowMs + WEATHER_HORIZON_MS).toISOString())).filter(isOpenJob);
  const sensitive = company.settings.weather.sensitive;
  const labels = Array.isArray(sensitive) ? await serviceLabels(admin, company) : new Map<string, string>();
  const relevant = jobs.filter((j) => isWeatherSensitiveJob(sensitive, { serviceKey: j.serviceKey, title: j.title }, labels));
  const atRisk: AtRiskJob[] = [];
  for (const job of relevant) {
    const start = Date.parse(job.scheduledFor);
    const risk = assessWindow(forecast, start, start + Math.max(60, job.durationMinutes) * 60_000, company.settings.weather.thresholds);
    if (risk.atRisk) atRisk.push({ job, risk });
  }
  return { checked: relevant.length, atRisk };
}

/**
 * Proposed new times: for each at-risk job (earliest first), the first open time at least an hour
 * after it starts whose own forecast window is fine (or beyond the forecast), never a slot already
 * promised to another job in this batch.
 */
export async function planWeatherMoves(
  admin: AdminClient,
  company: DispatchCompany,
  atRisk: AtRiskJob[],
  forecast: Forecast,
  nowMs: number,
): Promise<{ moves: PlannedMove[]; leftAsIs: string[] }> {
  const slots = await loadSlotContext(admin, company, nowMs);
  const promised: BusyBooking[] = [];
  const moves: PlannedMove[] = [];
  const leftAsIs: string[] = [];
  const sorted = [...atRisk].sort((a, b) => Date.parse(a.job.scheduledFor) - Date.parse(b.job.scheduledFor));
  for (const { job, risk } of sorted) {
    const start = Date.parse(job.scheduledFor);
    const candidates = openSlotsFor(slots, { id: job.id, durationMinutes: job.durationMinutes, scheduledFor: job.scheduledFor }, nowMs, {
      extraBusy: promised,
      earliestMs: Math.max(nowMs + 2 * HOUR, start + HOUR),
    }).filter((t) => Date.parse(t.startsAt) <= start + 14 * 86_400_000);
    const pick = candidates.find((t) => {
      const s = Date.parse(t.startsAt);
      return !assessWindow(forecast, s, s + Math.max(60, job.durationMinutes) * 60_000, company.settings.weather.thresholds).atRisk;
    });
    if (!pick) {
      leftAsIs.push(job.customerName);
      continue;
    }
    promised.push({ scheduledFor: pick.startsAt, durationMinutes: job.durationMinutes, windowKey: pick.windowKey });
    moves.push({
      bookingId: job.id,
      contactId: job.contactId,
      who: job.customerName,
      firstName: job.customerFirstName,
      job: jobPhrase(job.title),
      fromStartsAt: job.scheduledFor,
      toStartsAt: pick.startsAt,
      toWindowKey: pick.windowKey,
      reason: risk.reason,
      customerReason: customerReason(risk.kinds),
    });
  }
  return { moves, leftAsIs };
}

/** Is it time for today's check in this company's zone? */
export function weatherCheckDue(company: DispatchCompany, nowMs: number): boolean {
  const now = localMinutes(nowMs, company.timeZone);
  return now >= hhmmToMinutes(company.settings.weather.checkAt) && now < hhmmToMinutes(WEATHER_LATEST);
}

async function claimRun(admin: AdminClient, company: DispatchCompany, runKey: string, nowMs: number): Promise<string | null> {
  const db = admin as Db;
  const { data, error } = await db
    .from("dispatch_runs")
    .insert({ organization_id: company.organizationId, company_id: company.companyId, kind: "weather", run_key: runKey, status: "running" })
    .select("id")
    .single();
  if (!error && data) return (data as { id: string }).id;
  if ((error as { code?: string } | null)?.code !== "23505") throw error;
  // A failed pass may be retried (after 30 minutes); anything else was done or is in progress.
  const { data: existing } = await db
    .from("dispatch_runs")
    .select("id, status, updated_at, created_at")
    .eq("company_id", company.companyId)
    .eq("kind", "weather")
    .eq("run_key", runKey)
    .maybeSingle();
  const row = existing as { id: string; status: string; updated_at?: string; created_at: string } | null;
  if (!row || row.status !== "failed") return null;
  if (nowMs - Date.parse(row.updated_at ?? row.created_at) < 30 * 60_000) return null;
  const { data: reclaimed } = await db.from("dispatch_runs").update({ status: "running" }).eq("id", row.id).eq("status", "failed").select("id");
  return ((reclaimed ?? []) as unknown[]).length > 0 ? row.id : null;
}

async function finishRun(admin: AdminClient, runId: string, patch: Record<string, unknown>): Promise<void> {
  const { error } = await (admin as Db).from("dispatch_runs").update(patch).eq("id", runId);
  if (error) console.error("[dispatcher] weather run update failed", runId, error.message);
}

export type WeatherCheckOutcome =
  | { status: "not_due" | "disabled" | "already" | "no_location" | "no_forecast" | "clear" }
  | { status: "no_open_times"; leftAsIs: string[] }
  | { status: "asked"; approvalId: string; moves: number };

/** One company's daily check (claimed). `force` skips the time-of-day gate (tests / manual runs). */
export async function runWeatherCheck(admin: AdminClient, company: DispatchCompany, nowMs: number, deps: WeatherDeps, options: { force?: boolean } = {}): Promise<WeatherCheckOutcome> {
  if (!company.settings.weather.enabled || company.settings.weather.sensitive === "none") return { status: "disabled" };
  if (!options.force && !weatherCheckDue(company, nowMs)) return { status: "not_due" };
  const runKey = localDate(new Date(nowMs), company.timeZone);
  const runId = await claimRun(admin, company, runKey, nowMs);
  if (!runId) return { status: "already" };
  try {
    const location = await ensureCompanyLocation(admin, company, { geocoder: deps.geocoder, nowMs });
    if (!location) {
      await finishRun(admin, runId, { status: "skipped", detail: { reason: "no_location" } });
      return { status: "no_location" };
    }
    const forecast = await getCompanyForecast(admin, company, location, { provider: deps.provider, nowMs });
    if (!forecast) {
      await finishRun(admin, runId, { status: "failed", detail: { reason: "no_forecast" } });
      return { status: "no_forecast" };
    }
    const { checked, atRisk } = await findAtRiskJobs(admin, company, forecast, nowMs);
    if (atRisk.length === 0) {
      await finishRun(admin, runId, { status: "done", detail: { checked, atRisk: 0 } });
      return { status: "clear" };
    }
    const { moves, leftAsIs } = await planWeatherMoves(admin, company, atRisk, forecast, nowMs);
    if (moves.length === 0) {
      await finishRun(admin, runId, { status: "done", detail: { checked, atRisk: atRisk.length, leftAsIs } });
      return { status: "no_open_times", leftAsIs };
    }
    const headline = `Weather: move ${moves.length === 1 ? "this job" : `these ${moves.length} jobs`}?`;
    const { summary, included } = buildMoveSummary({ flavour: "weather", headline, moves, leftAsIs, businessName: company.businessName, timeZone: company.timeZone });
    // Answer before the first job (an hour's notice), and within the day.
    const firstStart = Math.min(...included.map((m) => Date.parse(m.fromStartsAt)));
    const expiresAt = new Date(Math.max(nowMs + 30 * 60_000, Math.min(firstStart - HOUR, nowMs + 20 * HOUR)));
    const approval = await createDispatchApproval(
      admin,
      {
        organizationId: company.organizationId,
        companyId: company.companyId,
        kind: WEATHER_RESCHEDULE_KIND,
        summary,
        payload: { moves: included, leftAsIs, date: runKey, flavour: "weather" },
        expiresAt,
      },
      deps.approvals ?? defaultDispatchApprovalDeps,
    );
    await finishRun(admin, runId, { status: "done", approval_id: approval.id, detail: { checked, atRisk: atRisk.length, proposed: included.length, leftAsIs } });
    return { status: "asked", approvalId: approval.id, moves: included.length };
  } catch (err) {
    await finishRun(admin, runId, { status: "failed", detail: { reason: err instanceof Error ? err.message.slice(0, 300) : "error" } });
    throw err;
  }
}

/** Scheduler pass: every company whose check is due. Isolated per company. */
export async function sweepWeather(admin: AdminClient, nowMs: number, companies: DispatchCompany[], deps: WeatherDeps): Promise<void> {
  for (const company of companies) {
    if (!company.settings.weather.enabled || company.settings.weather.sensitive === "none" || !weatherCheckDue(company, nowMs)) continue;
    try {
      await runWeatherCheck(admin, company, nowMs, deps);
    } catch (err) {
      console.error("[dispatcher] weather check failed", company.companyId, err instanceof Error ? err.message : err);
    }
  }
}
