/**
 * Win-back campaigns (docs/ai-staff.md → "Marketer"):
 *
 *   draft    → only with the company's own texting number and a way to reach the business (CASL
 *              contact info). The audience is built (audience.ts, one per phone number) and
 *              snapshotted as `queued` recipients, Claude writes the text (ai.ts), and ONE owner
 *              approval (kind marketing_campaign) shows the exact text, the audience count and the
 *              send window. One active campaign per company (partial unique index).
 *   Y        → status 'sending'; the sender sweep texts queued recipients from the company number,
 *              throttled (per hour incl. in-flight claims + weekly cap, one batch per campaign per
 *              5-minute slot), only inside the send window (Mon–Sat 10–19 local by default, always
 *              within 09:00–20:00). Each recipient is claimed (queued → sending) before its text;
 *              a claim left hanging by a crash is failed, never retried.
 *   hold     → owner paused all texts, company paused/archived, win-back turned off, or no company
 *              number: nothing goes out. Held for more than 3 days → cancelled, and the owner told.
 *   N/expiry/stop → cancelled; queued recipients skipped (they don't count against the cooldown).
 *
 * Every text names the business, carries contact info and ends with the STOP line.
 * Replies come back to the company number and the SMS agent answers them as usual.
 */
import type { AdminClient, ApprovalDecision, ExecuteResult, OwnerApprovalRow } from "@/server/services/front-desk/contracts";
import { ctxFor } from "@/server/services/owner-channel/common";
import { draftWinBackBody, loadBusinessBrief } from "@/server/services/staff/marketer/ai";
import { buildWinBackAudience, EXCLUSION_LABELS, greetingName, latestPurchases, recipientBlocker, type ExclusionReason } from "@/server/services/staff/marketer/audience";
import type { CampaignRecipientRow, Db, MarketingCampaignRow, SendWindow } from "@/server/services/staff/marketer/db-types";
import { createMarketerApproval, isUniqueViolation, reaskWithoutNote, textOwner, type MarketerDeps } from "@/server/services/staff/marketer/deps";
import { countRows, pageAll } from "@/server/services/staff/marketer/paging";
import { isCompanyHeld, listMarketingCompanies, loadMarketingCompany, MARKETING_DEFAULTS, sendWindowOf, type MarketingCompany } from "@/server/services/staff/marketer/settings";
import { describeWindow, inProactiveHours, inSendWindow, localParts } from "@/server/services/staff/marketer/time";
import { deliverMessage, resolveCompanySmsFrom, STOP_FOOTER } from "@/server/services/workflow-engine/messaging";

export const MARKETING_CAMPAIGN_KIND = "marketing_campaign";
export const MARKETER_SENDER = "marketer";
export const CAMPAIGN_APPROVAL_TTL_MS = 48 * 3_600_000;
/** A recipient claimed this long ago and never finished is failed (never re-sent). */
const STALE_CLAIM_MS = 30 * 60_000;
/** A 'draft' row older than this is a crashed draft: cancelled, its rows released. */
const STALE_DRAFT_MS = 3_600_000;
/** A campaign held (paused / turned off / no number) longer than this is cancelled. */
export const MAX_HOLD_MS = 3 * 86_400_000;
/** One batch per campaign per slot (all workers together). */
const SEND_SLOT_MS = 5 * 60_000;
/** Results window: bookings / quotes / replies from a recipient within this long of their text. */
export const RESULTS_WINDOW_DAYS = 30;
/** Placeholder in the stored template, replaced per recipient. The owner sees it as-is. */
export const FIRST_NAME_SLOT = "[first name]";
export const ACTIVE_STATUSES = ["draft", "awaiting_owner", "approved", "sending"];
/** Don't auto-draft within this long of the company's last campaign (e.g. one the owner started). */
const MIN_DAYS_BETWEEN_CAMPAIGNS = 21;

type Held = MarketingCampaignRow & { held_since?: string | null; hold_reason?: string | null; hold_notified_at?: string | null };

/** Throw a PostgREST error (follow-up writes must not fail silently). */
function must<T extends { error: unknown }>(result: T): T {
  if (result.error) throw result.error;
  return result;
}

// ── Text ──────────────────────────────────────────────────────────────────────

/** "Info: https://…" for a link, "Or call 705-555-0111." for a phone. PURE. */
export function contactText(contact: string): string {
  return /^(https?:\/\/|www\.)/i.test(contact) ? `Info: ${contact}` : `Or call ${contact}.`;
}

/** The stored template: greeting slot + body + optional booking link + contact info + STOP line. PURE. */
export function composeCampaignTemplate(body: string, links: { bookingUrl: string | null; contact: string }): string {
  const booking = links.bookingUrl ? ` Book online: ${links.bookingUrl}` : "";
  return `Hi ${FIRST_NAME_SLOT}, ${body.trim()}${booking} ${contactText(links.contact)}\n${STOP_FOOTER}`;
}

