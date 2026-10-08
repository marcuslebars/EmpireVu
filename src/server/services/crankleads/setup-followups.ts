// ─────────────────────────────────────────────────────────────────────────────
// SANCTIONED EXCEPTION (service role): CrankLeads setup follow-ups.
// Runs inside the workflow-event worker's scheduler pass (runScheduler) with the worker's
// admin client — a scheduler pass has no user session. It reads crankleads_purchases (a
// service-role-only table) and, per purchase, the purchase's OWN organization_id +
// company_id (stamped by provisioning, never taken from input); every tenant read/write is
// filtered by that org (+ company). Messages go only to that company's owner contacts and
// to the operator (OWNER_EMAIL). Listed in docs/EMPIREVU_RUNBOOK.md.
// ─────────────────────────────────────────────────────────────────────────────
import { randomBytes } from "node:crypto";

import type { Tables } from "@/server/db/database.types";
import { sendEmail as defaultSendEmail, type SendEmailInput, type SendEmailResult } from "@/server/outbound/email";
import { isCrankleadsTier, type CrankleadsTier } from "@/server/services/crankleads/config";
import {
  renderLiveEmail,
  renderLiveSms,
  renderReminderEmail,
  renderReminderSms,
  type ReminderAction,
  type ReminderMessageInput,
} from "@/server/services/crankleads/followup-messages";
import {
  inLiveWindow,
  localClock,
  REMINDER_STAGES,
  selectReminderStage,
  type FollowupStage,
  type ReminderStage,
} from "@/server/services/crankleads/followup-schedule";
import { createSetPasswordUrl as defaultCreateSetPasswordUrl, getAuthUser } from "@/server/services/crankleads/provision";
import type { AdminClient, CrankleadsPurchase } from "@/server/services/crankleads/purchases";
import { computeSetupChecklist, loadSetupFacts, type SetupChecklist } from "@/server/services/crankleads/setup-checklist";
import { companySiteUrl, forwardPageUrl, quickSetupUrl } from "@/server/services/dfy/links";
import { ensureForwardToken, ensureProgress } from "@/server/services/dfy/progress";
import { toE164 } from "@/server/services/retell/payload";
import type { TenantServiceContext } from "@/server/services/shared";
import {
  deliverMessage as defaultDeliverMessage,
  resolveOwnerContacts,
  type DeliverMessageInput,
  type DeliverMessageResult,
} from "@/server/services/workflow-engine/messaging";
import { appBaseUrlFor } from "@/server/services/platform-brand";

/** Live detection keeps checking a not-yet-live buyer this long after provisioning. */
export const LIVE_DETECTION_LOOKBACK_DAYS = 90;
/** A "you're live" confirmation that couldn't go out (night) is still sent within this window. */
export const LIVE_CONFIRMATION_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
/** How often the scheduler runs the pass (it ticks every minute). */
export const SETUP_FOLLOWUP_INTERVAL_MS = 5 * 60 * 1000;

const FALLBACK_TIMEZONE = "America/Toronto";

export interface SetupFollowupDeps {
  deliver: (input: DeliverMessageInput) => Promise<DeliverMessageResult>;
  /** Operator email (OWNER_EMAIL) — not a tenant message, so it bypasses message_log. */
  sendEmail: (input: SendEmailInput) => Promise<SendEmailResult>;
  createSetPasswordUrl: (admin: AdminClient, email: string, next: string) => Promise<string>;
  /** Has this owner ever signed in? (decides whether the email carries a set-password link) */
  ownerHasSignedIn: (admin: AdminClient, profileId: string) => Promise<boolean>;
  newStopToken: () => string;
}

const defaultDeps: SetupFollowupDeps = {
  deliver: defaultDeliverMessage,
  sendEmail: defaultSendEmail,
  createSetPasswordUrl: defaultCreateSetPasswordUrl,
  ownerHasSignedIn: async (admin, profileId) => Boolean((await getAuthUser(admin, profileId))?.last_sign_in_at),
  newStopToken: () => randomBytes(24).toString("hex"),
};

export type FollowupAction =
  | "reminder_sent"
  | "live_marked"
  | "live_sent"
  | "skipped"
  | "failed";

export interface FollowupOutcome {
  purchaseId: string;
  action: FollowupAction;
  stage?: FollowupStage;
  reason?: string;
}

/** The buyer's app origin: the CrankLeads host (setup reminders go only to CrankLeads buyers). */
function appUrl(): string {
  return appBaseUrlFor("crankleads");
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err) return String((err as { message: unknown }).message);
  return String(err);
}

