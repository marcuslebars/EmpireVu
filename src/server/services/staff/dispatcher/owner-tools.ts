/**
 * The Dispatcher's owner-by-text tools (run against the ONE company the owner's phone resolved
 * to — state.scope; ids are never taken from the text):
 *   weather_outlook  the next 3 days' forecast and which scheduled jobs are at risk
 *   crew_plan        tomorrow (or a date) by crew member, plus unassigned jobs
 *   move_day         "move all of tomorrow to Friday" → a bulk_reschedule approval (Y moves them
 *                    and texts each customer); nothing moves until the owner's Y
 * Never throw (return { error }).
 */
import type { BusyBooking } from "@/server/services/booking-windows";
import type { RoleOwnerTool } from "@/server/services/staff/types";
import type { ToolRunState } from "@/server/services/owner-channel/tools";
import { BULK_RESCHEDULE_KIND, createDispatchApproval } from "./approvals";
import { loadDispatchCompany, type DispatchCompany } from "./company";
import { crewPlanForDay, shortAddress } from "./crew-schedule";
import { defaultGeocoder, ensureCompanyLocation, type Geocoder } from "./geocode";
import { isOpenJob, jobPhrase, loadJobs, serviceLabels } from "./jobs";
import { buildMoveSummary, type PlannedMove } from "./moves";
import { isWeatherSensitiveJob } from "./settings";
import { loadSlotContext, openSlotsFor } from "./slots";
import { addDays, dayLabel, localDate, localDayRange, shortLabel, timeLabel } from "./time";
import { assessWindow, getCompanyForecast, defaultWeatherProvider, weatherConfigured, type WeatherProvider } from "./weather";

export interface OwnerToolDeps {
  provider(): WeatherProvider;
  geocoder(): Geocoder | null;
}

