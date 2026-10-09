import type { Json, Tables } from "@/server/db/database.types";
import type { createSupabaseAdminClient } from "@/server/supabase/admin";
import type { TenantServiceContext } from "@/server/services/shared";
import { deliverMessage, resolveOwnerContacts } from "@/server/services/workflow-engine/messaging";
import { companyTimeZone } from "@/server/services/monthly-scorecard/scorecard";
import { scorecardPlatformBrandName } from "@/server/services/monthly-scorecard/platform-brand";
import {
  isDateKey,
  localDateKey,
  localWallTimeToUtcMs,
  previousWeekKey,
  weekKeyForDate,
  weekKeyInTimeZone,
  weekRangeForKey,
} from "@/server/services/monthly-scorecard/weeks";
import { appBaseUrlFor, brandForOrg, platformBrand, type PlatformBrand } from "@/server/services/platform-brand";
import {
  computeWeekForCompany,
  hadActivityInLast30Days,
  type WeeklyReportMetrics,
} from "@/server/services/weekly-report/metrics";
import { parseWeeklyReportSettings, type WeeklyReportSettings } from "@/server/services/weekly-report/settings";
import { renderWeeklyEmail, renderWeeklySms, type RenderedWeeklyEmail } from "@/server/templates/weekly-report";

/**
 * Weekly "what your front desk did" send pass (docs/front-desk-ai.md → "Weekly report").
 *
 * When: Monday 08:00 company-local, for the Monday–Sunday week that just ended. The scheduler
 * calls `processWeeklyReports` every tick; it is a no-op (no DB reads) except on the UTC days
 * that can be a Monday/Tuesday morning somewhere, and at most every 10 minutes. A company is
 * sent to inside its local send window — Monday 08:00–21:00, with Tuesday 08:00–21:00 as a
 * catch-up day if the worker was down — so nothing goes out at night.
 *
 * Idempotent per (company_id, week_start): `weekly_report_sends` has unique(company_id,
 * week_start); the pass inserts (claims) the row BEFORE sending, so a concurrent or repeated
 * run sends nothing. A `failed` row is re-claimed (conditional update — one winner) by a
 * later pass, at most hourly. A row stuck in `claimed` (worker died mid-send) is left alone
 * rather than risk a double send.
 *
 * Who gets it: SMS (CrankLeads orgs only) from the PLATFORM number to companies.owner_phone_e164;
 * email to the monthly scorecard's owner resolution (companies.owner_email → org owner/admin,
 * never the platform OWNER_EMAIL). Brand = the org's platform brand (never EmpireVu for a
 * CrankLeads org). Owner reporting is transactional — no consent check, no approval gate.
 *
 * Who doesn't: settings off (ai_settings.weekly_report.enabled; default ON for CrankLeads,
 * OFF otherwise), paused/archived companies, cancelled orgs, CrankLeads accounts that weren't
 * live yet (crankleads_purchases.live_at, stamped from the setup checklist's isLive) by the end
 * of the week, and quiet weeks for accounts with no activity at all in the last 30 days. A
 * quiet week after recent activity still gets a short "quiet week" note.
 */

type Admin = ReturnType<typeof createSupabaseAdminClient>;

export type WeeklyRunCompany = Pick<
  Tables<"companies">,
  | "id"
  | "name"
  | "timezone"
  | "created_at"
  | "organization_id"
  | "owner_email"
  | "owner_phone_e164"
  | "brand_primary_color"
  | "stage"
  | "ai_settings"
>;

const RUN_COMPANY_COLUMNS =
  "id, name, timezone, created_at, organization_id, owner_email, owner_phone_e164, brand_primary_color, stage, ai_settings";

export const WEEKLY_SEND_LOCAL_TIME = { hour: 8, minute: 0 };
/** Nothing proactive after 21:00 local (docs/front-desk-ai.md). */
const SEND_WINDOW_END_HOUR = 21;
const FAILED_RETRY_AFTER_MS = 60 * 60_000;
export const WEEKLY_PASS_INTERVAL_MS = 10 * 60_000;

export type WeeklySkipReason =
  | "disabled"
  | "inactive_company"
  | "org_canceled"
  | "not_live"
  | "week_not_over"
  | "outside_send_window"
  | "already_sent"
  | "already_skipped"
  | "retry_later"
  | "no_recipient"
  | "no_activity";