/** One recipient's text. PURE. */
export function personalise(template: string, firstName: string | null): string {
  const name = greetingName(firstName);
  return template.split(FIRST_NAME_SLOT).join(name ?? "there");
}

export function campaignSummary(input: { audienceCount: number; monthsMin: number; monthsMax: number; template: string; window: SendWindow }): string {
  const who = `${input.audienceCount} past customer${input.audienceCount === 1 ? "" : "s"}`;
  const text = `"${input.template.replace(/\n/g, " ")}"`;
  const when = `Sends ${describeWindow(input.window)}.`;
  const full = `Win-back text to ${who} (last job ${input.monthsMin}-${input.monthsMax} months ago): ${text} ${when}`;
  if (full.length <= 500) return full;
  return `Win-back text to ${who}: ${text} ${when}`;
}

// ── Drafting ──────────────────────────────────────────────────────────────────

export type DraftOutcome =
  | { status: "created"; campaignId: string; approvalId: string; shortCode: number | null; audienceCount: number; summary: string }
  | { status: "no_audience"; campaignId: string; excluded: Partial<Record<ExclusionReason, number>>; inWindow: number }
  | { status: "busy"; campaignId: string; campaignStatus: string }
  | { status: "no_number" }
  | { status: "no_contact_info" }
  | { status: "paused" }
  | { status: "already" }
  | { status: "disabled" };

async function activeCampaign(db: Db, scope: { organizationId: string; companyId: string }): Promise<MarketingCampaignRow | null> {
  const { data, error } = await db
    .from("marketing_campaigns")
    .select("*")
    .eq("organization_id", scope.organizationId)
    .eq("company_id", scope.companyId)
    .in("status", ACTIVE_STATUSES)
    .order("created_at", { ascending: false })
    .limit(5);
  if (error) throw error;
  return ((data ?? []) as MarketingCampaignRow[])[0] ?? null;
}

async function skipQueued(db: Db, campaign: Pick<MarketingCampaignRow, "id" | "organization_id">, reason: string): Promise<void> {
  must(
    await db
      .from("marketing_campaign_recipients")
      .update({ status: "skipped", reason, updated_at: new Date().toISOString() })
      .eq("campaign_id", campaign.id)
      .eq("organization_id", campaign.organization_id)
      .eq("status", "queued"),
  );
}

/** Cancel crashed drafts (older than an hour) — for one company, or everywhere. Their rows are released. */
export async function cancelStaleDrafts(db: Db, nowMs: number, scope?: { organizationId: string; companyId: string }): Promise<number> {
  let q = db.from("marketing_campaigns").select("id, organization_id").eq("status", "draft").lt("created_at", new Date(nowMs - STALE_DRAFT_MS).toISOString());
  if (scope) q = q.eq("organization_id", scope.organizationId).eq("company_id", scope.companyId);
  const { data, error } = await q.limit(100);
  if (error) throw error;
  let n = 0;
  for (const row of (data ?? []) as Array<Pick<MarketingCampaignRow, "id" | "organization_id">>) {
    const { data: done } = must(
      await db
        .from("marketing_campaigns")
        .update({ status: "cancelled", cancel_reason: "draft_interrupted", updated_at: new Date(nowMs).toISOString() })
        .eq("id", row.id)
        .eq("organization_id", row.organization_id)
        .eq("status", "draft")
        .select("id"),
    );
    if (((done ?? []) as unknown[]).length === 0) continue;
    await skipQueued(db, row, "draft_interrupted");
    n++;
  }
  return n;
}

/** The company's own texting number (null → no campaign: the platform default number is another business's). */
export async function companySmsNumber(admin: AdminClient, scope: { organizationId: string; companyId: string }): Promise<string | null> {
  return resolveCompanySmsFrom(ctxFor(admin, scope.organizationId), scope.companyId);
}

/**
 * Draft a win-back campaign for one company and ask the owner. `periodKey` ('2026-10') makes the
 * automatic monthly draft once-per-month (unique index); owner-started drafts pass null.
 */
