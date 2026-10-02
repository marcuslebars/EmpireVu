import type { Json, Tables } from "@/server/db/database.types";
import type { createSupabaseAdminClient } from "@/server/supabase/admin";
import type { TenantServiceContext } from "@/server/services/shared";
import { deliverMessage, resolveOwnerContacts } from "@/server/services/workflow-engine/messaging";
import {
  isMonthKey,
  monthKeyInTimeZone,
  monthKeyToDate,
  monthRangeForKey,
  previousMonthKey,
} from "@/server/services/monthly-scorecard/months";
import { scorecardPlatformBrandName } from "@/server/services/monthly-scorecard/platform-brand";
import {
  buildMonthlyScorecard,
  companyTimeZone,
  parseScorecardSettings,
  type MonthlyScorecard,
} from "@/server/services/monthly-scorecard/scorecard";
import { renderScorecardEmail, type RenderedScorecardEmail } from "@/server/templates/monthly-scorecard";

/**
 * Monthly scorecard send pass (run by src/server/jobs/monthly-scorecard.ts). The job holds a
 * service-role client (sanctioned: jobs), so every read here is explicitly filtered by the
 * company's organization_id + company_id, and the send log row carries both.
 *
 * Idempotent per (company_id, month): `monthly_scorecard_sends` has unique(company_id, month);
 * the pass inserts (claims) the row BEFORE sending, so a second run — or a concurrent one —
 * sends nothing. A row left `failed`/`skipped` is re-claimed by a later run with a
 * conditional update (only one claimer wins). `force` re-sends a month already `sent`.
 *
 * Recipient: companies.owner_email → the org's owner/admin user email. NEVER the global
 * OWNER_EMAIL (that's the platform inbox — a tenant's results must not go there); with no
 * recipient the company is skipped (`no_email`) and logged.
 *
 * Opt-out: companies.monthly_scorecard `{ enabled: false }` (default: enabled). Owner messages
 * are transactional reporting — no consent check, no approval gate (same as the daily digest).
 */

type Admin = ReturnType<typeof createSupabaseAdminClient>;

export type ScorecardRunCompany = Pick<
  Tables<"companies">,
  | "id"
  | "name"
  | "timezone"
  | "created_at"
  | "organization_id"
  | "owner_email"
  | "owner_phone_e164"
  | "brand_primary_color"
  | "monthly_scorecard"
  | "stage"
>;

const RUN_COMPANY_COLUMNS =
  "id, name, timezone, created_at, organization_id, owner_email, owner_phone_e164, brand_primary_color, monthly_scorecard, stage";

export interface ScorecardRunOptions {
  nowMs?: number;
  /** YYYY-MM. Default: the month before `nowMs`, in each company's timezone. */
  month?: string | null;
  companyId?: string | null;
  dryRun?: boolean;
  force?: boolean;
}

export type ScorecardSkipReason =
  | "opted_out"
  | "inactive_company"
  | "org_canceled"
  | "not_started"
  | "month_not_over"
  | "already_sent"
  | "no_email";

export interface ScorecardRunOutcome {
  companyId: string;
  companyName: string;
  month: string;
  result: "sent" | "failed" | "skipped" | "dry_run";
  reason?: ScorecardSkipReason | string;
  recipient?: string | null;
  subject?: string;
  /** Present on dry runs: the full rendered email for preview. */
  email?: RenderedScorecardEmail;
}

function ctxFor(admin: Admin, organizationId: string): TenantServiceContext {
  return { organizationId, actorProfileId: null, supabase: admin };
}