export interface WeeklyRunOutcome {
  companyId: string;
  companyName: string;
  week: string;
  result: "sent" | "failed" | "skipped" | "dry_run";
  reason?: WeeklySkipReason | string;
  channels?: string[];
  emailTo?: string | null;
  smsTo?: string | null;
  subject?: string;
  /** Present on dry runs: the rendered email + SMS for preview. */
  email?: RenderedWeeklyEmail;
  sms?: string | null;
  metrics?: WeeklyReportMetrics;
}

export interface WeeklyRunOptions {
  nowMs?: number;
  /** Any date in the week (normalized to its Monday). Default: last complete week, per company tz. */
  week?: string | null;
  companyId?: string | null;
  dryRun?: boolean;
  /** Re-send a week already sent (CLI; requires companyId). */
  force?: boolean;
  /** Scheduled runs only send inside the company's Monday/Tuesday 08:00–21:00 window. */
  respectSendWindow?: boolean;
}

interface OrgInfo {
  subscriptionStatus: string | null;
  brand: PlatformBrand;
}

/** A purchase row for the company: undefined = none (not a self-serve CrankLeads purchase). */
type LiveState = { liveAt: string | null } | undefined;

function ctxFor(admin: Admin, organizationId: string): TenantServiceContext {
  return { organizationId, actorProfileId: null, supabase: admin };
}

export function weeklyReportUrl(brand: PlatformBrand, week?: string): string {
  return `${appBaseUrlFor(brand)}/reports/weekly${week ? `?week=${week}` : ""}`;
}

/** The week a scheduled run reports on: the last COMPLETE Monday–Sunday week, local time. */
export function defaultReportWeek(timeZone: string, nowMs: number): string {
  return previousWeekKey(weekKeyInTimeZone(timeZone, nowMs));
}