export async function draftWinBackCampaign(
  admin: AdminClient,
  deps: MarketerDeps,
  company: MarketingCompany,
  options: { createdBy: "marketer" | "owner"; periodKey: string | null; urgent?: boolean; force?: boolean },
): Promise<DraftOutcome> {
  const db = admin as Db;
  const nowMs = deps.now();
  const settings = company.settings.winBack;
  const scope = { organizationId: company.organizationId, companyId: company.companyId };
  if (!settings.enabled && !options.force) return { status: "disabled" };
  if (isCompanyHeld(company)) return { status: "paused" };
  await cancelStaleDrafts(db, nowMs, scope);
  const active = await activeCampaign(db, scope);
  if (active) return { status: "busy", campaignId: active.id, campaignStatus: active.status };
  if (!(await companySmsNumber(admin, scope))) return { status: "no_number" };
  const brief = await loadBusinessBrief(admin, company);
  if (!brief.contact) return { status: "no_contact_info" };

  const window = sendWindowOf(company.settings);
  const nowIso = new Date(nowMs).toISOString();
  const { data: inserted, error: insertError } = await db
    .from("marketing_campaigns")
    .insert({
      organization_id: company.organizationId,
      company_id: company.companyId,
      kind: "win_back",
      status: "draft",
      period_key: options.periodKey,
      created_by: options.createdBy,
      send_window: window,
      audience_filter: { monthsMin: settings.monthsMin, monthsMax: settings.monthsMax },
      created_at: nowIso,
      updated_at: nowIso,
    })
    .select("*")
    .single();
  if (insertError) {
    if (isUniqueViolation(insertError)) {
      // Another worker won (the monthly period, or the one-active-campaign index).
      const raced = await activeCampaign(db, scope);
      return raced ? { status: "busy", campaignId: raced.id, campaignStatus: raced.status } : { status: "already" };
    }
    throw insertError;
  }
  const campaign = inserted as MarketingCampaignRow;

  try {
    const audience = await buildWinBackAudience(admin, scope, settings, nowMs, { limit: settings.weeklyCap * 4 });
    const filter = { monthsMin: settings.monthsMin, monthsMax: settings.monthsMax, inWindow: audience.inWindow, excluded: audience.excluded };
    if (audience.members.length === 0) {
      must(
        await db
          .from("marketing_campaigns")
          .update({ status: "cancelled", cancel_reason: "no_audience", audience_filter: filter, updated_at: nowIso })
          .eq("id", campaign.id)
          .eq("organization_id", company.organizationId),
      );
      return { status: "no_audience", campaignId: campaign.id, excluded: audience.excluded, inWindow: audience.inWindow };
    }

    const month = Number.parseInt(localParts(nowMs, company.timeZone).month.slice(5, 7), 10);
    const drafted = await draftWinBackBody(deps.model, brief, { ...scope, month });
    const template = composeCampaignTemplate(drafted.body, { bookingUrl: brief.bookingUrl, contact: brief.contact });

    for (let i = 0; i < audience.members.length; i += 200) {
      must(
        await db.from("marketing_campaign_recipients").insert(
          audience.members.slice(i, i + 200).map((m) => ({
            organization_id: company.organizationId,
            company_id: company.companyId,
            campaign_id: campaign.id,
            contact_id: m.contactId,
            status: "queued",
            last_purchase_at: m.lastPurchaseAt,
            created_at: nowIso,
            updated_at: nowIso,
          })),
        ),
      );
    }

    const summary = campaignSummary({ audienceCount: audience.members.length, monthsMin: settings.monthsMin, monthsMax: settings.monthsMax, template, window });
    const approval = await createMarketerApproval(admin, deps, {
      ...scope,
      kind: MARKETING_CAMPAIGN_KIND,
      summary,
      payload: { campaignId: campaign.id, audienceCount: audience.members.length, ...(options.urgent ? { urgent: true } : {}) },
      ttlMs: CAMPAIGN_APPROVAL_TTL_MS,
    });
    must(
      await db
        .from("marketing_campaigns")
        .update({
          status: "awaiting_owner",
          message: template,
          audience_count: audience.members.length,
          audience_filter: { ...filter, draftedBy: drafted.source },
          approval_id: approval.id,
          updated_at: nowIso,
        })
        .eq("id", campaign.id)
        .eq("organization_id", company.organizationId),
    );
    return { status: "created", campaignId: campaign.id, approvalId: approval.id, shortCode: approval.short_code, audienceCount: audience.members.length, summary };
  } catch (err) {
    await db
      .from("marketing_campaigns")
      .update({ status: "cancelled", cancel_reason: `draft_failed: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`, updated_at: nowIso })
      .eq("id", campaign.id)
      .eq("organization_id", company.organizationId);
    await skipQueued(db, campaign, "draft_failed").catch(() => undefined);
    throw err;
  }
}

/** Once per company per month: tell the owner why the automatic draft couldn't happen. */
async function tellOwnerBlocked(admin: AdminClient, company: MarketingCompany, month: string, status: "no_number" | "no_contact_info"): Promise<void> {
  const { error } = await (admin as Db).from("marketing_sweep_claims").insert({ company_id: company.companyId, task: "winback_blocked", period_key: month, created_at: new Date().toISOString() });
  if (error) return; // already told this month (or the claim failed — don't risk repeats)
  const why =
    status === "no_number"
      ? "this business doesn't have its own texting number yet"
      : "there's no website or business phone on file to include (texts to past customers must say how to reach you)";
  await textOwner(admin, { organizationId: company.organizationId, companyId: company.companyId }, `I couldn't draft this month's win-back texts for ${company.businessName}: ${why}. Add it in Settings and I'll try again.`);
}