/** The public "stop these reminders" link for a purchase's token. */
export function stopRemindersUrl(base: string, token: string): string {
  return `${base}/api/public/crankleads/setup-reminders?token=${encodeURIComponent(token)}`;
}

// ── Loading ──────────────────────────────────────────────────────────────────

async function loadCandidates(admin: AdminClient, nowMs: number): Promise<CrankleadsPurchase[]> {
  const lookback = new Date(nowMs - LIVE_DETECTION_LOOKBACK_DAYS * 86_400_000).toISOString();
  const confirmLookback = new Date(nowMs - LIVE_CONFIRMATION_MAX_AGE_MS).toISOString();
  const [notLive, recentlyLive] = await Promise.all([
    admin
      .from("crankleads_purchases")
      .select("*")
      .eq("status", "provisioned")
      .is("live_at", null)
      .gt("provisioned_at", lookback)
      .order("provisioned_at", { ascending: true })
      .limit(500),
    admin
      .from("crankleads_purchases")
      .select("*")
      .eq("status", "provisioned")
      .gt("live_at", confirmLookback)
      .limit(500),
  ]);
  if (notLive.error) throw new Error(`setup follow-ups: purchase scan failed: ${notLive.error.message}`);
  if (recentlyLive.error) throw new Error(`setup follow-ups: live scan failed: ${recentlyLive.error.message}`);
  const seen = new Set<string>();
  const out: CrankleadsPurchase[] = [];
  for (const row of [...(notLive.data ?? []), ...(recentlyLive.data ?? [])] as CrankleadsPurchase[]) {
    if (!seen.has(row.id)) {
      seen.add(row.id);
      out.push(row);
    }
  }
  return out;
}

type FollowupRow = Pick<Tables<"crankleads_setup_followups">, "stage" | "local_date">;

async function loadSends(admin: AdminClient, purchase: CrankleadsPurchase, organizationId: string): Promise<FollowupRow[]> {
  const { data, error } = await admin
    .from("crankleads_setup_followups")
    .select("stage, local_date")
    .eq("organization_id", organizationId)
    .eq("purchase_id", purchase.id);
  if (error) throw new Error(`follow-up log lookup failed: ${error.message}`);
  return (data ?? []) as FollowupRow[];
}

type CompanyRow = Pick<Tables<"companies">, "id" | "name" | "timezone" | "owner_email" | "owner_phone_e164">;

// ── Claiming (idempotency) ───────────────────────────────────────────────────

interface ClaimInput {
  organizationId: string;
  companyId: string;
  purchaseId: string;
  stage: FollowupStage;
  localDate: string;
  nextStep: string | null;
  stepsLeft: number;
}

/**
 * Insert the (purchase, stage) row BEFORE sending. A unique violation (another worker, a
 * retry, or a second reminder on the same local day) → false, and nothing is sent.
 */
async function claimStage(admin: AdminClient, input: ClaimInput): Promise<boolean> {
  const { error } = await admin.from("crankleads_setup_followups").insert({
    organization_id: input.organizationId,
    company_id: input.companyId,
    purchase_id: input.purchaseId,
    stage: input.stage,
    local_date: input.localDate,
    next_step: input.nextStep,
    steps_left: input.stepsLeft,
  });
  if (!error) return true;
  if ((error as { code?: string }).code === "23505") return false;
  throw new Error(`follow-up claim failed: ${error.message}`);
}

async function recordStatuses(
  admin: AdminClient,
  organizationId: string,
  purchaseId: string,
  stage: FollowupStage,
  patch: { email_status?: string | null; sms_status?: string | null; operator_status?: string | null },
): Promise<void> {
  const { error } = await admin
    .from("crankleads_setup_followups")
    .update(patch)
    .eq("organization_id", organizationId)
    .eq("purchase_id", purchaseId)
    .eq("stage", stage);
  if (error) console.error(`[setup-followups] status write failed for ${purchaseId}/${stage}: ${error.message}`);
}

// ── Delivery ─────────────────────────────────────────────────────────────────

interface OwnerAddress {
  email: string | null;
  phone: string | null;
}

async function ownerAddress(ctx: TenantServiceContext, company: CompanyRow, purchase: CrankleadsPurchase): Promise<OwnerAddress> {
  const contacts = await resolveOwnerContacts(ctx, company);
  return {
    email: contacts.email ?? purchase.owner_email ?? null,
    phone: contacts.phone ?? toE164(purchase.owner_phone),
  };
}

