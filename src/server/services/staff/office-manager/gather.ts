/**
 * Everything the morning briefing says, read for ONE company (every query scoped by
 * organization_id + company_id). Each part is read on its own and is tolerant: a failed read
 * leaves that part out (logged), never the whole briefing.
 *
 *   jobs      today's jobs by crew member (the Dispatcher's crewPlanForDay)
 *   weather   today/tomorrow risk — ONLY when the Dispatcher's weather check is on for the company
 *             (getCompanyForecast + assessWindow on the stored location; never fetched otherwise)
 *   money     collected since the last briefing day, overdue total + count (the Bookkeeper's ar.ts)
 *   fold      the Bookkeeper's 8am alert items not yet told (only when its alert is on)
 *   waiting   pending owner approvals with their codes
 *   since     new leads, quotes sent/approved, texts and calls the AI handled
 */
import { SMS_AGENT_SENDER, type AdminClient } from "@/server/services/front-desk/contracts";
import { addDays, weekdayOf } from "@/server/services/booking-windows";
import { ensureShortCodes, listPendingApprovals } from "@/server/services/owner-channel/approvals";
import { agingSummary, loadOpenInvoicesWithNames } from "@/server/services/staff/bookkeeper/ar";
import { loadCompanyCtx, type CompanyCtx } from "@/server/services/staff/bookkeeper/context";
import { collectAlertEntries, moneyAlertLineGroups, newEntries, type AlertEntry } from "@/server/services/staff/bookkeeper/daily-alert";
import { ownerMoney } from "@/server/services/staff/bookkeeper/format";
import { loadDispatchCompany } from "@/server/services/staff/dispatcher/company";
import { crewPlanForDay, shortAddress, type CrewJob } from "@/server/services/staff/dispatcher/crew-schedule";
import { isOpenJob, loadJobs, serviceLabels } from "@/server/services/staff/dispatcher/jobs";
import { isWeatherSensitiveJob } from "@/server/services/staff/dispatcher/settings";
import { dayLabel, localDate, localDayRange, zonedInstant } from "@/server/services/staff/dispatcher/time";
import { staffBriefingItems } from "./staff-items";
import { assessWindow, defaultWeatherProvider, getCompanyForecast, weatherConfigured, type Forecast, type WeatherProvider } from "@/server/services/staff/dispatcher/weather";
import { clock, type BriefingInput, type JobsPart, type MoneyPart, type SincePart, type WaitingPart, type WeatherDayPart, type WeatherPart } from "./compose";
import type { Db } from "./db-types";
import type { BriefingCompany } from "./settings";

export interface BriefingDeps {
  weatherProvider(): WeatherProvider;
}

export const defaultBriefingDeps: BriefingDeps = {
  weatherProvider: () => defaultWeatherProvider(),
};

/** The longer version (email copy, briefing_now with detail). */
export interface BriefingDetails {
  jobs: string[];
  weather: string[];
  owing: string[];
  waiting: string[];
}

export interface MoneyFold {
  ctx: CompanyCtx;
  entries: AlertEntry[];
  fresh: AlertEntry[];
  groups: Array<{ line: string; entries: AlertEntry[] }>;
}

export type BriefingPartName = "jobs" | "approvals" | "money alert";

export interface GatheredBriefing {
  today: string;
  input: Omit<BriefingInput, "maxSeptets">;
  details: BriefingDetails;
  fold: MoneyFold | null;
  /**
   * Parts whose read FAILED (not "nothing to say"): today's jobs, the approvals waiting, or the
   * Bookkeeper's alert items when that alert is on. The sweep retries rather than send a text
   * that would claim "no jobs" / "nothing waiting", or drop the money items.
   */
  failed: BriefingPartName[];
}

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * What "yesterday" means for this briefing: everything since the previous briefing day (local
 * midnights, DST-safe). Monday after a Saturday briefing covers Saturday and Sunday. PURE.
 */
export function sinceWindow(today: string, days: number[], timeZone: string): { from: Date; to: Date; label: string; phrase: string } {
  let prev = addDays(today, -1);
  let n = 1;
  while (n < 7 && !days.includes(weekdayOf(prev))) {
    prev = addDays(prev, -1);
    n += 1;
  }
  const from = localDayRange(prev, timeZone).from;
  const to = localDayRange(today, timeZone).from;
  if (n === 1) return { from, to, label: "Yesterday", phrase: "yesterday" };
  if (n >= 7) return { from, to, label: "This past week", phrase: "this past week" };
  const name = WEEKDAY_NAMES[weekdayOf(prev)];
  return { from, to, label: `Since ${name}`, phrase: `since ${name}` };
}

async function tolerant<T>(label: string, companyId: string, read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (err) {
    console.error(`[office-manager] briefing ${label} unavailable`, companyId, err instanceof Error ? err.message : err);
    return null;
  }
}