/** Scheduler: the automatic monthly draft (local daytime, once per company per month). */
export async function sweepMonthlyWinBack(admin: AdminClient, deps: MarketerDeps, companies?: MarketingCompany[]): Promise<{ drafted: number }> {
  const db = admin as Db;
  const nowMs = deps.now();
  let drafted = 0;
  for (const company of companies ?? (await listMarketingCompanies(admin))) {
    if (!company.settings.winBack.enabled || isCompanyHeld(company)) continue;
    const local = localParts(nowMs, company.timeZone);
    if (local.hour < 10 || local.hour >= 16 || !company.settings.winBack.days.includes(local.weekday)) continue;
    try {
      const { data: recent, error } = await db
        .from("marketing_campaigns")
        .select("id, period_key, created_at, status, cancel_reason")
        .eq("organization_id", company.organizationId)
        .eq("company_id", company.companyId)
        .order("created_at", { ascending: false })
        .limit(10);
      if (error) throw error;
      const rows = (recent ?? []) as Array<Pick<MarketingCampaignRow, "id" | "period_key" | "created_at" | "status" | "cancel_reason">>;
      if (rows.some((r) => r.period_key === local.month)) continue;
      const last = rows.find((r) => r.status !== "cancelled" || r.cancel_reason !== "no_audience");
      if (last && nowMs - Date.parse(last.created_at) < MIN_DAYS_BETWEEN_CAMPAIGNS * 86_400_000) continue;
      const out = await draftWinBackCampaign(admin, deps, company, { createdBy: "marketer", periodKey: local.month });
      if (out.status === "created") drafted++;
      if (out.status === "no_number" || out.status === "no_contact_info") await tellOwnerBlocked(admin, company, local.month, out.status);
    } catch (err) {
      console.error("[marketer] monthly win-back draft failed", company.companyId, err instanceof Error ? err.message : err);
    }
  }
  return { drafted };
}

// ── Stopping ──────────────────────────────────────────────────────────────────

/**
 * Stop the company's active campaign (owner's "stop the campaign", the Settings button, or a
 * hold that lasted too long): cancelled, queued recipients skipped, a pending approval
 * superseded. Texts already sent stay sent.
 */
export async function cancelActiveCampaign(
  admin: AdminClient,
  scope: { organizationId: string; companyId: string },
  reason: string,
  nowMs: number,
): Promise<{ cancelled: boolean; sent: number; queued: number; campaignId: string | null }> {
  const db = admin as Db;
  const campaign = await activeCampaign(db, scope);
  if (!campaign) return { cancelled: false, sent: 0, queued: 0, campaignId: null };
  const { data } = must(
    await db
      .from("marketing_campaigns")
      .update({ status: "cancelled", cancel_reason: reason, updated_at: new Date(nowMs).toISOString() })
      .eq("id", campaign.id)
      .eq("organization_id", scope.organizationId)
      .eq("company_id", scope.companyId)
      .in("status", ACTIVE_STATUSES)
      .select("id"),
  );
  if (((data ?? []) as unknown[]).length === 0) return { cancelled: false, sent: 0, queued: 0, campaignId: campaign.id };
  const queued = await countRows(() => db.from("marketing_campaign_recipients").select("id", { count: "exact", head: true }).eq("organization_id", scope.organizationId).eq("campaign_id", campaign.id).eq("status", "queued"));
  await skipQueued(db, campaign, reason);
  if (campaign.approval_id) {
    must(await db.from("owner_approvals").update({ status: "superseded" }).eq("id", campaign.approval_id).eq("organization_id", scope.organizationId).eq("status", "pending"));
  }
  const counts = await refreshCounts(db, { ...campaign, status: "cancelled" }, new Date(nowMs).toISOString(), true);
  return { cancelled: true, sent: counts.sent, queued, campaignId: campaign.id };
}

// ── The owner's decision ──────────────────────────────────────────────────────

async function loadCampaign(db: Db, approval: OwnerApprovalRow): Promise<MarketingCampaignRow | null> {
  const id = typeof approval.payload.campaignId === "string" ? approval.payload.campaignId : null;
  if (!id) return null;
  const { data } = await db
    .from("marketing_campaigns")
    .select("*")
    .eq("organization_id", approval.organization_id)
    .eq("company_id", approval.company_id)
    .eq("id", id)
    .maybeSingle();
  return (data as MarketingCampaignRow | null) ?? null;
}

function windowOf(campaign: MarketingCampaignRow): SendWindow {
  const w = campaign.send_window ?? {};
  return {
    perHour: typeof w.perHour === "number" ? w.perHour : MARKETING_DEFAULTS.perHour,
    startHour: typeof w.startHour === "number" ? w.startHour : MARKETING_DEFAULTS.startHour,
    endHour: typeof w.endHour === "number" ? w.endHour : MARKETING_DEFAULTS.endHour,
    days: Array.isArray(w.days) && w.days.length ? w.days : [...MARKETING_DEFAULTS.days],
    weeklyCap: typeof w.weeklyCap === "number" ? w.weeklyCap : MARKETING_DEFAULTS.weeklyCap,
  };
}