async function deliverPair(
  deps: SetupFollowupDeps,
  ctx: TenantServiceContext,
  companyId: string,
  to: OwnerAddress,
  email: { subject: string; body: string; html: string; fromName: string },
  sms: string,
): Promise<{ email_status: string; sms_status: string }> {
  const send = async (input: DeliverMessageInput): Promise<string> => {
    if (!input.to) return "skipped:no_recipient";
    try {
      const result = await deps.deliver(input);
      return result.reason ? `${result.status}:${result.reason}` : result.status;
    } catch (err) {
      console.error(`[setup-followups] ${input.channel} send threw: ${errorMessage(err)}`);
      return "failed";
    }
  };
  const base = { context: ctx, companyId, contactId: null, consentContact: null } as const;
  const email_status = await send({
    ...base,
    channel: "email",
    to: to.email,
    subject: email.subject,
    body: email.body,
    html: email.html,
    fromName: email.fromName,
  });
  const sms_status = await send({ ...base, channel: "sms", to: to.phone, body: sms, smsFrom: "platform" });
  return { email_status, sms_status };
}

async function ensureStopToken(admin: AdminClient, purchase: CrankleadsPurchase, deps: SetupFollowupDeps): Promise<string> {
  if (purchase.setup_reminders_stop_token) return purchase.setup_reminders_stop_token;
  const token = deps.newStopToken();
  const { error } = await admin
    .from("crankleads_purchases")
    .update({ setup_reminders_stop_token: token })
    .eq("id", purchase.id)
    .is("setup_reminders_stop_token", null);
  if (error) throw new Error(`stop token write failed: ${error.message}`);
  const { data, error: readError } = await admin
    .from("crankleads_purchases")
    .select("setup_reminders_stop_token")
    .eq("id", purchase.id)
    .maybeSingle();
  if (readError) throw new Error(`stop token read failed: ${readError.message}`);
  return (data as { setup_reminders_stop_token: string | null } | null)?.setup_reminders_stop_token ?? token;
}

async function setPasswordLinkIfNeeded(
  admin: AdminClient,
  purchase: CrankleadsPurchase,
  ownerEmail: string,
  nextPath: string,
  deps: SetupFollowupDeps,
): Promise<string | null> {
  if (purchase.existing_user || !purchase.owner_profile_id) return null;
  try {
    if (await deps.ownerHasSignedIn(admin, purchase.owner_profile_id)) return null;
    return await deps.createSetPasswordUrl(admin, ownerEmail, nextPath);
  } catch (err) {
    // The deep link still works via "Forgot password" — never skip a reminder over this.
    console.error(`[setup-followups] set-password link failed for ${purchase.id}: ${errorMessage(err)}`);
    return null;
  }
}

// ── Per purchase ─────────────────────────────────────────────────────────────

async function sendLive(
  admin: AdminClient,
  ctx: TenantServiceContext,
  purchase: CrankleadsPurchase,
  company: CompanyRow,
  checklist: SetupChecklist,
  liveAtMs: number,
  timeZone: string,
  nowMs: number,
  sends: FollowupRow[],
  links: SetupLinks,
  deps: SetupFollowupDeps,
): Promise<FollowupOutcome> {
  if (sends.some((row) => row.stage === "live")) return { purchaseId: purchase.id, action: "skipped", reason: "live_already_sent" };
  if (nowMs - liveAtMs > LIVE_CONFIRMATION_MAX_AGE_MS) return { purchaseId: purchase.id, action: "skipped", reason: "live_confirmation_expired" };
  if (!inLiveWindow(timeZone, nowMs)) return { purchaseId: purchase.id, action: "skipped", reason: "live_outside_window" };

  const claimed = await claimStage(admin, {
    organizationId: checklist.organizationId,
    companyId: checklist.companyId,
    purchaseId: purchase.id,
    stage: "live",
    localDate: localClock(timeZone, nowMs).date,
    nextStep: null,
    stepsLeft: 0,
  });
  if (!claimed) return { purchaseId: purchase.id, action: "skipped", reason: "live_claimed_elsewhere" };

  const to = await ownerAddress(ctx, company, purchase);
  // The set-password link signs in AS the buyer, so it only ever goes to the buyer's own
  // checkout email, and only when they have never signed in. Texts never carry it.
  const buyerEmail = purchase.owner_email?.trim() || null;
  const setPasswordUrl = buyerEmail ? await setPasswordLinkIfNeeded(admin, purchase, buyerEmail, "/", deps) : null;
  const input = {
    ownerName: purchase.owner_name,
    businessName: company.name,
    phonePath: checklist.phonePath,
    appUrl: appUrl(),
    number: links.number,
    siteUrl: links.siteUrl,
    setPasswordUrl,
  };
  const statuses = await deliverPair(
    deps,
    ctx,
    company.id,
    setPasswordUrl ? { email: buyerEmail, phone: to.phone } : to,
    renderLiveEmail(input),
    renderLiveSms(input),
  );
  await recordStatuses(admin, checklist.organizationId, purchase.id, "live", statuses);
  return { purchaseId: purchase.id, action: "live_sent", stage: "live" };
}

