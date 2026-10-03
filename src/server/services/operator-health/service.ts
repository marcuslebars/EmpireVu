// ─────────────────────────────────────────────────────────────────────────────
// SANCTIONED EXCEPTION (service role): daily operator health email — runner.
// Called from the workflow-event worker's scheduler pass (runScheduler) and the
// `npm run job:operator-health` CLI with the service-role client; neither has a user session.
// Cross-tenant by design (operator-only, aggregate, no request input — see ./load.ts). Writes
// only the platform-level operator_health_reports row (counts + subject, no tenant content)
// and emails only OWNER_EMAIL. Listed in docs/EMPIREVU_RUNBOOK.md.
// ─────────────────────────────────────────────────────────────────────────────
import { sendEmail as defaultSendEmail, isEmailSendConfigured, type SendEmailInput, type SendEmailResult } from "@/server/outbound/email";
import { getPastDueGraceDays } from "@/server/services/billing/env";
import type { AdminClient } from "@/server/services/crankleads/purchases";
import { localClock } from "@/server/services/crankleads/followup-schedule";
import { loadOperatorHealthFacts, type LoadFactsInput } from "@/server/services/operator-health/load";
import { renderOperatorHealthEmail, type RenderedOperatorHealthEmail } from "@/server/services/operator-health/render";
import {
  buildOperatorHealthReport,
  decideDelivery,
  isReportDue,
  reportSummary,
  type AllClearMode,
  type Delivery,
  type OperatorHealthFacts,
  type OperatorHealthReport,
} from "@/server/services/operator-health/rules";

/** How often the scheduler looks (it ticks every minute; the report itself is once a day). */
export const OPERATOR_HEALTH_INTERVAL_MS = 5 * 60 * 1000;

const DEFAULT_TIMEZONE = "America/Toronto";

// ── Config ───────────────────────────────────────────────────────────────────

export interface OperatorHealthConfig {
  enabled: boolean;
  /** OWNER_EMAIL. */
  recipient: string | null;
  allClearMode: AllClearMode;
  timeZone: string;
  appBaseUrl: string;
  stripeDashboardBase: string;
  graceDays: number;
}

function validTimeZone(raw: string | undefined): string {
  const zone = raw?.trim();
  if (!zone) return DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

/**
 * OPERATOR_HEALTH_ENABLED: on by default whenever OWNER_EMAIL is set; "false"/"0"/"off"/"no"
 * turns it off. OPERATOR_HEALTH_ALL_CLEAR: "weekly" (default, Monday) or "never".
 * The Stripe dashboard links point at test mode when STRIPE_SECRET_KEY is a test key.
 */
export function readOperatorHealthConfig(env: Record<string, string | undefined> = process.env): OperatorHealthConfig {
  const recipient = env.OWNER_EMAIL?.trim() || null;
  const flag = env.OPERATOR_HEALTH_ENABLED?.trim().toLowerCase() ?? "";
  const switchedOff = ["false", "0", "off", "no"].includes(flag);
  const stripeKey = env.STRIPE_SECRET_KEY?.trim() ?? "";
  return {
    enabled: recipient !== null && !switchedOff,
    recipient,
    allClearMode: env.OPERATOR_HEALTH_ALL_CLEAR?.trim().toLowerCase() === "never" ? "never" : "weekly",
    timeZone: validTimeZone(env.BUSINESS_TIMEZONE),
    appBaseUrl: (env.APP_BASE_URL?.trim() || "http://localhost:3000").replace(/\/+$/, ""),
    stripeDashboardBase: /^(sk|rk)_test_/.test(stripeKey) ? "https://dashboard.stripe.com/test" : "https://dashboard.stripe.com",
    graceDays: getPastDueGraceDays(),
  };
}

// ── Deps ─────────────────────────────────────────────────────────────────────

export interface OperatorHealthDeps {
  sendEmail: (input: SendEmailInput) => Promise<SendEmailResult>;
  isEmailConfigured: () => boolean;
  loadFacts: (admin: AdminClient, input: LoadFactsInput) => Promise<OperatorHealthFacts>;
}

const defaultDeps: OperatorHealthDeps = {
  sendEmail: defaultSendEmail,
  isEmailConfigured: isEmailSendConfigured,
  loadFacts: loadOperatorHealthFacts,
};

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err) return String((err as { message: unknown }).message);
  return String(err);
}