function rowsOf<T>(res: { data: unknown; error: unknown }): T[] {
  if (res.error) throw res.error;
  return (res.data ?? []) as T[];
}

/** A new contact that is a lead: not an imported customer, not a job applicant. PURE. */
export function isNewLead(contact: { consent_source: string | null; metadata?: unknown }): boolean {
  if (contact.consent_source === "import" || contact.consent_source === "job_application") return false;
  const meta = contact.metadata && typeof contact.metadata === "object" ? (contact.metadata as Record<string, unknown>) : {};
  return meta.kind !== "applicant";
}

/** Open invoices the customer import is holding (invoices.import_hold). Tolerant: no column → none. */
async function importHeldIds(db: Db, scope: { organizationId: string; companyId: string }): Promise<Set<string>> {
  try {
    const { data, error } = await db.from("invoices").select("id").eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).eq("import_hold", true).limit(5000);
    if (error) return new Set();
    return new Set(((data ?? []) as Array<{ id: string }>).map((r) => r.id));
  } catch {
    return new Set();
  }
}

function firstWord(name: string): string {
  const base = name.includes("@") ? name.split("@")[0] : name;
  return base.trim().split(/[\s._-]+/)[0] || "Crew";
}

async function jobsPart(admin: AdminClient, company: BriefingCompany, today: string): Promise<{ part: JobsPart; details: string[] }> {
  const plan = await crewPlanForDay(admin, { organizationId: company.organizationId, companyId: company.companyId, timeZone: company.timeZone }, today);
  const all = new Map<string, CrewJob>();
  for (const m of plan.members) for (const j of m.jobs) all.set(j.bookingId, j);
  for (const j of plan.unassigned) all.set(j.bookingId, j);
  const jobs = [...all.values()].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const members = plan.members
    .filter((m) => m.jobs.length > 0)
    .map((m) => ({ first: firstWord(m.name), count: m.jobs.length, jobs: m.jobs }))
    .sort((a, b) => b.count - a.count || a.first.localeCompare(b.first));
  const line = (j: CrewJob) => [clock(j.startsAt, company.timeZone), j.customerFirstName || null, j.title, shortAddress(j.location)].filter(Boolean).join(" - ");
  const details = [
    ...members.map((m) => `${m.first}: ${[...m.jobs].sort((a, b) => a.startsAt.localeCompare(b.startsAt)).map(line).join("; ")}`),
    ...(plan.unassigned.length ? [`Unassigned: ${plan.unassigned.map(line).join("; ")}`] : []),
  ];
  return {
    part: { count: jobs.length, firstStartIso: jobs[0]?.startsAt ?? null, members: members.map(({ first, count }) => ({ first, count })), unassigned: plan.unassigned.length },
    details,
  };
}

/** Today/tomorrow risk. Null when the Dispatcher's weather check is off (no fetch at all). */
async function weatherPart(admin: AdminClient, company: BriefingCompany, today: string, nowMs: number, deps: BriefingDeps): Promise<{ part: WeatherPart; details: string[] } | null> {
  const dispatch = await loadDispatchCompany(admin, company.organizationId, company.companyId);
  if (!dispatch || !dispatch.settings.weather.enabled || !weatherConfigured()) return null;
  // The stored location only (the Dispatcher's 15:00 check geocodes); no location → no weather.
  if (dispatch.latitude === null || dispatch.longitude === null) return null;
  const forecast: Forecast | null = await getCompanyForecast(admin, dispatch, { latitude: dispatch.latitude, longitude: dispatch.longitude }, { provider: deps.weatherProvider(), nowMs });
  if (!forecast) return null;
  const tz = dispatch.timeZone;
  const t = dispatch.settings.weather.thresholds;
  const tomorrow = addDays(today, 1);
  const sensitive = dispatch.settings.weather.sensitive;
  const labels = Array.isArray(sensitive) ? await serviceLabels(admin, dispatch) : new Map<string, string>();
  const fromMs = Math.max(nowMs, localDayRange(today, tz).from.getTime());
  const jobs = (await loadJobs(admin, dispatch, new Date(fromMs).toISOString(), localDayRange(tomorrow, tz).to.toISOString()))
    .filter(isOpenJob)
    .filter((j) => isWeatherSensitiveJob(sensitive, { serviceKey: j.serviceKey, title: j.title }, labels));
  const details: string[] = [];
  const day = (ymd: string, label: string): WeatherDayPart => {
    const range = localDayRange(ymd, tz);
    const start = Math.max(nowMs, zonedInstant(ymd, "07:00", tz).getTime());
    const end = zonedInstant(ymd, "19:00", tz).getTime();
    const daytime = end > start ? assessWindow(forecast, start, end, t) : null;
    const atRisk = jobs.filter((j) => {
      const s = Date.parse(j.scheduledFor);
      if (s < range.from.getTime() || s >= range.to.getTime()) return false;
      return assessWindow(forecast, s, s + Math.max(60, j.durationMinutes) * 60_000, t).atRisk;
    });
    if (daytime?.covered) {
      const bits = [
        daytime.maxProbability !== null ? `rain ${Math.round(daytime.maxProbability)}%${daytime.totalMm !== null ? ` (${daytime.totalMm} mm)` : ""}` : null,
        daytime.maxWindKmh !== null ? `wind up to ${Math.round(daytime.maxWindKmh)} km/h` : null,
        daytime.minTempC !== null ? `${Math.round(daytime.minTempC)} to ${Math.round(daytime.maxTempC ?? daytime.minTempC)}C` : null,
      ].filter(Boolean);
      details.push(`${label}: ${bits.join(", ") || "no forecast detail"}${atRisk.length ? ` - at risk: ${atRisk.map((j) => `${clock(j.scheduledFor, tz)} ${j.customerFirstName || j.customerName} ${j.title}`).join("; ")}` : ""}`);
    }
    return { reason: daytime?.atRisk ? daytime.reason : null, atRiskJobs: atRisk.length };
  };
  return { part: { today: day(today, "Today"), tomorrow: day(tomorrow, "Tomorrow") }, details };
}

