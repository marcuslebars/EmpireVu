import type { Json, Tables } from "@/server/db/database.types";
import type { createSupabaseAdminClient } from "@/server/supabase/admin";
import type { TenantServiceContext } from "@/server/services/shared";
import { assertCompanyInOrganization } from "@/server/services/shared";
import {
  deliverMessage,
  resolveOwnerContacts,
  type MessageChannel,
} from "@/server/services/workflow-engine/messaging";
import { getAttributionSummary, monthRangeInTimeZone } from "@/server/services/attribution";
import { FEATURE_USAGE_KIND, getMonthlyUsage, getUsageForFeature } from "@/server/services/usage";
import { orgLimit } from "@/server/services/billing/gating";
import { localDailySlotUtcMs } from "@/server/services/workflow-engine/timing";
import {
  digestHasActivity,
  renderDigestEmail,
  renderDigestSms,
  type DigestData,
} from "@/server/templates/digest";

/**
 * Owner daily digest (Task 15). Company-scoped: one message per company with digest enabled
 * (no cross-company rollups — Task 15 deliberately keeps it per-company). Runs inside the
 * existing scheduler pass; idempotent per (company_id, local_date) where local_date is the
 * calendar date in the COMPANY's timezone. Owner messages are transactional reporting — they
 * carry no consent check and never require approval.
 */

type Admin = ReturnType<typeof createSupabaseAdminClient>;
const DIGEST_CURRENCY = "CAD";
const VALID_CHANNELS: MessageChannel[] = ["email", "sms"];

function ctxFor(admin: Admin, organizationId: string): TenantServiceContext {
  return { organizationId, actorProfileId: null, supabase: admin };
}