/** What a reminder asks for: the quick setup while it's unanswered, else the forwarding tap. */
export function reminderAction(checklist: SetupChecklist, links: SetupLinks): { action: ReminderAction; url: string } | null {
  const next = checklist.nextStep;
  if (!next) return null;
  if (links.quickSetupUrl) return { action: "quick_setup", url: links.quickSetupUrl };
  if (next.key === "forwarding" || (next.key === "phone" && links.forwardUrl)) {
    return { action: "forwarding", url: links.forwardUrl ?? next.deepLink };
  }
  return { action: "other", url: next.deepLink };
}

async function sendReminder(
  admin: AdminClient,
  ctx: TenantServiceContext,
  purchase: CrankleadsPurchase,
  company: CompanyRow,
  checklist: SetupChecklist,
  links: SetupLinks,
  stage: ReminderStage,
  localDate: string,
  deps: SetupFollowupDeps,
): Promise<FollowupOutcome> {
  const next = checklist.nextStep;
  const ask = reminderAction(checklist, links);
  if (!next || !ask) return { purchaseId: purchase.id, action: "skipped", reason: "nothing_left" };
  const remaining = checklist.steps.filter((s) => !s.done);

  const claimed = await claimStage(admin, {
    organizationId: checklist.organizationId,
    companyId: checklist.companyId,
    purchaseId: purchase.id,
    stage,
    localDate,
    nextStep: ask.action === "quick_setup" ? "quick_setup" : next.key,
    stepsLeft: remaining.length,
  });
  if (!claimed) return { purchaseId: purchase.id, action: "skipped", stage, reason: "already_claimed" };

  const base = appUrl();
  const to = await ownerAddress(ctx, company, purchase);
  const token = await ensureStopToken(admin, purchase, deps);
  const input: ReminderMessageInput = {
    stage,
    ownerName: purchase.owner_name,
    businessName: company.name,
    action: ask.action,
    actionUrl: ask.url,
    phonePath: checklist.phonePath,
    remaining: remaining.map((s) => ({ title: s.title, action: s.action })),
    appUrl: base,
    stopUrl: stopRemindersUrl(base, token),
  };
  const statuses = await deliverPair(deps, ctx, company.id, to, renderReminderEmail(input), renderReminderSms(input));
  // The operator is no longer emailed at day 10: the done-for-you orchestrator escalates 24h
  // after purchase (services/dfy/orchestrator.ts) and the daily health email lists it.
  await recordStatuses(admin, checklist.organizationId, purchase.id, stage, { ...statuses, operator_status: null });
  return { purchaseId: purchase.id, action: "reminder_sent", stage };
}

export interface SetupLinks {
  /** /setup/<token> while the quick setup is unanswered (pending / sent / opened), else null. */
  quickSetupUrl: string | null;
  /** /forward/<token> (minted on first use). */
  forwardUrl: string | null;
  /** Active text-back / AI number (E.164). */
  number: string | null;
  /** Published generated page (company_sites), if any. */
  siteUrl: string | null;
}

const UNANSWERED_INTAKE = ["pending", "sent", "opened"];