async function moneyPart(admin: AdminClient, company: BriefingCompany, today: string, window: { from: Date; to: Date }): Promise<{ part: MoneyPart; details: string[] }> {
  const db = admin as Db;
  const scope = { organizationId: company.organizationId, companyId: company.companyId };
  // Imported balances on hold (not chased until the owner OKs it) aren't counted as overdue.
  const [allOpen, held] = await Promise.all([loadOpenInvoicesWithNames(admin, scope), importHeldIds(db, scope)]);
  const open = allOpen.filter((i) => !held.has(i.id));
  const aging = agingSummary(open, today);
  const from = window.from.toISOString();
  const to = window.to.toISOString();
  const [payments, deposits] = await Promise.all([
    db.from("invoice_payments").select("amount_cents, received_at, status").eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).eq("status", "succeeded").gte("received_at", from).lt("received_at", to).limit(5000),
    db.from("quotes").select("approved_deposit_cents, deposit_paid_at").eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).gte("deposit_paid_at", from).lt("deposit_paid_at", to).limit(5000),
  ]);
  const collected =
    rowsOf<{ amount_cents: number }>(payments).reduce((s, p) => s + (Number(p.amount_cents) || 0), 0) +
    rowsOf<{ approved_deposit_cents: number | null }>(deposits).reduce((s, d) => s + (Number(d.approved_deposit_cents) || 0), 0);
  const details = aging.top
    .filter((l) => l.daysOverdue > 0)
    .map((l) => `${l.customer} ${ownerMoney(l.owingCents)} (${l.invoiceNumber ?? "invoice"}, ${l.daysOverdue} days late)`);
  return { part: { collectedCents: collected, overdueCents: aging.overdueCents, overdueCount: aging.overdueCount }, details };
}

async function foldPart(admin: AdminClient, ctx: CompanyCtx, nowMs: number): Promise<MoneyFold | null> {
  if (!ctx.settings.enabled || !ctx.settings.dailyAlert) return null;
  const { entries, provider } = await collectAlertEntries(admin, ctx, nowMs);
  const fresh = await newEntries(admin, ctx, entries);
  return { ctx, entries, fresh, groups: moneyAlertLineGroups(fresh, provider).map(({ line, entries: e }) => ({ line, entries: e })) };
}