function appBaseUrl(): string {
  return (process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

export function scorecardReportUrl(): string {
  return `${appBaseUrl()}/reports/monthly`;
}

/** The month a scheduled run reports on: the last COMPLETE month in the company's timezone. */
export function defaultScorecardMonth(timeZone: string, nowMs: number): string {
  return previousMonthKey(monthKeyInTimeZone(timeZone, nowMs));
}

/** Pre-send eligibility (pure). Returns a skip reason, or null when the company should get one. */
export function scorecardSkipReason(input: {
  company: Pick<ScorecardRunCompany, "monthly_scorecard" | "stage" | "created_at">;
  orgSubscriptionStatus: string | null;
  month: string;
  timeZone: string;
  nowMs: number;
}): ScorecardSkipReason | null {
  if (!parseScorecardSettings(input.company.monthly_scorecard).enabled) return "opted_out";
  if (input.company.stage === "paused" || input.company.stage === "archived") return "inactive_company";
  if (input.orgSubscriptionStatus === "canceled") return "org_canceled";
  const range = monthRangeForKey(input.timeZone, input.month);
  if (Date.parse(input.company.created_at) >= Date.parse(range.to)) return "not_started";
  if (input.nowMs < Date.parse(range.to)) return "month_not_over";
  return null;
}

function sendDetail(card: MonthlyScorecard, extra: Record<string, Json> = {}): Json {
  return {
    first_month: card.firstMonth,
    leads: card.metrics.leads.total,
    replies_sent: card.metrics.messages.sent,
    jobs_booked: card.metrics.jobsBooked,
    suggestions: card.suggestions.map((s) => s.id),
    has_operator_note: card.operatorNote !== null,
    ...extra,
  };
}

/**
 * Claim the (company, month) slot. Returns the prior send_count when we own the slot, or null
 * when someone else has it (already sent / in flight) and we must not send.
 */
async function claimSlot(
  admin: Admin,
  company: ScorecardRunCompany,
  monthDate: string,
  force: boolean,
): Promise<number | null> {
  const { error } = await admin.from("monthly_scorecard_sends").insert({
    organization_id: company.organization_id,
    company_id: company.id,
    month: monthDate,
    status: "claimed",
  });
  if (!error) return 0;
  if (error.code !== "23505") throw error;

  // A row exists. Re-claim it only from a terminal non-sent state (or anything, with force).
  let reclaim = admin
    .from("monthly_scorecard_sends")
    .update({ status: "claimed", updated_at: new Date().toISOString() })
    .eq("organization_id", company.organization_id)
    .eq("company_id", company.id)
    .eq("month", monthDate);
  if (!force) reclaim = reclaim.in("status", ["failed", "skipped"]);
  const { data, error: reclaimError } = await reclaim.select("send_count");
  if (reclaimError) throw reclaimError;
  const row = (data ?? [])[0];
  return row ? row.send_count : null;
}

async function recordSkip(
  admin: Admin,
  company: ScorecardRunCompany,
  monthDate: string,
  reason: ScorecardSkipReason,
): Promise<void> {
  // Insert-if-absent: never downgrade a row that was already sent.
  const { error } = await admin.from("monthly_scorecard_sends").insert({
    organization_id: company.organization_id,
    company_id: company.id,
    month: monthDate,
    status: "skipped",
    detail: { skipped: reason },
  });
  if (error && error.code !== "23505") {
    console.error("[monthly-scorecard] could not record skip", company.id, error.message);
  }
}

async function processCompany(
  admin: Admin,
  company: ScorecardRunCompany,
  orgSubscriptionStatus: string | null,
  options: Required<Pick<ScorecardRunOptions, "nowMs" | "dryRun" | "force">> & { month: string | null },
): Promise<ScorecardRunOutcome> {
  const timeZone = companyTimeZone(company);
  const month = options.month ?? defaultScorecardMonth(timeZone, options.nowMs);
  const monthDate = monthKeyToDate(month);
  const base = { companyId: company.id, companyName: company.name, month };
  const context = ctxFor(admin, company.organization_id);

  const skip = scorecardSkipReason({ company, orgSubscriptionStatus, month, timeZone, nowMs: options.nowMs });

  if (options.dryRun) {
    // Preview: compute + render regardless, report what a real run would do. Writes nothing.
    const card = await buildMonthlyScorecard(context, company, month, options.nowMs);
    const email = renderScorecardEmail(card, {
      platformBrand: scorecardPlatformBrandName(),
      reportUrl: scorecardReportUrl(),
      primaryColor: company.brand_primary_color,
    });
    const owner = await resolveOwnerContacts(context, company, { allowPlatformFallback: false });
    return { ...base, result: "dry_run", reason: skip ?? undefined, recipient: owner.email, subject: email.subject, email };
  }

  if (skip) {
    if (skip === "opted_out") await recordSkip(admin, company, monthDate, skip);
    return { ...base, result: "skipped", reason: skip };
  }

  // Cheap pre-check so a re-run doesn't recompute every company that's already done.
  if (!options.force) {
    const { data: existing } = await admin
      .from("monthly_scorecard_sends")
      .select("status")
      .eq("organization_id", company.organization_id)
      .eq("company_id", company.id)
      .eq("month", monthDate)
      .maybeSingle();
    if (existing && (existing.status === "sent" || existing.status === "claimed")) {
      return { ...base, result: "skipped", reason: "already_sent" };
    }
  }

  const owner = await resolveOwnerContacts(context, company, { allowPlatformFallback: false });
  if (!owner.email) {
    console.warn(`[monthly-scorecard] company ${company.id}: no owner email — skipping`);
    await recordSkip(admin, company, monthDate, "no_email");
    return { ...base, result: "skipped", reason: "no_email" };
  }

  const card = await buildMonthlyScorecard(context, company, month, options.nowMs);
  const email = renderScorecardEmail(card, {
    platformBrand: scorecardPlatformBrandName(),
    reportUrl: scorecardReportUrl(),
    primaryColor: company.brand_primary_color,
  });

  const priorCount = await claimSlot(admin, company, monthDate, options.force);
  if (priorCount === null) return { ...base, result: "skipped", reason: "already_sent" };

  let emailStatus: string;
  let failure: string | null = null;
  try {
    const result = await deliverMessage({
      context,
      channel: "email",
      to: owner.email,
      subject: email.subject,
      body: email.text,
      html: email.html,
      companyId: company.id,
      contactId: null,
      consentContact: null,
      fromName: scorecardPlatformBrandName(),
    });
    emailStatus = result.status;
    if (result.status !== "sent") failure = result.reason ?? result.status;
  } catch (err) {
    emailStatus = "failed";
    failure = err instanceof Error ? err.message : String(err);
  }

  const sent = emailStatus === "sent";
  const nowIso = new Date().toISOString();
  const { error: updateError } = await admin
    .from("monthly_scorecard_sends")
    .update({
      status: sent ? "sent" : "failed",
      email_status: emailStatus,
      recipient: owner.email,
      subject: email.subject,
      send_count: priorCount + (sent ? 1 : 0),
      sent_at: sent ? nowIso : null,
      detail: sendDetail(card, failure ? { error: failure } : {}),
      updated_at: nowIso,
    })
    .eq("organization_id", company.organization_id)
    .eq("company_id", company.id)
    .eq("month", monthDate);
  if (updateError) {
    console.error("[monthly-scorecard] send log update failed", company.id, updateError.message);
  }

  return sent
    ? { ...base, result: "sent", recipient: owner.email, subject: email.subject }
    : { ...base, result: "failed", reason: failure ?? "failed", recipient: owner.email, subject: email.subject };
}

/**
 * One pass over every company (or just `companyId`). Never throws for a single company:
 * a per-company failure is logged and returned as `failed`, and the loop continues.
 */
export async function runMonthlyScorecards(admin: Admin, options: ScorecardRunOptions = {}): Promise<ScorecardRunOutcome[]> {
  const nowMs = options.nowMs ?? Date.now();
  if (options.month && !isMonthKey(options.month)) {
    throw new Error(`Invalid --month "${options.month}" — expected YYYY-MM.`);
  }

  let query = admin.from("companies").select(RUN_COMPANY_COLUMNS).order("created_at", { ascending: true });
  if (options.companyId) query = query.eq("id", options.companyId);
  const { data: companies, error } = await query;
  if (error) throw error;
  if (options.companyId && (companies ?? []).length === 0) {
    throw new Error(`Company ${options.companyId} not found.`);
  }

  const orgIds = [...new Set((companies ?? []).map((company) => company.organization_id))];
  const orgStatus = new Map<string, string>();
  if (orgIds.length > 0) {
    const { data: orgs, error: orgError } = await admin
      .from("organizations")
      .select("id, subscription_status")
      .in("id", orgIds);
    if (orgError) throw orgError;
    for (const org of orgs ?? []) orgStatus.set(org.id, org.subscription_status);
  }

  const outcomes: ScorecardRunOutcome[] = [];
  for (const company of companies ?? []) {
    try {
      outcomes.push(
        await processCompany(admin, company, orgStatus.get(company.organization_id) ?? null, {
          nowMs,
          month: options.month ?? null,
          dryRun: options.dryRun === true,
          force: options.force === true,
        }),
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error("[monthly-scorecard] company failed", company.id, reason);
      outcomes.push({
        companyId: company.id,
        companyName: company.name,
        month: options.month ?? defaultScorecardMonth(companyTimeZone(company), nowMs),
        result: "failed",
        reason,
      });
    }
  }
  return outcomes;
}

// ── CLI args (PowerShell-friendly: `npm run job:monthly-scorecard -- --dry-run --company <id> --month 2026-09`) ──

export interface ScorecardCliArgs {
  dryRun: boolean;
  force: boolean;
  companyId: string | null;
  month: string | null;
}

export function parseScorecardArgs(argv: string[]): ScorecardCliArgs {
  const args: ScorecardCliArgs = { dryRun: false, force: false, companyId: null, month: null };
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
      case "--month": {
        const month = value().trim();
        if (!isMonthKey(month)) throw new Error(`--month must be YYYY-MM (got "${month}").`);
        args.month = month;
        break;
      }
      default:
        throw new Error(`Unknown argument "${raw}". Use --dry-run, --force, --company <id>, --month YYYY-MM.`);
    }
  }
  if (args.force && !args.companyId) {
    throw new Error("--force re-sends; it requires --company so it can't re-send to every client by accident.");
  }
  return args;
}