function factsInput(config: OperatorHealthConfig, nowMs: number): LoadFactsInput {
  return {
    nowMs,
    timeZone: config.timeZone,
    appBaseUrl: config.appBaseUrl,
    stripeDashboardBase: config.stripeDashboardBase,
    graceDays: config.graceDays,
  };
}

// ── Scheduled daily run ──────────────────────────────────────────────────────

export type OperatorHealthAction =
  | "disabled"
  | "not_yet"
  | "already_done"
  | "email_not_configured"
  | "claimed_elsewhere"
  | "quiet"
  | "sent"
  | "failed";

export interface OperatorHealthOutcome {
  action: OperatorHealthAction;
  reportDate?: string;
  delivery?: Delivery;
  subject?: string;
  itemCount?: number;
  reason?: string;
}

/** Operator-local date this worker process already finished (saves a DB read every pass). */
let completedDate: string | null = null;
/** Date we already logged "email not configured" for (one log line per day). */
let warnedDate: string | null = null;

/** Tests only: forget the in-process memo. */
export function resetOperatorHealthMemo(): void {
  completedDate = null;
  warnedDate = null;
}

/**
 * One scheduler look (throttled to OPERATOR_HEALTH_INTERVAL_MS by runScheduler). At/after 07:30
 * operator time, once per operator-local day: build the report, CLAIM the day's
 * operator_health_reports row (unique report_date — a second worker, a restart or a re-run gets
 * a unique violation and sends nothing), then send. Never throws.
 */
export async function processOperatorHealth(
  admin: AdminClient,
  nowMs: number = Date.now(),
  depsOverride: Partial<OperatorHealthDeps> = {},
  config: OperatorHealthConfig = readOperatorHealthConfig(),
): Promise<OperatorHealthOutcome> {
  const deps: OperatorHealthDeps = { ...defaultDeps, ...depsOverride };
  try {
    if (!config.enabled || !config.recipient) return { action: "disabled" };
    const clock = localClock(config.timeZone, nowMs);
    const reportDate = clock.date;
    if (!isReportDue(clock)) return { action: "not_yet", reportDate };
    if (completedDate === reportDate) return { action: "already_done", reportDate };

    const { data: existing, error: existingError } = await admin
      .from("operator_health_reports")
      .select("id")
      .eq("report_date", reportDate)
      .maybeSingle();
    if (existingError) throw new Error(`report lookup failed: ${existingError.message}`);
    if (existing) {
      completedDate = reportDate;
      return { action: "already_done", reportDate };
    }

    if (!deps.isEmailConfigured()) {
      if (warnedDate !== reportDate) {
        warnedDate = reportDate;
        console.error("[operator-health] RESEND_API_KEY / OUTBOUND_FROM_EMAIL not set — no daily health email.");
      }
      return { action: "email_not_configured", reportDate };
    }

    const facts = await deps.loadFacts(admin, factsInput(config, nowMs));
    const report = buildOperatorHealthReport(facts);
    const delivery = decideDelivery(report, config.allClearMode, clock.weekday);
    const email = delivery === "quiet" ? null : renderOperatorHealthEmail(report, { allClearMode: config.allClearMode });

    // Claim BEFORE sending.
    const { error: claimError } = await admin.from("operator_health_reports").insert({
      report_date: reportDate,
      status: delivery === "quiet" ? "quiet" : "sending",
      item_count: report.totalItems,
      guarantee_at_risk: report.guaranteeAtRisk,
      all_clear: delivery === "all_clear",
      subject: email?.subject ?? null,
      summary: reportSummary(report),
    });
    if (claimError) {
      if ((claimError as { code?: string }).code === "23505") {
        completedDate = reportDate;
        return { action: "claimed_elsewhere", reportDate };
      }
      throw new Error(`report claim failed: ${claimError.message}`);
    }
    completedDate = reportDate;
    if (!email) return { action: "quiet", reportDate, delivery, itemCount: 0 };

    try {
      await deps.sendEmail({ to: config.recipient, subject: email.subject, body: email.text, html: email.html, fromName: email.fromName });
    } catch (err) {
      const reason = errorMessage(err);
      console.error(`[operator-health] send failed for ${reportDate}: ${reason}`);
      await markReport(admin, reportDate, { status: "failed", error: reason.slice(0, 500) });
      return { action: "failed", reportDate, delivery, subject: email.subject, itemCount: report.totalItems, reason };
    }
    await markReport(admin, reportDate, { status: "sent", sent_at: new Date(nowMs).toISOString() });
    console.log(`[operator-health] ${reportDate} sent: ${email.subject}`);
    return { action: "sent", reportDate, delivery, subject: email.subject, itemCount: report.totalItems };
  } catch (err) {
    const reason = errorMessage(err);
    console.error(`[operator-health] pass failed: ${reason}`);
    return { action: "failed", reason };
  }
}