async function waitingPart(admin: AdminClient, company: BriefingCompany, nowMs: number): Promise<{ part: WaitingPart; details: string[] }> {
  await ensureShortCodes(admin, company.companyId).catch(() => undefined);
  const rows = (await listPendingApprovals(admin, [company.companyId])).filter(
    (a) => a.organization_id === company.organizationId && a.kind !== "owner_command" && !(a.expires_at && Date.parse(a.expires_at) <= nowMs),
  );
  const items = rows.map((a) => ({ code: a.short_code ?? null, summary: (a.summary ?? a.kind).replace(/[\s.!?]+$/, "") }));
  return { part: { items, total: items.length }, details: items.map((i) => `${i.code != null ? `#${i.code} ` : ""}${i.summary.replace(/\s+/g, " ").slice(0, 200)}`) };
}

async function sincePart(admin: AdminClient, company: BriefingCompany, window: { from: Date; to: Date; label: string }): Promise<SincePart> {
  const db = admin as Db;
  const org = company.organizationId;
  const co = company.companyId;
  const from = window.from.toISOString();
  const to = window.to.toISOString();
  const count = async <T>(label: string, read: PromiseLike<{ data: unknown; error: unknown }>, keep: (rows: T[]) => number): Promise<number> =>
    (await tolerant(label, co, async () => keep(rowsOf<T>(await read)))) ?? 0;
  const [leads, quotesSent, quotesApproved, textChats, calls] = await Promise.all([
    // New contacts, but not an imported customer list or job applicants (the Recruiter's).
    count<{ consent_source: string | null; metadata: unknown }>(
      "leads",
      db.from("contacts").select("id, consent_source, metadata").eq("organization_id", org).eq("company_id", co).gte("created_at", from).lt("created_at", to).limit(5000),
      (r) => r.filter(isNewLead).length,
    ),
    count("quotes sent", db.from("quotes").select("id").eq("organization_id", org).eq("company_id", co).gte("sent_at", from).lt("sent_at", to).limit(5000), (r) => r.length),
    count("quotes approved", db.from("quotes").select("id").eq("organization_id", org).eq("company_id", co).gte("approved_at", from).lt("approved_at", to).limit(5000), (r) => r.length),
    // Customers the AI texted with (one per contact).
    count<{ contact_id: string | null; id: string }>(
      "ai texts",
      db.from("message_log").select("id, contact_id").eq("organization_id", org).eq("company_id", co).eq("sent_by", SMS_AGENT_SENDER).eq("channel", "sms").eq("direction", "outbound").eq("status", "sent").gte("created_at", from).lt("created_at", to).limit(5000),
      (r) => new Set(r.map((m) => m.contact_id ?? `m:${m.id}`)).size,
    ),
    // Calls the AI answered: inbound, not voicemail, 5 s or more (the weekly report's rule).
    count<{ direction: string | null; duration_ms: number | null; in_voicemail: boolean | null }>(
      "calls",
      db.from("retell_calls").select("id, direction, duration_ms, in_voicemail").eq("organization_id", org).eq("company_id", co).gte("created_at", from).lt("created_at", to).limit(5000),
      (r) => r.filter((c) => c.direction !== "outbound" && c.in_voicemail !== true && !(c.duration_ms !== null && c.duration_ms < 5_000)).length,
    ),
  ]);
  return { label: window.label, leads, quotesSent, quotesApproved, textChats, calls };
}

/**
 * Read the briefing for `company` at `nowMs`. `fold: true` also reads the Bookkeeper's untold
 * alert items (read-only here — the caller marks them reported once the text went out).
 */
export async function gatherBriefing(admin: AdminClient, company: BriefingCompany, nowMs: number, deps: BriefingDeps, options: { fold: boolean }): Promise<GatheredBriefing> {
  const tz = company.timeZone;
  const today = localDate(new Date(nowMs), tz);
  const window = sinceWindow(today, company.settings.days, tz);
  const co = company.companyId;
  const ctx = await tolerant("company", co, () => loadCompanyCtx(admin, company.organizationId, company.companyId));
  const failed: BriefingPartName[] = [];
  // The fold is expected when the Bookkeeper's alert is on; an unreadable company counts as a failure.
  const foldWanted = options.fold && (!ctx || (ctx.settings.enabled && ctx.settings.dailyAlert));
  const [jobs, weather, money, fold, waiting, since, staff] = await Promise.all([
    tolerant("jobs", co, () => jobsPart(admin, company, today)),
    tolerant("weather", co, () => weatherPart(admin, company, today, nowMs, deps)),
    tolerant("money", co, () => moneyPart(admin, company, today, window)),
    foldWanted && ctx ? tolerant("money alert", co, () => foldPart(admin, ctx, nowMs)) : Promise.resolve(null),
    tolerant("approvals", co, () => waitingPart(admin, company, nowMs)),
    tolerant("activity", co, () => sincePart(admin, company, window)),
    tolerant("staff", co, () => staffBriefingItems(admin, { organizationId: company.organizationId, companyId: co, timeZone: tz }, today)),
  ]);
  if (!jobs) failed.push("jobs");
  if (!waiting) failed.push("approvals");
  if (foldWanted && !fold) failed.push("money alert");
  return {
    today,
    input: {
      ownerFirstName: ctx?.ownerFirstName ?? null,
      businessName: company.name,
      dayLabel: dayLabel(zonedInstant(today, "12:00", tz), tz),
      timeZone: tz,
      jobs: jobs?.part ?? null,
      weather: weather?.part ?? null,
      money: money?.part ?? null,
      periodPhrase: window.phrase,
      fold: fold?.groups.map((g) => g.line) ?? [],
      waiting: waiting?.part ?? null,
      since,
      staff: staff ?? [],
      unreadable: { jobs: !jobs, waiting: !waiting },
    },
    details: { jobs: jobs?.details ?? [], weather: weather?.details ?? [], owing: money?.details ?? [], waiting: waiting?.details ?? [] },
    fold,
    failed,
  };
}