export const defaultOwnerToolDeps: OwnerToolDeps = {
  provider: () => defaultWeatherProvider(),
  geocoder: () => defaultGeocoder(),
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** "today" / "tomorrow" / "YYYY-MM-DD" → a local date (or null). */
export function resolveDay(value: unknown, nowMs: number, timeZone: string): string | null {
  const v = str(value)?.toLowerCase();
  const today = localDate(new Date(nowMs), timeZone);
  if (!v || v === "tomorrow") return addDays(today, 1);
  if (v === "today") return today;
  return DATE_RE.test(v) ? v : null;
}

async function companyFor(state: ToolRunState): Promise<DispatchCompany | null> {
  return loadDispatchCompany(state.admin, state.scope.organizationId, state.scope.companyId);
}

async function weatherOutlook(state: ToolRunState, deps: OwnerToolDeps): Promise<Record<string, unknown>> {
  const company = await companyFor(state);
  if (!company) return { error: "Business not found." };
  if (!weatherConfigured()) return { ok: false, reason: "Weather checks aren't set up on this account yet." };
  const location = await ensureCompanyLocation(state.admin, company, { geocoder: deps.geocoder(), nowMs: state.nowMs });
  if (!location) return { ok: false, reason: "I don't know where the business is yet (no Google listing or address on file), so I can't check the weather." };
  const forecast = await getCompanyForecast(state.admin, company, location, { provider: deps.provider(), nowMs: state.nowMs });
  if (!forecast) return { ok: false, reason: "The weather service didn't answer - try again in a bit." };
  const today = localDate(new Date(state.nowMs), company.timeZone);
  const range = { from: localDayRange(today, company.timeZone).from, to: localDayRange(addDays(today, 2), company.timeZone).to };
  const jobs = (await loadJobs(state.admin, company, new Date(Math.max(state.nowMs, range.from.getTime())).toISOString(), range.to.toISOString())).filter(isOpenJob);
  const sensitive = company.settings.weather.sensitive;
  const labels = Array.isArray(sensitive) ? await serviceLabels(state.admin, company) : new Map<string, string>();
  const days = [0, 1, 2].map((offset) => {
    const day = addDays(today, offset);
    const { from, to } = localDayRange(day, company.timeZone);
    const daytime = assessWindow(forecast, from.getTime() + 7 * 3_600_000, from.getTime() + 19 * 3_600_000, company.settings.weather.thresholds);
    const onDay = jobs.filter((j) => Date.parse(j.scheduledFor) >= from.getTime() && Date.parse(j.scheduledFor) < to.getTime());
    return {
      day: dayLabel(from, company.timeZone),
      daytime: {
        rain_chance_max: daytime.maxProbability,
        rain_mm: daytime.totalMm,
        wind_kmh_max: daytime.maxWindKmh,
        temp_c: daytime.minTempC !== null ? `${Math.round(daytime.minTempC)} to ${Math.round(daytime.maxTempC ?? daytime.minTempC)}` : null,
        over_your_limits: daytime.reason,
      },
      jobs: onDay.map((j) => {
        const start = Date.parse(j.scheduledFor);
        const risk = assessWindow(forecast, start, start + Math.max(60, j.durationMinutes) * 60_000, company.settings.weather.thresholds);
        const weatherSensitive = isWeatherSensitiveJob(sensitive, { serviceKey: j.serviceKey, title: j.title }, labels);
        return { when: shortLabel(j.scheduledFor, company.timeZone), customer: j.customerName, job: j.title, weather_sensitive: weatherSensitive, at_risk: weatherSensitive && risk.atRisk ? risk.reason : null };
      }),
    };
  });
  return {
    ok: true,
    weather_checks: company.settings.weather.enabled ? `on (daily at ${company.settings.weather.checkAt})` : "off",
    limits: company.settings.weather.thresholds,
    days,
  };
}

async function crewPlan(state: ToolRunState, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const company = await companyFor(state);
  if (!company) return { error: "Business not found." };
  const day = resolveDay(input.date, state.nowMs, company.timeZone);
  if (!day) return { error: "Give the date as YYYY-MM-DD." };
  const plan = await crewPlanForDay(state.admin, company, day);
  const tz = company.timeZone;
  const line = (j: { startsAt: string; customerFirstName: string; title: string; location: string | null }) =>
    [timeLabel(j.startsAt, tz), j.customerFirstName || null, j.title, shortAddress(j.location)].filter(Boolean).join(" - ");
  return {
    ok: true,
    day: dayLabel(localDayRange(day, tz).from, tz),
    crew: plan.members.filter((m) => m.jobs.length > 0).map((m) => ({ member: m.name, cell_on_file: Boolean(m.phone), jobs: m.jobs.map(line) })),
    unassigned: plan.unassigned.map(line),
    crew_texts: company.settings.crewTexts.enabled ? `on - crew get tomorrow's list at ${company.settings.crewTexts.time}` : "off",
  };
}

/**
 * Plan "move everything on <from> to <to>": each job keeps its time of day when that's open on
 * the new day, else takes the next open time that day; jobs that don't fit are left as is.
 */
export async function planDayMove(state: ToolRunState, company: DispatchCompany, fromDay: string, toDay: string): Promise<{ moves: PlannedMove[]; leftAsIs: string[]; total: number }> {
  const tz = company.timeZone;
  const fromRange = localDayRange(fromDay, tz);
  const jobs = (await loadJobs(state.admin, company, new Date(Math.max(state.nowMs, fromRange.from.getTime())).toISOString(), fromRange.to.toISOString())).filter(isOpenJob);
  const slots = await loadSlotContext(state.admin, company, state.nowMs);
  const promised: BusyBooking[] = [];
  const moves: PlannedMove[] = [];
  const leftAsIs: string[] = [];
  const movingIds = jobs.map((j) => j.id);
  for (const job of jobs) {
    const open = openSlotsFor(slots, { id: job.id, durationMinutes: job.durationMinutes, scheduledFor: job.scheduledFor }, state.nowMs, {
      extraBusy: promised,
      excludeIds: movingIds,
    }).filter((t) => t.day === toDay);
    const sameTime = open.find((t) => timeLabel(t.startsAt, tz) === timeLabel(job.scheduledFor, tz) && (t.windowKey ?? null) === (job.windowKey ?? null));
    const pick = sameTime ?? open[0];
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
    });
  }
  return { moves, leftAsIs, total: jobs.length };
}