function appBaseUrl(): string {
  return (process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

function fallbackTimeZone(): string {
  return process.env.BUSINESS_TIMEZONE?.trim() || "America/Toronto";
}

// ── Settings ───────────────────────────────────────────────────────────────

export interface DigestSettings {
  enabled: boolean;
  sendAtLocal: string; // "HH:MM", 24h
  channels: MessageChannel[];
  alwaysSend: boolean;
}

export const DEFAULT_DIGEST_SETTINGS: DigestSettings = {
  enabled: false,
  sendAtLocal: "06:30",
  channels: ["email"],
  alwaysSend: false,
};

/** Defensive parse of the companies.digest jsonb blob → typed settings with safe defaults. */
export function parseDigestSettings(raw: Json | null | undefined): DigestSettings {
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const sendAtLocal =
    typeof record.send_at_local === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(record.send_at_local)
      ? record.send_at_local
      : DEFAULT_DIGEST_SETTINGS.sendAtLocal;
  const channels = Array.isArray(record.channels)
    ? VALID_CHANNELS.filter((channel) => (record.channels as unknown[]).includes(channel))
    : DEFAULT_DIGEST_SETTINGS.channels;
  return {
    enabled: record.enabled === true,
    sendAtLocal,
    channels: channels.length > 0 ? channels : DEFAULT_DIGEST_SETTINGS.channels,
    alwaysSend: record.always_send === true,
  };
}

export function serializeDigestSettings(settings: DigestSettings): Json {
  return {
    enabled: settings.enabled,
    send_at_local: settings.sendAtLocal,
    channels: settings.channels,
    always_send: settings.alwaysSend,
  };
}

export interface DigestSettingsInput {
  enabled?: boolean;
  sendAtLocal?: string;
  channels?: MessageChannel[];
  alwaysSend?: boolean;
}

export async function getDigestSettings(
  context: TenantServiceContext,
  companyId: string,
): Promise<DigestSettings> {
  await assertCompanyInOrganization(context, companyId);
  const { data, error } = await context.supabase
    .from("companies")
    .select("digest")
    .eq("organization_id", context.organizationId)
    .eq("id", companyId)
    .single();
  if (error) throw error;
  return parseDigestSettings((data as { digest: Json | null }).digest);
}

/** Merge a partial settings patch onto the stored blob, re-validate, and persist it. */
export async function updateDigestSettings(
  context: TenantServiceContext,
  companyId: string,
  input: DigestSettingsInput,
): Promise<DigestSettings> {
  const current = await getDigestSettings(context, companyId);
  const merged: DigestSettings = parseDigestSettings(
    serializeDigestSettings({
      enabled: input.enabled ?? current.enabled,
      sendAtLocal: input.sendAtLocal ?? current.sendAtLocal,
      channels: input.channels ?? current.channels,
      alwaysSend: input.alwaysSend ?? current.alwaysSend,
    }),
  );
  const { error } = await context.supabase
    .from("companies")
    .update({ digest: serializeDigestSettings(merged), updated_at: new Date().toISOString() })
    .eq("organization_id", context.organizationId)
    .eq("id", companyId);
  if (error) throw error;
  return merged;
}

// ── Local-date / slot helpers ────────────────────────────────────────────────

/** The calendar date (YYYY-MM-DD) in `timeZone` at `nowMs` — the idempotency key's date. */
export function localDateInTimeZone(timeZone: string, nowMs: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(nowMs));
  const map: Record<string, string> = {};
  for (const part of parts) if (part.type !== "literal") map[part.type] = part.value;
  return `${map.year}-${map.month}-${map.day}`;
}

function companyTimeZone(company: Pick<Tables<"companies">, "timezone">): string {
  return company.timezone?.trim() || fallbackTimeZone();
}

// ── Data gathering ───────────────────────────────────────────────────────────

export async function computeDigestData(
  context: TenantServiceContext,
  company: Tables<"companies">,
  nowMs: number,
  timeZone: string,
): Promise<DigestData> {
  const org = context.organizationId;
  const companyId = company.id;
  const sinceIso = new Date(nowMs - 24 * 3_600_000).toISOString();
  const cutoff48hIso = new Date(nowMs - 48 * 3_600_000).toISOString();

  // Today's local-day window (start-of-local-day → +24h) for scheduled bookings.
  const dayStartMs = localDailySlotUtcMs("00:00", timeZone, nowMs);
  const dayEndIso = new Date(dayStartMs + 24 * 3_600_000).toISOString();
  const dayStartIso = new Date(dayStartMs).toISOString();

  // Calls in the last 24h + how many need a callback (voicemail or urgent flag).
  const { data: callRows } = await context.supabase
    .from("retell_calls")
    .select("is_urgent, in_voicemail")
    .eq("organization_id", org)
    .eq("company_id", companyId)
    .gte("created_at", sinceIso)
    .limit(2000);
  const calls = callRows ?? [];
  const callsTotal = calls.length;
  const needsCallback = calls.filter((call) => call.is_urgent === true || call.in_voicemail === true).length;

  const [booked, quotesSent, newLeads, messagesNeedingReply, quotesUnviewed48h, todaysBookings] = await Promise.all([
    context.supabase
      .from("bookings")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", org)
      .eq("company_id", companyId)
      .gte("created_at", sinceIso)
      .then((r) => r.count ?? 0),
    context.supabase
      .from("quotes")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", org)
      .eq("company_id", companyId)
      .gte("sent_at", sinceIso)
      .then((r) => r.count ?? 0),
    context.supabase
      .from("contacts")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", org)
      .eq("company_id", companyId)
      .gte("created_at", sinceIso)
      .then((r) => r.count ?? 0),
    context.supabase
      .from("ui_inbox_v")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", org)
      .eq("company_id", companyId)
      .eq("needs_reply", true)
      .then((r) => r.count ?? 0),
    context.supabase
      .from("quotes")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", org)
      .eq("company_id", companyId)
      .not("sent_at", "is", null)
      .is("first_viewed_at", null)
      .lte("sent_at", cutoff48hIso)
      .then((r) => r.count ?? 0),
    context.supabase
      .from("bookings")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", org)
      .eq("company_id", companyId)
      .gte("scheduled_for", dayStartIso)
      .lt("scheduled_for", dayEndIso)
      .then((r) => r.count ?? 0),
  ]);

  // Usage this month for the company + the org's cap on the one metered feature that has one.
  const usageRows = await getMonthlyUsage(context.supabase, org).catch(() => []);
  const companyUsage = usageRows.filter((row) => row.companyId === companyId);
  const sumKind = (kind: string) => companyUsage.filter((row) => row.kind === kind).reduce((sum, row) => sum + row.quantity, 0);
  const cap = await resolveUsageCap(context, org);

  // Month-so-far attribution (Task 14) — using its own timezone-aware month range.
  const range = monthRangeInTimeZone(timeZone, nowMs);
  const attribution = await getAttributionSummary(context, { companyId, from: range.from, to: range.to }).catch(() => null);

  return {
    companyName: company.name,
    localDate: localDateInTimeZone(timeZone, nowMs),
    calls: { total: callsTotal, booked, quotesSent, needsCallback },
    newLeads,
    messagesNeedingReply,
    quotesUnviewed48h,
    todaysBookings,
    usage: {
      smsSent: sumKind("sms_sent"),
      emailSent: sumKind("email_sent"),
      voiceMinutes: sumKind("voice_minutes"),
      cap,
    },
    attribution: {
      approvedCents: attribution?.approvedCentsTotal ?? 0,
      paidCents: attribution?.paidCentsTotal ?? 0,
      currency: DIGEST_CURRENCY,
    },
  };
}

/** The org's usage-vs-cap for the one capped metered feature (voice preferred, then SMS). */
async function resolveUsageCap(
  context: TenantServiceContext,
  org: string,
): Promise<DigestData["usage"]["cap"]> {
  const features: Array<{ feature: string; label: string }> = [
    { feature: "marina_reception", label: "voice min" },
    { feature: "sms_sequences", label: "SMS" },
  ];
  for (const { feature, label } of features) {
    if (!(feature in FEATURE_USAGE_KIND)) continue;
    const limit = await orgLimit(context.supabase, org, feature).catch(() => null);
    if (limit === null || limit === undefined) continue; // unlimited / internal → no cap line
    const used = await getUsageForFeature(context.supabase, org, feature).catch(() => 0);
    return { feature: label, used, limit };
  }
  return null;
}

// ── Send ─────────────────────────────────────────────────────────────────────

export interface DigestSendOutcome {
  companyId: string;
  sent: boolean;
  quiet: boolean;
  smsStatus: string | null;
  emailStatus: string | null;
  channelsSent: string[];
}

/** Render + deliver on each configured channel. Quiet failures are recorded, never thrown. */
async function renderAndDeliver(
  context: TenantServiceContext,
  company: Tables<"companies">,
  settings: DigestSettings,
  data: DigestData,
): Promise<{ smsStatus: string | null; emailStatus: string | null; channelsSent: string[] }> {
  const owner = await resolveOwnerContacts(context, company);
  const deepLink = `${appBaseUrl()}/inbox`;
  const channelsSent: string[] = [];
  let smsStatus: string | null = null;
  let emailStatus: string | null = null;

  if (settings.channels.includes("email")) {
    if (owner.email) {
      const email = renderDigestEmail(data, {
        deepLink,
        primaryColor: company.brand_primary_color,
        fromName: company.brand_from_name,
      });
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
          fromName: company.brand_from_name,
          replyTo: company.brand_reply_email,
        });
        emailStatus = result.status;
        if (result.status === "sent") channelsSent.push("email");
      } catch (err) {
        emailStatus = "failed";
        console.error("[owner-digest] email send threw", company.id, err instanceof Error ? err.message : err);
      }
    } else {
      emailStatus = "skipped:no_email";
      console.warn(`[owner-digest] company ${company.id}: email channel configured but no owner email — skipping email`);
    }
  }

  if (settings.channels.includes("sms")) {
    if (owner.phone) {
      const sms = renderDigestSms(data, deepLink);
      try {
        const result = await deliverMessage({
          context,
          channel: "sms",
          to: owner.phone,
          body: sms,
          companyId: company.id,
          contactId: null,
          consentContact: null,
        });
        smsStatus = result.status;
        if (result.status === "sent") channelsSent.push("sms");
      } catch (err) {
        smsStatus = "failed";
        console.error("[owner-digest] sms send threw", company.id, err instanceof Error ? err.message : err);
      }
    } else {
      // Decision #5: no phone but sms configured → skip SMS with a logged reason, still send email.
      smsStatus = "skipped:no_phone";
      console.warn(`[owner-digest] company ${company.id}: sms channel configured but no owner phone — skipping SMS, email still sent`);
    }
  }

  return { smsStatus, emailStatus, channelsSent };
}