async function markReport(
  admin: AdminClient,
  reportDate: string,
  patch: { status: "sent" | "failed"; sent_at?: string; error?: string },
): Promise<void> {
  const { error } = await admin.from("operator_health_reports").update(patch).eq("report_date", reportDate);
  if (error) console.error(`[operator-health] status write failed for ${reportDate}: ${error.message}`);
}

// ── CLI (npm run job:operator-health) ────────────────────────────────────────

export interface OperatorHealthJobArgs {
  /** Print the report; never send. Default when no flag is given. */
  dryRun: boolean;
  /** Send now to OWNER_EMAIL regardless of time, day or today's claim (does not claim the day). */
  send: boolean;
  /** No "+N more" caps. */
  all: boolean;
}

export function parseOperatorHealthArgs(argv: string[]): OperatorHealthJobArgs {
  const send = argv.includes("--send");
  return { send, dryRun: !send || argv.includes("--dry-run"), all: argv.includes("--all") };
}

export interface OperatorHealthJobResult {
  report: OperatorHealthReport;
  email: RenderedOperatorHealthEmail;
  /** What the scheduled run would do today with this report. */
  delivery: Delivery;
  sentTo: string | null;
}

/**
 * Build (and with `send`, email) the report right now. `--dry-run` wins over `--send`.
 * The rendered email is returned even when the scheduled run would stay quiet.
 */
export async function runOperatorHealthJob(
  admin: AdminClient,
  args: OperatorHealthJobArgs,
  options: { nowMs?: number; deps?: Partial<OperatorHealthDeps>; config?: OperatorHealthConfig } = {},
): Promise<OperatorHealthJobResult> {
  const deps: OperatorHealthDeps = { ...defaultDeps, ...options.deps };
  const config = options.config ?? readOperatorHealthConfig();
  const nowMs = options.nowMs ?? Date.now();
  const facts = await deps.loadFacts(admin, factsInput(config, nowMs));
  const report = buildOperatorHealthReport(facts, args.all ? { maxItemsPerSection: Number.POSITIVE_INFINITY } : {});
  const delivery = decideDelivery(report, config.allClearMode, localClock(config.timeZone, nowMs).weekday);
  const email = renderOperatorHealthEmail(report, { allClearMode: config.allClearMode });
  if (args.dryRun || !args.send) return { report, email, delivery, sentTo: null };
  if (!config.recipient) throw new Error("OWNER_EMAIL is not set — nowhere to send the report.");
  await deps.sendEmail({ to: config.recipient, subject: email.subject, body: email.text, html: email.html, fromName: email.fromName });
  return { report, email, delivery, sentTo: config.recipient };
}