export async function executeMarketingCampaign(admin: AdminClient, approval: OwnerApprovalRow, decision: ApprovalDecision, deps: MarketerDeps): Promise<ExecuteResult> {
  const db = admin as Db;
  const campaign = await loadCampaign(db, approval);
  if (!campaign) return { ok: false, message: "I couldn't find that campaign - nothing was sent." };
  const nowIso = new Date(deps.now()).toISOString();

  if (!decision.approved) {
    const { data } = must(
      await db
        .from("marketing_campaigns")
        .update({ status: "cancelled", cancel_reason: decision.decidedVia === "expiry" ? "expired" : "owner_declined", updated_at: nowIso })
        .eq("id", campaign.id)
        .eq("organization_id", campaign.organization_id)
        .eq("approval_id", approval.id)
        .eq("status", "awaiting_owner")
        .select("id"),
    );
    if (((data ?? []) as unknown[]).length === 0) return { ok: true, message: "That campaign was already closed - nothing was sent." };
    await skipQueued(db, campaign, decision.decidedVia === "expiry" ? "not_approved_in_time" : "owner_declined");
    return decision.decidedVia === "expiry"
      ? { ok: true, message: "The win-back campaign wasn't approved in time, so nothing was sent." }
      : { ok: true, message: "OK - the win-back campaign won't go out." };
  }

  if (decision.ownerNote?.trim()) {
    return reaskWithoutNote(
      admin,
      deps,
      approval,
      async (newId) => {
        const { data } = must(
          await db
            .from("marketing_campaigns")
            .update({ approval_id: newId, updated_at: nowIso })
            .eq("id", campaign.id)
            .eq("organization_id", campaign.organization_id)
            .eq("approval_id", approval.id)
            .eq("status", "awaiting_owner")
            .select("id"),
        );
        return ((data ?? []) as unknown[]).length > 0;
      },
      "campaign",
    );
  }

  const { data: claimed } = must(
    await db
      .from("marketing_campaigns")
      .update({ status: "sending", approved_at: nowIso, started_at: nowIso, scheduled_for: nowIso, updated_at: nowIso })
      .eq("id", campaign.id)
      .eq("organization_id", campaign.organization_id)
      .eq("approval_id", approval.id)
      .eq("status", "awaiting_owner")
      .select("id"),
  );
  if (((claimed ?? []) as unknown[]).length === 0) {
    return { ok: campaign.status === "sending" || campaign.status === "done", message: `That campaign is already ${campaign.status === "cancelled" ? "cancelled" : campaign.status === "done" ? "done" : "going out"}.` };
  }
  return {
    ok: true,
    message: `Approved - texting ${campaign.audience_count} past customer${campaign.audience_count === 1 ? "" : "s"} ${describeWindow(windowOf(campaign))}. Replies go to your assistant. Text "stop the campaign" any time.`,
    detail: { campaignId: campaign.id },
  };
}

// ── Sending ───────────────────────────────────────────────────────────────────

/** Texts counted against the hourly / weekly caps: sent since `sinceMs` plus every claim in flight. */
async function usedSince(db: Db, campaign: MarketingCampaignRow, sinceMs: number): Promise<number> {
  const scoped = () =>
    db.from("marketing_campaign_recipients").select("id", { count: "exact", head: true }).eq("organization_id", campaign.organization_id).eq("company_id", campaign.company_id);
  const sent = await countRows(() => scoped().eq("status", "sent").gte("sent_at", new Date(sinceMs).toISOString()));
  const inFlight = await countRows(() => scoped().eq("status", "sending"));
  return sent + inFlight;
}

async function finishRecipient(db: Db, row: CampaignRecipientRow, patch: Partial<CampaignRecipientRow>): Promise<void> {
  const { error } = await db
    .from("marketing_campaign_recipients")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", row.id)
    .eq("organization_id", row.organization_id);
  if (error) console.error("[marketer] recording a recipient failed", row.id, error.message);
}