/** The no-login links for this company (best-effort: a missing table/row just means no link). */
async function loadSetupLinks(admin: AdminClient, organizationId: string, companyId: string): Promise<SetupLinks> {
  const [intake, site] = await Promise.all([
    admin.from("setup_intakes").select("token, status").eq("organization_id", organizationId).eq("company_id", companyId).maybeSingle(),
    admin
      .from("company_sites")
      .select("slug, status")
      .eq("organization_id", organizationId)
      .eq("company_id", companyId)
      .eq("status", "published")
      .maybeSingle(),
  ]);
  const intakeRow = intake.error ? null : (intake.data as { token: string; status: string } | null);
  const siteRow = site.error ? null : (site.data as { slug: string } | null);
  let forwardUrl: string | null = null;
  try {
    const progress = await ensureProgress(admin, organizationId, companyId);
    forwardUrl = forwardPageUrl(await ensureForwardToken(admin, progress));
  } catch (err) {
    console.error(`[setup-followups] forward link for ${companyId} failed: ${errorMessage(err)}`);
  }
  return {
    quickSetupUrl: intakeRow && UNANSWERED_INTAKE.includes(intakeRow.status) ? quickSetupUrl(intakeRow.token) : null,
    forwardUrl,
    number: null,
    siteUrl: siteRow?.slug ? companySiteUrl(siteRow.slug) : null,
  };
}

async function processPurchase(
  admin: AdminClient,
  purchase: CrankleadsPurchase,
  nowMs: number,
  deps: SetupFollowupDeps,
): Promise<FollowupOutcome[]> {
  const organizationId = purchase.organization_id;
  const companyId = purchase.company_id;
  if (!organizationId || !companyId || !purchase.provisioned_at) {
    return [{ purchaseId: purchase.id, action: "skipped", reason: "not_provisioned" }];
  }

  const { data: org, error: orgError } = await admin
    .from("organizations")
    .select("id, crankleads_tier, subscription_status")
    .eq("id", organizationId)
    .maybeSingle();
  if (orgError) throw new Error(`organization lookup failed: ${orgError.message}`);
  const orgRow = org as Pick<Tables<"organizations">, "id" | "crankleads_tier" | "subscription_status"> | null;
  if (!orgRow) return [{ purchaseId: purchase.id, action: "skipped", reason: "organization_missing" }];
  // Cancelled → stop everything immediately (no reminders, no live message).
  if (orgRow.subscription_status === "canceled") {
    return [{ purchaseId: purchase.id, action: "skipped", reason: "subscription_canceled" }];
  }
  const tier: CrankleadsTier | null = isCrankleadsTier(orgRow.crankleads_tier)
    ? orgRow.crankleads_tier
    : isCrankleadsTier(purchase.tier)
      ? purchase.tier
      : null;
  if (!tier) return [{ purchaseId: purchase.id, action: "skipped", reason: "unknown_tier" }];

  const { data: companyData, error: companyError } = await admin
    .from("companies")
    .select("id, name, timezone, owner_email, owner_phone_e164")
    .eq("organization_id", organizationId)
    .eq("id", companyId)
    .maybeSingle();
  if (companyError) throw new Error(`company lookup failed: ${companyError.message}`);
  const company = companyData as CompanyRow | null;
  if (!company) return [{ purchaseId: purchase.id, action: "skipped", reason: "company_missing" }];

  const ctx: TenantServiceContext = { organizationId, actorProfileId: null, supabase: admin };
  const timeZone = company.timezone?.trim() || FALLBACK_TIMEZONE;
  const facts = await loadSetupFacts(ctx, companyId);
  const draft = computeSetupChecklist({ organizationId, companyId, tier, facts, appBaseUrl: appUrl() });
  const links = await loadSetupLinks(admin, organizationId, companyId);
  links.number = draft.phonePath === "ai_receptionist" ? facts.aiNumber : facts.catcherNumber;
  const checklist = computeSetupChecklist({ organizationId, companyId, tier, facts, appBaseUrl: appUrl(), forwardUrl: links.forwardUrl });
  const stopped = Boolean(purchase.setup_reminders_stopped_at);
  // Provisioned before follow-ups shipped (backfilled by 20261004130000): never chased, never
  // sent a late "you're live" — live_at is still stamped silently.
  const exempt = Boolean(purchase.setup_followups_exempt_at);
  const quietReason = exempt ? "followups_exempt" : stopped ? "reminders_stopped" : null;
  const outcomes: FollowupOutcome[] = [];

  // ── Live ──
  let liveAtMs = purchase.live_at ? Date.parse(purchase.live_at) : null;
  if (liveAtMs === null && checklist.isLive) {
    const nowIso = new Date(nowMs).toISOString();
    const { data: marked, error } = await admin
      .from("crankleads_purchases")
      .update({ live_at: nowIso })
      .eq("id", purchase.id)
      .is("live_at", null)
      .select("id");
    if (error) throw new Error(`live_at write failed: ${error.message}`);
    liveAtMs = nowMs;
    if ((marked ?? []).length > 0) {
      console.log(`[setup-followups] purchase ${purchase.id} (${company.name}) is LIVE`);
      outcomes.push({ purchaseId: purchase.id, action: "live_marked" });
    }
  }
  if (liveAtMs !== null) {
    if (quietReason) return [...outcomes, { purchaseId: purchase.id, action: "skipped", reason: quietReason }];
    const sends = await loadSends(admin, purchase, organizationId);
    outcomes.push(await sendLive(admin, ctx, purchase, company, checklist, liveAtMs, timeZone, nowMs, sends, links, deps));
    return outcomes;
  }

  // ── Not live: reminders ──
  if (quietReason) return [{ purchaseId: purchase.id, action: "skipped", reason: quietReason }];
  const sends = await loadSends(admin, purchase, organizationId);
  const decision = selectReminderStage({
    provisionedAtMs: Date.parse(purchase.provisioned_at),
    nowMs,
    timeZone,
    sentStages: new Set(sends.filter((s) => (REMINDER_STAGES as readonly string[]).includes(s.stage)).map((s) => s.stage)),
    sentLocalDates: new Set(sends.filter((s) => s.stage !== "live").map((s) => s.local_date)),
  });
  if (!decision.send || !decision.stage || !decision.localDate) {
    return [{ purchaseId: purchase.id, action: "skipped", reason: decision.reason ?? "nothing_due" }];
  }
  return [await sendReminder(admin, ctx, purchase, company, checklist, links, decision.stage, decision.localDate, deps)];
}