/**
 * Send a test digest immediately (the "Send me a test digest now" button). Always sends
 * regardless of the schedule or quiet-night gating, and does NOT consume the day's
 * idempotency slot, so the real morning send still fires.
 */
export async function sendTestDigest(
  context: TenantServiceContext,
  companyId: string,
  nowMs: number = Date.now(),
): Promise<DigestSendOutcome> {
  await assertCompanyInOrganization(context, companyId);
  const { data: companyRow, error } = await context.supabase
    .from("companies")
    .select("*")
    .eq("organization_id", context.organizationId)
    .eq("id", companyId)
    .single();
  if (error) throw error;
  const company = companyRow as Tables<"companies">;
  const settings = parseDigestSettings(company.digest);
  // A test respects the configured channels but falls back to email if none chosen yet.
  const effective = settings.channels.length > 0 ? settings : { ...settings, channels: ["email" as MessageChannel] };
  const tz = companyTimeZone(company);
  const data = await computeDigestData(context, company, nowMs, tz);
  const delivered = await renderAndDeliver(context, company, effective, data);
  return {
    companyId,
    sent: delivered.channelsSent.length > 0,
    quiet: !digestHasActivity(data),
    ...delivered,
  };
}

// ── Scheduler entry ──────────────────────────────────────────────────────────