/** Send to one claimed recipient. */
async function sendOne(admin: AdminClient, campaign: MarketingCampaignRow, row: CampaignRecipientRow, nowMs: number): Promise<"sent" | "skipped" | "failed"> {
  const db = admin as Db;
  const scope = { organizationId: campaign.organization_id, companyId: campaign.company_id };
  const { data: contactData, error } = await db
    .from("contacts")
    .select("id, first_name, phone, sms_opt_out_at, email_opt_out_at, sms_consent_at, consent_source")
    .eq("organization_id", scope.organizationId)
    .eq("company_id", scope.companyId)
    .eq("id", row.contact_id)
    .maybeSingle();
  if (error) throw error;
  const contact = contactData as {
    id: string;
    first_name: string | null;
    phone: string | null;
    sms_opt_out_at: string | null;
    email_opt_out_at: string | null;
    sms_consent_at: string | null;
    consent_source: string | null;
  } | null;
  if (!contact?.phone?.trim()) {
    await finishRecipient(db, row, { status: "skipped", reason: "no_phone" });
    return "skipped";
  }
  const monthsMin = typeof campaign.audience_filter?.monthsMin === "number" ? (campaign.audience_filter.monthsMin as number) : MARKETING_DEFAULTS.monthsMin;
  const blocker = await recipientBlocker(admin, scope, { contactId: row.contact_id, phone: contact.phone, campaignId: campaign.id, monthsMin }, nowMs);
  if (blocker) {
    await finishRecipient(db, row, { status: "skipped", reason: blocker });
    return "skipped";
  }
  const purchase = (await latestPurchases(admin, scope, [row.contact_id])).get(row.contact_id) ?? row.last_purchase_at;
  const result = await deliverMessage({
    context: ctxFor(admin, scope.organizationId),
    channel: "sms",
    to: contact.phone.trim(),
    body: personalise(campaign.message ?? "", contact.first_name),
    companyId: scope.companyId,
    contactId: contact.id,
    consentContact: {
      sms_opt_out_at: contact.sms_opt_out_at,
      email_opt_out_at: contact.email_opt_out_at,
      sms_consent_at: contact.sms_consent_at,
      consent_source: contact.consent_source,
      last_purchase_at: purchase,
    },
    smsFrom: "company",
    sentBy: MARKETER_SENDER,
  });
  if (result.status === "sent") {
    let messageLogId: string | null = null;
    if (result.providerRef) {
      const { data: log } = await db
        .from("message_log")
        .select("id")
        .eq("organization_id", scope.organizationId)
        .eq("provider_ref", result.providerRef)
        .limit(1);
      messageLogId = ((log ?? []) as Array<{ id: string }>)[0]?.id ?? null;
    }
    await finishRecipient(db, row, { status: "sent", sent_at: new Date(nowMs).toISOString(), provider_ref: result.providerRef ?? null, message_log_id: messageLogId, reason: null });
    return "sent";
  }
  await finishRecipient(db, row, { status: result.status === "blocked" ? "skipped" : "failed", reason: result.reason ?? result.status });
  return result.status === "blocked" ? "skipped" : "failed";
}

/** Exact per-status counts (no row cap); marks the campaign done when nothing is left. */
async function refreshCounts(db: Db, campaign: MarketingCampaignRow, nowIso: string, force = false): Promise<{ remaining: number; sent: number }> {
  const count = (status: string) =>
    countRows(() => db.from("marketing_campaign_recipients").select("id", { count: "exact", head: true }).eq("organization_id", campaign.organization_id).eq("campaign_id", campaign.id).eq("status", status));
  const [queued, sending, sent, skipped, failed] = await Promise.all(["queued", "sending", "sent", "skipped", "failed"].map(count));
  const remaining = queued + sending;
  let q = db
    .from("marketing_campaigns")
    .update({
      sent_count: sent,
      skipped_count: skipped,
      failed_count: failed,
      ...(remaining === 0 && !force ? { status: "done", completed_at: nowIso } : {}),
      updated_at: nowIso,
    })
    .eq("id", campaign.id)
    .eq("organization_id", campaign.organization_id);
  if (!force) q = q.eq("status", "sending");
  must(await q);
  return { remaining, sent };
}

/** Why this campaign mustn't send right now (null → it may). */
async function holdReason(admin: AdminClient, company: MarketingCompany | null): Promise<string | null> {
  if (!company) return "company_missing";
  if (company.stage === "paused" || company.stage === "archived") return "company_paused";
  if (company.ownerPaused) return "owner_paused_texts";
  if (!company.settings.winBack.enabled) return "win_back_off";
  if (!(await companySmsNumber(admin, company))) return "no_company_number";
  return null;
}

const HOLD_WORDS: Record<string, string> = {
  company_missing: "the business couldn't be found",
  company_paused: "the business is paused",
  owner_paused_texts: "you paused all texts",
  win_back_off: "win-back texts were turned off",
  no_company_number: "this business has no texting number of its own",
};