async function moveDay(state: ToolRunState, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const company = await companyFor(state);
  if (!company) return { error: "Business not found." };
  const tz = company.timeZone;
  const fromDay = resolveDay(input.from_date, state.nowMs, tz);
  const toDay = str(input.to_date) && DATE_RE.test(String(input.to_date)) ? String(input.to_date) : null;
  if (!fromDay || !toDay) return { error: "Give from_date (today, tomorrow or YYYY-MM-DD) and to_date (YYYY-MM-DD)." };
  const today = localDate(new Date(state.nowMs), tz);
  if (toDay < today) return { error: "That day has already passed." };
  if (toDay === fromDay) return { error: "That's the same day." };
  const plan = await planDayMove(state, company, fromDay, toDay);
  const fromLabel = dayLabel(localDayRange(fromDay, tz).from, tz);
  const toLabel = dayLabel(localDayRange(toDay, tz).from, tz);
  if (plan.total === 0) return { ok: false, reason: `Nothing is booked on ${fromLabel}.` };
  if (plan.moves.length === 0) return { ok: false, reason: `No open times on ${toLabel} for ${plan.leftAsIs.join(", ")}.` };
  const headline = `Move ${plan.moves.length} job${plan.moves.length === 1 ? "" : "s"} from ${fromLabel} to ${toLabel}?`;
  const { summary, included } = buildMoveSummary({ flavour: "bulk", headline, moves: plan.moves, leftAsIs: plan.leftAsIs, businessName: company.businessName, timeZone: tz, nowMs: state.nowMs });
  const approval = await createDispatchApproval(state.admin, {
    organizationId: company.organizationId,
    companyId: company.companyId,
    kind: BULK_RESCHEDULE_KIND,
    summary,
    payload: { moves: included, leftAsIs: plan.leftAsIs, fromDay, toDay, flavour: "bulk" },
    expiresAt: new Date(state.nowMs + 12 * 3_600_000),
    askedInlineTo: state.ownerPhone,
  });
  const code = approval.shortCode ?? "?";
  return {
    ok: true,
    nothing_moved_yet: true,
    tell_owner_exactly: `#${code} ${approval.summary} Reply Y ${code} to move them, N ${code} to leave them.`,
  };
}

export function dispatcherOwnerTools(deps: OwnerToolDeps = defaultOwnerToolDeps): RoleOwnerTool[] {
  const guard = (fn: (state: ToolRunState, input: Record<string, unknown>) => Promise<Record<string, unknown>>) => async (state: ToolRunState, input: Record<string, unknown>) => {
    try {
      return await fn(state, input);
    } catch (err) {
      console.error("[dispatcher] owner tool failed:", err instanceof Error ? err.message : err);
      return { error: "That didn't work on our side." };
    }
  };
  return [
    {
      tool: {
        name: "weather_outlook",
        description:
          "The next 3 days' weather for the business (rain chance and amount, wind, temperature) and which scheduled jobs are at risk under the owner's weather limits.",
        input_schema: { type: "object", properties: {} },
      },
      run: guard((state) => weatherOutlook(state, deps)),
    },
    {
      tool: {
        name: "crew_plan",
        description: "Who is on which job for a day (default tomorrow), by crew member, plus jobs nobody is assigned to.",
        input_schema: { type: "object", properties: { date: { type: "string", description: "today, tomorrow or YYYY-MM-DD (local). Default tomorrow." } } },
      },
      run: guard((state, input) => crewPlan(state, input)),
    },
    {
      tool: {
        name: "move_day",
        description:
          "Propose moving every open job on one day to another day (e.g. 'move all of tomorrow to Friday'). Each job keeps its time when it's open, else the next open time that day. Nothing moves until the owner replies Y with the code; on Y each customer is texted their new time.",
        input_schema: {
          type: "object",
          properties: {
            from_date: { type: "string", description: "today, tomorrow or YYYY-MM-DD (local)" },
            to_date: { type: "string", description: "YYYY-MM-DD (local)" },
          },
          required: ["from_date", "to_date"],
        },
      },
      run: guard((state, input) => moveDay(state, input)),
    },
  ];
}