/**
 * One follow-up pass (from runScheduler, throttled to every SETUP_FOLLOWUP_INTERVAL_MS).
 * For every provisioned CrankLeads purchase that isn't live (or just went live): checklist →
 * stamp live_at / send the live confirmation, or send the due reminder. Never throws: a
 * per-purchase failure is logged and the loop continues.
 */
export async function processSetupFollowups(
  admin: AdminClient,
  nowMs: number = Date.now(),
  depsOverride: Partial<SetupFollowupDeps> = {},
): Promise<FollowupOutcome[]> {
  const deps: SetupFollowupDeps = { ...defaultDeps, ...depsOverride };
  const outcomes: FollowupOutcome[] = [];
  let purchases: CrankleadsPurchase[];
  try {
    purchases = await loadCandidates(admin, nowMs);
  } catch (err) {
    console.error(`[setup-followups] pass failed: ${errorMessage(err)}`);
    return outcomes;
  }
  for (const purchase of purchases) {
    try {
      outcomes.push(...(await processPurchase(admin, purchase, nowMs, deps)));
    } catch (err) {
      console.error(`[setup-followups] purchase ${purchase.id} failed: ${errorMessage(err)}`);
      outcomes.push({ purchaseId: purchase.id, action: "failed", reason: errorMessage(err) });
    }
  }
  const sent = outcomes.filter((o) => o.action === "reminder_sent" || o.action === "live_sent");
  if (sent.length > 0) {
    console.log(`[setup-followups] ${sent.map((o) => `${o.stage}:${o.purchaseId}`).join(", ")}`);
  }
  return outcomes;
}

// ── Public "stop these reminders" link ───────────────────────────────────────

const STOP_TOKEN = /^[0-9a-f]{48}$/;

export function isStopToken(value: unknown): value is string {
  return typeof value === "string" && STOP_TOKEN.test(value);
}

export type StopRemindersOutcome = "stopped" | "already_stopped" | "not_found";

/** Stop a purchase's setup reminders by its unguessable token (the email footer link). */
export async function stopSetupReminders(admin: AdminClient, token: string, nowMs: number = Date.now()): Promise<StopRemindersOutcome> {
  if (!isStopToken(token)) return "not_found";
  const { data, error } = await admin
    .from("crankleads_purchases")
    .select("id, setup_reminders_stopped_at")
    .eq("setup_reminders_stop_token", token)
    .maybeSingle();
  if (error) throw new Error(`stop lookup failed: ${error.message}`);
  const row = data as Pick<CrankleadsPurchase, "id" | "setup_reminders_stopped_at"> | null;
  if (!row) return "not_found";
  if (row.setup_reminders_stopped_at) return "already_stopped";
  const { error: updateError } = await admin
    .from("crankleads_purchases")
    .update({ setup_reminders_stopped_at: new Date(nowMs).toISOString() })
    .eq("id", row.id)
    .is("setup_reminders_stopped_at", null);
  if (updateError) throw new Error(`stop write failed: ${updateError.message}`);
  return "stopped";
}