/** Record a hold; past MAX_HOLD_MS cancel the campaign and tell the owner. */
async function applyHold(admin: AdminClient, campaign: Held, reason: string, nowMs: number): Promise<void> {
  const db = admin as Db;
  const nowIso = new Date(nowMs).toISOString();
  const scope = { organizationId: campaign.organization_id, companyId: campaign.company_id };
  if (!campaign.held_since) {
    must(await db.from("marketing_campaigns").update({ held_since: nowIso, hold_reason: reason, updated_at: nowIso }).eq("id", campaign.id).eq("organization_id", campaign.organization_id).eq("status", "sending"));
    if (reason === "no_company_number") {
      await textOwner(admin, scope, `Your win-back texts are on hold: ${HOLD_WORDS[reason]}, and I won't send them from anyone else's. Nothing more goes out until that's fixed (I'll cancel the campaign after 3 days).`);
      must(await db.from("marketing_campaigns").update({ hold_notified_at: nowIso }).eq("id", campaign.id).eq("organization_id", campaign.organization_id));
    }
    return;
  }
  if (nowMs - Date.parse(campaign.held_since) < MAX_HOLD_MS) return;
  const out = await cancelActiveCampaign(admin, scope, `held_too_long: ${reason}`, nowMs);
  if (out.cancelled && out.campaignId === campaign.id) {
    await textOwner(
      admin,
      scope,
      `I cancelled the win-back campaign: it was on hold for 3 days (${HOLD_WORDS[reason] ?? reason}). ${out.sent} text${out.sent === 1 ? "" : "s"} had gone out; the other ${out.queued} won't. I'll draft a fresh one next month.`,
    );
  }
}

async function claimSendSlot(db: Db, campaign: MarketingCampaignRow, nowMs: number): Promise<boolean> {
  const { error } = await db
    .from("marketing_sweep_claims")
    .insert({ company_id: campaign.company_id, task: `campaign_send:${campaign.id}`, period_key: String(Math.floor(nowMs / SEND_SLOT_MS)), created_at: new Date(nowMs).toISOString() });
  if (!error) return true;
  if (isUniqueViolation(error)) return false;
  throw error;
}

/**
 * Scheduler: send the next throttled batch of every approved campaign. Safe to run on several
 * workers at once (one batch per campaign per 5-minute slot, per-recipient claims), and
 * idempotent across ticks.
 */
export async function sendCampaignBatches(admin: AdminClient, deps: MarketerDeps): Promise<{ sent: number; skipped: number; failed: number }> {
  const db = admin as Db;
  const nowMs = deps.now();
  const nowIso = new Date(nowMs).toISOString();
  const totals = { sent: 0, skipped: 0, failed: 0 };

  // A claim a crashed worker left behind: failed, never re-sent (the text may have gone out).
  must(
    await db
      .from("marketing_campaign_recipients")
      .update({ status: "failed", reason: "interrupted while sending - not retried", updated_at: nowIso })
      .eq("status", "sending")
      .lt("claimed_at", new Date(nowMs - STALE_CLAIM_MS).toISOString()),
  );
  await cancelStaleDrafts(db, nowMs);
  // Old send slots (a day is plenty).
  await db.from("marketing_sweep_claims").delete().like("task", "campaign_send:%").lt("created_at", new Date(nowMs - 86_400_000).toISOString());

  const sending = await pageAll<Held>(() => db.from("marketing_campaigns").select("*").eq("status", "sending").order("id", { ascending: true }));
  for (const campaign of sending) {
    try {
      const company = await loadMarketingCompany(admin, { organizationId: campaign.organization_id, companyId: campaign.company_id });
      const hold = await holdReason(admin, company);
      if (hold || !company) {
        await applyHold(admin, campaign, hold ?? "company_missing", nowMs);
        continue;
      }
      if (campaign.held_since) {
        must(
          await db
            .from("marketing_campaigns")
            .update({ held_since: null, hold_reason: null, hold_notified_at: null, updated_at: nowIso })
            .eq("id", campaign.id)
            .eq("organization_id", campaign.organization_id),
        );
      }
      const window = windowOf(campaign);
      if (!inSendWindow(nowMs, company.timeZone, window) || !inProactiveHours(nowMs, company.timeZone)) continue;
      const hourLeft = window.perHour - (await usedSince(db, campaign, nowMs - 3_600_000));
      const weekLeft = window.weeklyCap - (await usedSince(db, campaign, nowMs - 7 * 86_400_000));
      const perTick = Math.max(1, Math.ceil(window.perHour / 6));
      const batch = Math.min(hourLeft, weekLeft, perTick);
      if (batch > 0 && (await claimSendSlot(db, campaign, nowMs))) {
        const { data: queued, error } = await db
          .from("marketing_campaign_recipients")
          .select("*")
          .eq("organization_id", campaign.organization_id)
          .eq("campaign_id", campaign.id)
          .eq("status", "queued")
          .order("created_at", { ascending: true })
          .limit(batch);
        if (error) throw error;
        for (const row of (queued ?? []) as CampaignRecipientRow[]) {
          const { data: claimedRows, error: claimError } = await db
            .from("marketing_campaign_recipients")
            .update({ status: "sending", claimed_at: new Date(deps.now()).toISOString(), updated_at: nowIso })
            .eq("id", row.id)
            .eq("organization_id", campaign.organization_id)
            .eq("status", "queued")
            .select("*");
          if (claimError) throw claimError;
          const claimed = ((claimedRows ?? []) as CampaignRecipientRow[])[0];
          if (!claimed) continue;
          try {
            totals[await sendOne(admin, campaign, claimed, deps.now())] += 1;
          } catch (err) {
            await finishRecipient(db, claimed, { status: "failed", reason: err instanceof Error ? err.message.slice(0, 200) : "error" });
            totals.failed += 1;
          }
        }
      }
      await refreshCounts(db, campaign, nowIso);
    } catch (err) {
      console.error("[marketer] campaign batch failed", campaign.id, err instanceof Error ? err.message : err);
    }
  }
  return totals;
}