/** Inside Monday or Tuesday, 08:00–21:00 company-local? */
export function isInSendWindow(timeZone: string, nowMs: number): boolean {
  const today = localDateKey(timeZone, nowMs);
  const monday = weekKeyForDate(today);
  const dayIndex = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${monday}T00:00:00Z`)) / 86_400_000);
  if (dayIndex > 1) return false;
  const start = localWallTimeToUtcMs(today, WEEKLY_SEND_LOCAL_TIME.hour, WEEKLY_SEND_LOCAL_TIME.minute, timeZone);
  const end = localWallTimeToUtcMs(today, SEND_WINDOW_END_HOUR, 0, timeZone);
  return nowMs >= start && nowMs < end;
}

/**
 * Cheap gate before any DB read: could it be Monday/Tuesday 08:00–21:00 anywhere (UTC−12 …
 * UTC+14)? That's Sunday 18:00 UTC → Wednesday 09:00 UTC.
 */
export function couldBeSendWindowAnywhere(nowMs: number): boolean {
  const date = new Date(nowMs);
  const minuteOfWeek = ((date.getUTCDay() + 6) % 7) * 1440 + date.getUTCHours() * 60 + date.getUTCMinutes(); // Monday 00:00 = 0
  const sundayEvening = 6 * 1440 + 18 * 60;
  const wednesdayMorning = 2 * 1440 + 9 * 60;
  return minuteOfWeek >= sundayEvening || minuteOfWeek < wednesdayMorning;
}

/** Pre-send eligibility (pure). A skip reason, or null when the company should get one. */
export function weeklySkipReason(input: {
  company: Pick<WeeklyRunCompany, "stage" | "created_at">;
  settings: WeeklyReportSettings;
  orgSubscriptionStatus: string | null;
  live: LiveState;
  week: string;
  timeZone: string;
  nowMs: number;
}): WeeklySkipReason | null {
  if (!input.settings.enabled) return "disabled";
  if (input.company.stage === "paused" || input.company.stage === "archived") return "inactive_company";
  if (input.orgSubscriptionStatus === "canceled") return "org_canceled";
  const range = weekRangeForKey(input.timeZone, input.week);
  const weekEndMs = Date.parse(range.to);
  if (Date.parse(input.company.created_at) >= weekEndMs) return "not_live";
  if (input.live !== undefined && (input.live.liveAt === null || Date.parse(input.live.liveAt) >= weekEndMs)) return "not_live";
  if (input.nowMs < weekEndMs) return "week_not_over";
  return null;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err) return String((err as { message: unknown }).message);
  return String(err);
}

/** Claim (company, week). True when we own the slot and may send. */
async function claimSlot(admin: Admin, company: WeeklyRunCompany, week: string, force: boolean): Promise<boolean> {
  const { error } = await admin.from("weekly_report_sends").insert({
    organization_id: company.organization_id,
    company_id: company.id,
    week_start: week,
    status: "claimed",
  });
  if (!error) return true;
  if (error.code !== "23505") throw error;
  let reclaim = admin
    .from("weekly_report_sends")
    .update({ status: "claimed", last_error: null, updated_at: new Date().toISOString() })
    .eq("organization_id", company.organization_id)
    .eq("company_id", company.id)
    .eq("week_start", week);
  if (!force) reclaim = reclaim.eq("status", "failed");
  const { data, error: reclaimError } = await reclaim.select("id");
  if (reclaimError) throw reclaimError;
  return (data ?? []).length > 0;
}

/** Insert-if-absent skip row (so later passes don't recompute); never downgrades a sent row. */
async function recordSkip(admin: Admin, company: WeeklyRunCompany, week: string, reason: WeeklySkipReason, metrics?: WeeklyReportMetrics) {
  const { error } = await admin.from("weekly_report_sends").insert({
    organization_id: company.organization_id,
    company_id: company.id,
    week_start: week,
    status: "skipped",
    last_error: reason,
    metrics: (metrics ? { ...metrics, skipped: reason } : { skipped: reason }) as unknown as Json,
  });
  if (error && error.code !== "23505") console.error("[weekly-report] could not record skip", company.id, error.message);
}

interface Rendered {
  email: RenderedWeeklyEmail;
  sms: string;
}

function render(company: WeeklyRunCompany, brand: PlatformBrand, metrics: WeeklyReportMetrics): Rendered {
  const options = {
    companyName: company.name,
    platformBrand: scorecardPlatformBrandName(brand),
    reportUrl: weeklyReportUrl(brand, metrics.weekStart),
    primaryColor: company.brand_primary_color,
  };
  return { email: renderWeeklyEmail(metrics, options), sms: renderWeeklySms(metrics, options) };
}

interface Recipients {
  email: string | null;
  phone: string | null;
}

async function resolveRecipients(
  context: TenantServiceContext,
  company: WeeklyRunCompany,
  settings: WeeklyReportSettings,
  isCrankleads: boolean,
): Promise<Recipients> {
  const owner = await resolveOwnerContacts(context, company, { allowPlatformFallback: false });
  return {
    email: settings.channels.includes("email") ? owner.email : null,
    phone: settings.channels.includes("sms") && isCrankleads ? owner.phone : null,
  };
}

/** Send on each channel. Never throws; returns per-channel status. */
async function deliver(
  context: TenantServiceContext,
  company: WeeklyRunCompany,
  brand: PlatformBrand,
  rendered: Rendered,
  to: Recipients,
): Promise<{ sent: string[]; status: Record<string, string>; errors: string[] }> {
  const sent: string[] = [];
  const status: Record<string, string> = {};
  const errors: string[] = [];
  if (to.phone) {
    try {
      const result = await deliverMessage({
        context,
        channel: "sms",
        to: to.phone,
        body: rendered.sms,
        companyId: company.id,
        contactId: null,
        consentContact: null,
        smsFrom: "platform",
      });
      status.sms = result.status;
      if (result.status === "sent") sent.push("sms");
      else errors.push(`sms: ${result.reason ?? result.status}`);
    } catch (err) {
      status.sms = "failed";
      errors.push(`sms: ${errorMessage(err)}`);
    }
  }
  if (to.email) {
    try {
      const result = await deliverMessage({
        context,
        channel: "email",
        to: to.email,
        subject: rendered.email.subject,
        body: rendered.email.text,
        html: rendered.email.html,
        companyId: company.id,
        contactId: null,
        consentContact: null,
        fromName: scorecardPlatformBrandName(brand),
      });
      status.email = result.status;
      if (result.status === "sent") sent.push("email");
      else errors.push(`email: ${result.reason ?? result.status}`);
    } catch (err) {
      status.email = "failed";
      errors.push(`email: ${errorMessage(err)}`);
    }
  }
  return { sent, status, errors };
}

async function processCompany(
  admin: Admin,
  company: WeeklyRunCompany,
  org: OrgInfo,
  live: LiveState,
  existing: { status: string; updated_at: string } | null | undefined,
  options: Required<Pick<WeeklyRunOptions, "nowMs" | "dryRun" | "force" | "respectSendWindow">> & { week: string | null },
): Promise<WeeklyRunOutcome> {
  const timeZone = companyTimeZone(company);
  const week = options.week ?? defaultReportWeek(timeZone, options.nowMs);
  const base = { companyId: company.id, companyName: company.name, week };
  const isCrankleads = org.brand.key === "crankleads";
  const settings = parseWeeklyReportSettings(company.ai_settings, isCrankleads);
  const context = ctxFor(admin, company.organization_id);
  const skip = weeklySkipReason({ company, settings, orgSubscriptionStatus: org.subscriptionStatus, live, week, timeZone, nowMs: options.nowMs });

  if (options.dryRun) {
    const range = weekRangeForKey(timeZone, week);
    const metrics = await computeWeekForCompany(context, company.id, week, range, timeZone);
    const rendered = render(company, org.brand, metrics);
    const to = await resolveRecipients(context, company, settings, isCrankleads);
    return {
      ...base,
      result: "dry_run",
      reason: skip ?? undefined,
      emailTo: to.email,
      smsTo: to.phone,
      subject: rendered.email.subject,
      email: rendered.email,
      sms: rendered.sms,
      metrics,
    };
  }

  if (skip) return { ...base, result: "skipped", reason: skip };
  if (options.respectSendWindow && !isInSendWindow(timeZone, options.nowMs)) {
    return { ...base, result: "skipped", reason: "outside_send_window" };
  }

  // Cheap pre-check (the claim below is the real guard).
  if (!options.force && existing) {
    if (existing.status === "skipped") return { ...base, result: "skipped", reason: "already_skipped" };
    if (existing.status !== "failed") return { ...base, result: "skipped", reason: "already_sent" };
    if (options.respectSendWindow && options.nowMs - Date.parse(existing.updated_at) < FAILED_RETRY_AFTER_MS) {
      return { ...base, result: "skipped", reason: "retry_later" };
    }
  }

  const to = await resolveRecipients(context, company, settings, isCrankleads);
  if (!to.email && !to.phone) {
    console.warn(`[weekly-report] company ${company.id}: no owner email/phone for the chosen channels — skipping`);
    await recordSkip(admin, company, week, "no_recipient");
    return { ...base, result: "skipped", reason: "no_recipient" };
  }

  const range = weekRangeForKey(timeZone, week);
  const metrics = await computeWeekForCompany(context, company.id, week, range, timeZone);
  if (!metrics.hasActivity && !(await hadActivityInLast30Days(context, company.id, options.nowMs))) {
    await recordSkip(admin, company, week, "no_activity", metrics);
    return { ...base, result: "skipped", reason: "no_activity" };
  }

  const rendered = render(company, org.brand, metrics);
  if (!(await claimSlot(admin, company, week, options.force))) {
    return { ...base, result: "skipped", reason: "already_sent" };
  }

  const delivery = await deliver(context, company, org.brand, rendered, to);
  const ok = delivery.sent.length > 0;
  const nowIso = new Date().toISOString();
  const { error: updateError } = await admin
    .from("weekly_report_sends")
    .update({
      status: ok ? "sent" : "failed",
      channels: delivery.sent,
      metrics: { ...metrics, delivery: delivery.status } as unknown as Json,
      sent_at: ok ? nowIso : null,
      last_error: delivery.errors.length > 0 ? delivery.errors.join("; ").slice(0, 500) : null,
      updated_at: nowIso,
    })
    .eq("organization_id", company.organization_id)
    .eq("company_id", company.id)
    .eq("week_start", week);
  if (updateError) console.error("[weekly-report] send log update failed", company.id, updateError.message);

  const outcome = { ...base, channels: delivery.sent, emailTo: to.email, smsTo: to.phone, subject: rendered.email.subject };
  return ok
    ? { ...outcome, result: "sent", reason: delivery.errors.length ? delivery.errors.join("; ") : undefined }
    : { ...outcome, result: "failed", reason: delivery.errors.join("; ") || "failed" };
}

async function loadOrgs(admin: Admin, orgIds: string[]): Promise<Map<string, OrgInfo>> {
  const out = new Map<string, OrgInfo>();
  if (orgIds.length === 0) return out;
  const { data, error } = await admin
    .from("organizations")
    .select("id, subscription_status, platform_brand, crankleads_tier")
    .in("id", orgIds);
  if (error) throw error;
  for (const org of data ?? []) out.set(org.id, { subscriptionStatus: org.subscription_status, brand: brandForOrg(org) });
  return out;
}

async function loadLiveStates(admin: Admin, companyIds: string[]): Promise<Map<string, LiveState>> {
  const out = new Map<string, LiveState>();
  if (companyIds.length === 0) return out;
  const { data, error } = await admin.from("crankleads_purchases").select("company_id, live_at").in("company_id", companyIds);
  if (error) throw error;
  for (const row of (data ?? []) as Array<{ company_id: string | null; live_at: string | null }>) {
    if (!row.company_id) continue;
    const prior = out.get(row.company_id);
    // Several purchases for one company (re-buys): live if any went live.
    if (!prior || (prior.liveAt === null && row.live_at !== null)) out.set(row.company_id, { liveAt: row.live_at });
  }
  return out;
}

/**
 * One pass over every company (or just `companyId`). Never throws for a single company: a
 * per-company failure is logged and returned as `failed`, and the loop continues.
 */
export async function runWeeklyReports(admin: Admin, options: WeeklyRunOptions = {}): Promise<WeeklyRunOutcome[]> {
  const nowMs = options.nowMs ?? Date.now();
  let week: string | null = null;
  if (options.week) {
    if (!isDateKey(options.week)) throw new Error(`Invalid --week "${options.week}" — expected YYYY-MM-DD.`);
    week = weekKeyForDate(options.week);
  }

  let query = admin.from("companies").select(RUN_COMPANY_COLUMNS).order("created_at", { ascending: true });
  if (options.companyId) query = query.eq("id", options.companyId);
  const { data, error } = await query;
  if (error) throw error;
  const companies = (data ?? []) as WeeklyRunCompany[];
  if (options.companyId && companies.length === 0) throw new Error(`Company ${options.companyId} not found.`);

  const orgs = await loadOrgs(admin, [...new Set(companies.map((c) => c.organization_id))]);
  const lives = await loadLiveStates(admin, companies.map((c) => c.id));

  // One batched read of existing send rows for the weeks in play.
  const weekFor = (company: WeeklyRunCompany) => week ?? defaultReportWeek(companyTimeZone(company), nowMs);
  const existing = new Map<string, { status: string; updated_at: string }>();
  if (companies.length > 0 && !options.dryRun) {
    const weeks = [...new Set(companies.map(weekFor))];
    const { data: rows, error: rowsError } = await admin
      .from("weekly_report_sends")
      .select("company_id, week_start, status, updated_at")
      .in("company_id", companies.map((c) => c.id))
      .in("week_start", weeks);
    if (rowsError) throw rowsError;
    for (const row of rows ?? []) existing.set(`${row.company_id}:${row.week_start}`, { status: row.status, updated_at: row.updated_at });
  }

  const outcomes: WeeklyRunOutcome[] = [];
  for (const company of companies) {
    try {
      outcomes.push(
        await processCompany(
          admin,
          company,
          orgs.get(company.organization_id) ?? { subscriptionStatus: null, brand: platformBrand(null) },
          lives.get(company.id),
          existing.get(`${company.id}:${weekFor(company)}`),
          {
            nowMs,
            week,
            dryRun: options.dryRun === true,
            force: options.force === true,
            respectSendWindow: options.respectSendWindow === true,
          },
        ),
      );
    } catch (err) {
      const reason = errorMessage(err);
      console.error("[weekly-report] company failed", company.id, reason);
      outcomes.push({ companyId: company.id, companyName: company.name, week: weekFor(company), result: "failed", reason });
    }
  }
  return outcomes;
}

let lastPassMs = 0;

/** Test hook: forget the in-process throttle. */
export function resetWeeklyReportThrottle(): void {
  lastPassMs = 0;
}

/**
 * Scheduler entry (runScheduler, every tick). No DB work unless it could be Monday/Tuesday
 * morning somewhere, and at most every 10 minutes per process; then a scheduled pass that
 * only sends inside each company's local window. Never throws.
 */
export async function processWeeklyReports(admin: Admin, nowMs: number = Date.now()): Promise<number> {
  if (!couldBeSendWindowAnywhere(nowMs)) return 0;
  if (nowMs - lastPassMs < WEEKLY_PASS_INTERVAL_MS) return 0;
  lastPassMs = nowMs;
  try {
    const outcomes = await runWeeklyReports(admin, { nowMs, respectSendWindow: true });
    const sent = outcomes.filter((o) => o.result === "sent").length;
    const failed = outcomes.filter((o) => o.result === "failed").length;
    if (sent || failed) console.log(`[weekly-report] sent=${sent} failed=${failed}`);
    return sent;
  } catch (err) {
    console.error("[weekly-report] pass failed", errorMessage(err));
    return 0;
  }
}

// ── "Send a test to me" (Settings) ────────────────────────────────────────────

export interface WeeklyTestResult {
  week: string;
  emailTo: string | null;
  smsTo: string | null;
  status: Record<string, string>;
  sent: string[];
  sms: string;
  subject: string;
}

/**
 * Send last week's report now — email to the requesting user, and (CrankLeads, SMS channel
 * on) the text to the owner's cell on file. Ignores the schedule, enabled flag and live gate,
 * and does NOT claim the week, so the real Monday send still goes out. Service-role client;
 * the caller (route) has already checked org admin + company-in-org.
 */
export async function sendTestWeeklyReport(
  admin: Admin,
  input: { organizationId: string; companyId: string; toEmail: string | null; nowMs?: number },
): Promise<WeeklyTestResult> {
  const nowMs = input.nowMs ?? Date.now();
  const { data, error } = await admin
    .from("companies")
    .select(RUN_COMPANY_COLUMNS)
    .eq("organization_id", input.organizationId)
    .eq("id", input.companyId)
    .single();
  if (error) throw error;
  const company = data as WeeklyRunCompany;
  const org = (await loadOrgs(admin, [company.organization_id])).get(company.organization_id) ?? {
    subscriptionStatus: null,
    brand: platformBrand(null),
  };
  const isCrankleads = org.brand.key === "crankleads";
  const settings = parseWeeklyReportSettings(company.ai_settings, isCrankleads);
  const timeZone = companyTimeZone(company);
  const week = defaultReportWeek(timeZone, nowMs);
  const context = ctxFor(admin, company.organization_id);
  const metrics = await computeWeekForCompany(context, company.id, week, weekRangeForKey(timeZone, week), timeZone);
  const rendered = render(company, org.brand, metrics);
  const rendersTest = { ...rendered, email: { ...rendered.email, subject: `[Test] ${rendered.email.subject}` } };
  const to: Recipients = {
    email: input.toEmail?.trim() || null,
    phone: settings.channels.includes("sms") && isCrankleads ? company.owner_phone_e164?.trim() || null : null,
  };
  const delivery = await deliver(context, company, org.brand, rendersTest, to);
  return {
    week,
    emailTo: to.email,
    smsTo: to.phone,
    status: delivery.status,
    sent: delivery.sent,
    sms: rendered.sms,
    subject: rendersTest.email.subject,
  };
}

// ── CLI args (`npm run job:weekly-report -- --dry-run --company <id> --week 2026-10-05`) ──

export interface WeeklyCliArgs {
  dryRun: boolean;
  force: boolean;
  companyId: string | null;
  week: string | null;
}

export function parseWeeklyArgs(argv: string[]): WeeklyCliArgs {
  const args: WeeklyCliArgs = { dryRun: false, force: false, companyId: null, week: null };
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    const [flag, inline] = raw.includes("=") ? [raw.slice(0, raw.indexOf("=")), raw.slice(raw.indexOf("=") + 1)] : [raw, undefined];
    const value = () => {
      if (inline !== undefined) return inline;
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${flag} needs a value.`);
      index += 1;
      return next;
    };
    switch (flag) {
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--force":
        args.force = true;
        break;
      case "--company":
        args.companyId = value().trim();
        break;
      case "--week": {
        const week = value().trim();
        if (!isDateKey(week)) throw new Error(`--week must be YYYY-MM-DD (got "${week}").`);
        args.week = weekKeyForDate(week);
        break;
      }
      default:
        throw new Error(`Unknown argument "${raw}". Use --dry-run, --force, --company <id>, --week YYYY-MM-DD.`);
    }
  }
  if (args.force && !args.companyId) {
    throw new Error("--force re-sends; it requires --company so it can't re-send to every client by accident.");
  }
  return args;
}