/**
 * One digest pass (called from runScheduler each minute). For every company with digest
 * enabled whose local send time has passed today and which hasn't been sent yet, compute →
 * claim the (company, local_date) slot → send. Never throws (Decision #5): a per-company
 * failure is logged and the loop continues.
 */
export async function processOwnerDigests(admin: Admin, nowMs: number = Date.now()): Promise<number> {
  let sent = 0;
  try {
    const { data, error } = await admin.from("companies").select("*").not("digest", "is", null);
    if (error) throw error;
    const companies = (data ?? []) as Tables<"companies">[];

    for (const company of companies) {
      try {
        const settings = parseDigestSettings(company.digest);
        if (!settings.enabled) continue;

        const tz = companyTimeZone(company);
        const slotMs = localDailySlotUtcMs(settings.sendAtLocal, tz, nowMs);
        if (slotMs > nowMs) continue; // today's local send time hasn't arrived

        const localDate = localDateInTimeZone(tz, nowMs);
        const context = ctxFor(admin, company.organization_id);

        // Cheap pre-check to avoid recomputing every minute once today's digest is handled.
        const { data: existing } = await admin
          .from("owner_digest_sends")
          .select("id")
          .eq("company_id", company.id)
          .eq("local_date", localDate)
          .maybeSingle();
        if (existing) continue;

        const digestData = await computeDigestData(context, company, nowMs, tz);
        const quiet = !digestHasActivity(digestData);

        // Claim the slot (the unique (company_id, local_date) guard makes a concurrent
        // second worker's insert fail → it skips, so we never double-send).
        const { error: claimError } = await admin.from("owner_digest_sends").insert({
          organization_id: company.organization_id,
          company_id: company.id,
          local_date: localDate,
          channels_sent: [],
          detail: {},
        });
        if (claimError) {
          if ((claimError as { code?: string }).code === "23505") continue; // already handled today
          throw claimError;
        }

        if (quiet && !settings.alwaysSend) {
          await admin
            .from("owner_digest_sends")
            .update({ detail: { skipped: "quiet_night" } })
            .eq("company_id", company.id)
            .eq("local_date", localDate);
          continue;
        }

        const delivered = await renderAndDeliver(context, company, settings, digestData);
        await admin
          .from("owner_digest_sends")
          .update({
            channels_sent: delivered.channelsSent,
            sms_status: delivered.smsStatus,
            email_status: delivered.emailStatus,
            detail: { quiet },
          })
          .eq("company_id", company.id)
          .eq("local_date", localDate);
        if (delivered.channelsSent.length > 0) sent += 1;
      } catch (err) {
        console.error("[owner-digest] company failed", company.id, err instanceof Error ? err.message : err);
      }
    }
  } catch (err) {
    console.error("[owner-digest] pass failed", err instanceof Error ? err.message : err);
  }
  return sent;
}