// ── Results ───────────────────────────────────────────────────────────────────

export interface CampaignResults {
  campaignId: string;
  status: string;
  createdAt: string;
  audienceCount: number;
  sent: number;
  skipped: number;
  failed: number;
  queued: number;
  replies: number;
  bookings: number;
  quotes: number;
}

/** Sends, replies, and bookings / quotes from recipients within 30 days of their text. */
export async function campaignResults(admin: AdminClient, campaign: MarketingCampaignRow): Promise<CampaignResults> {
  const db = admin as Db;
  const rows = await pageAll<{ contact_id: string; status: string; sent_at: string | null }>(() =>
    db.from("marketing_campaign_recipients").select("id, contact_id, status, sent_at").eq("organization_id", campaign.organization_id).eq("campaign_id", campaign.id).order("id", { ascending: true }),
  );
  const sentAt = new Map(rows.filter((r) => r.status === "sent" && r.sent_at).map((r) => [r.contact_id, Date.parse(r.sent_at as string)]));
  const ids = [...sentAt.keys()];
  const inWindow = (contactId: string | null, at: string | null) => {
    const start = contactId ? sentAt.get(contactId) : undefined;
    const ms = at ? Date.parse(at) : Number.NaN;
    return start !== undefined && ms >= start && ms <= start + RESULTS_WINDOW_DAYS * 86_400_000;
  };
  const countIn = async (table: string, extra: (q: Db) => Db, distinct: boolean): Promise<number> => {
    let total = 0;
    const seen = new Set<string>();
    for (let i = 0; i < ids.length; i += 200) {
      const group = ids.slice(i, i + 200);
      const since = new Date(Math.min(...group.map((id) => sentAt.get(id) ?? Date.now()))).toISOString();
      const found = await pageAll<{ contact_id: string | null; created_at: string | null }>(() =>
        extra(db.from(table).select("id, contact_id, created_at").eq("organization_id", campaign.organization_id).in("contact_id", group).gte("created_at", since)).order("id", { ascending: true }),
      );
      for (const r of found) {
        if (!inWindow(r.contact_id, r.created_at)) continue;
        if (distinct) seen.add(r.contact_id as string);
        else total += 1;
      }
    }
    return distinct ? seen.size : total;
  };
  const companyId = campaign.company_id;
  const [replies, bookings, quotes] = ids.length
    ? await Promise.all([
        countIn("message_log", (q) => q.eq("company_id", companyId).eq("direction", "inbound").eq("channel", "sms"), true),
        countIn("bookings", (q) => q.eq("company_id", companyId).neq("status", "cancelled"), false),
        countIn("quotes", (q) => q.eq("company_id", companyId).neq("status", "draft"), false),
      ])
    : [0, 0, 0];
  const count = (s: string) => rows.filter((r) => r.status === s).length;
  return {
    campaignId: campaign.id,
    status: campaign.status,
    createdAt: campaign.created_at,
    audienceCount: campaign.audience_count,
    sent: count("sent"),
    skipped: count("skipped"),
    failed: count("failed"),
    queued: count("queued") + count("sending"),
    replies,
    bookings,
    quotes,
  };
}

/** The company's most recent campaign that got past drafting (or null). */
export async function lastCampaign(admin: AdminClient, scope: { organizationId: string; companyId: string }): Promise<MarketingCampaignRow | null> {
  const { data } = await (admin as Db)
    .from("marketing_campaigns")
    .select("*")
    .eq("organization_id", scope.organizationId)
    .eq("company_id", scope.companyId)
    .order("created_at", { ascending: false })
    .limit(10);
  const rows = (data ?? []) as MarketingCampaignRow[];
  return rows.find((r) => !(r.status === "cancelled" && r.cancel_reason === "no_audience")) ?? null;
}

export function exclusionText(excluded: Partial<Record<ExclusionReason, number>>): string {
  const parts = (Object.entries(excluded) as Array<[ExclusionReason, number]>).filter(([, n]) => n > 0).map(([r, n]) => `${n} ${EXCLUSION_LABELS[r]}`);
  return parts.length ? parts.join(", ") : "none";
}
