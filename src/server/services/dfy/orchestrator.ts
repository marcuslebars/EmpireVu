// ─────────────────────────────────────────────────────────────────────────────
// SANCTIONED EXCEPTION (service role): the done-for-you orchestrator.
// Runs in the workflow-event worker's scheduler pass (processDoneForYou, cross-tenant by
// design: it walks provisioned, not-yet-live CrankLeads purchases) — no user session. Each
// company is handled with a context pinned to its OWN organization_id (from the companies
// row, never from input); owner messages go only to that company's owner (platform sender),
// operator emails only to OWNER_EMAIL. docs/done-for-you.md → "Automatic switch-on".
//
// advanceDoneForYou(admin, companyId) is an idempotent state machine: it reads the current
// DB state and does whatever is next, recording progress on dfy_progress:
//   1. number missing           → (re)buy it (bounded retries with backoff, then flag + alert)
//   2. intake enriched (or ≥2h with no answer) and not switched on yet
//                               → switch everything on ONCE (automations, review requests,
//                                 booking hours, Front Desk prompt re-push)
//   3. switched on + number ready + forwarding not verified
//                               → send the one-tap forwarding text + email ONCE (08–21 local)
//   4. owner tapped             → one automatic forwarding test (after a short delay)
//   5. not live 24h after purchase (operator business hours)
//                               → operator escalation ONCE ("Call <name> <phone>")
// "Live" itself (live_at + the "You're live" text) is stamped by the setup follow-ups pass.
// ─────────────────────────────────────────────────────────────────────────────
import { forwardingPlan } from "@/lib/carrier-forwarding";
import type { Json, Tables } from "@/server/db/database.types";
import { toJson } from "@/server/db/json";
import { sendEmail as defaultSendEmail, type SendEmailInput, type SendEmailResult } from "@/server/outbound/email";
import { isCrankleadsTier, type CrankleadsTier } from "@/server/services/crankleads/config";
import { inLiveWindow, localClock } from "@/server/services/crankleads/followup-schedule";
import type { AdminClient, CrankleadsPurchase } from "@/server/services/crankleads/purchases";
import { loadSetupChecklist, type SetupChecklist } from "@/server/services/crankleads/setup-checklist";
import {
  loadForwardTarget,
  maybeStartAutoForwardingTest,
  type ForwardTarget,
  type ForwardingDeps,
} from "@/server/services/dfy/forwarding";
import { conciergeUrl, forwardPageUrl } from "@/server/services/dfy/links";
import {
  renderForwardingEmail,
  renderForwardingSms,
  renderOperatorEscalationEmail,
  renderOperatorForwardingHelpEmail,
  renderOperatorNumberFlaggedEmail,
  type OperatorCallInput,
} from "@/server/services/dfy/messages";
import { ensureDfyNumber, type DfyNumberDeps, type EnsureNumberOutcome } from "@/server/services/dfy/numbers";
import {
  claimOnce,
  ensureForwardToken,
  ensureProgress,
  errorMessage,
  loadProgress,
  patchProgress,
  type DfyProgress,
} from "@/server/services/dfy/progress";
import { switchOnEverything, type SwitchOnResult } from "@/server/services/dfy/switch-on";
import type { RetellClient } from "@/server/services/retell/provision";
import { toE164 } from "@/server/services/retell/payload";
import type { TenantServiceContext } from "@/server/services/shared";
import {
  deliverMessage as defaultDeliverMessage,
  resolveOwnerContacts,
  type DeliverMessageInput,
  type DeliverMessageResult,
} from "@/server/services/workflow-engine/messaging";

/** Proceed with what we have when the quick setup hasn't come back this long after it was created. */
export const INTAKE_WAIT_MS = 2 * 3_600_000;
/** An intake stuck in submitted/enriching this long is treated as done (enrichment failed quietly). */
export const ENRICHMENT_STUCK_MS = 6 * 3_600_000;
/** Escalate to an operator when not live this long after purchase. */
export const ESCALATE_AFTER_MS = 24 * 3_600_000;
/** Operator business hours for escalations (BUSINESS_TIMEZONE): Mon–Fri 08:00–18:00. */
export const OPERATOR_HOURS = { startHour: 8, endHour: 18 } as const;
/** Purchases older than this are no longer orchestrated (the operator owns them). */
export const DFY_LOOKBACK_DAYS = 30;
/** Companies advanced per sweep. */
export const DFY_BATCH_SIZE = 25;
/** The scheduler ticks every minute; the sweep runs at most this often per worker. */
export const DFY_SWEEP_INTERVAL_MS = 60_000;

export interface DoneForYouDeps extends ForwardingDeps {
  deliver: (input: DeliverMessageInput) => Promise<DeliverMessageResult>;
  /** Operator email (OWNER_EMAIL). */
  sendEmail: (input: SendEmailInput) => Promise<SendEmailResult>;
  twilio?: DfyNumberDeps["twilio"];
  retell?: RetellClient;
  /** Switch-on (injectable for tests). */
  switchOn?: (ctx: TenantServiceContext, companyId: string, tier: CrankleadsTier) => Promise<SwitchOnResult>;
  /** Number purchase (injectable for tests). */
  ensureNumber?: typeof ensureDfyNumber;
}

const defaultDeps: DoneForYouDeps = { deliver: defaultDeliverMessage, sendEmail: defaultSendEmail };

function operatorEmail(): string | null {
  return process.env.OWNER_EMAIL?.trim() || null;
}

function operatorTimeZone(): string {
  return process.env.BUSINESS_TIMEZONE?.trim() || "America/Toronto";
}

// ── Pure decisions ───────────────────────────────────────────────────────────

type IntakeRow = Pick<Tables<"setup_intakes">, "status" | "created_at" | "submitted_at" | "enriched_at" | "token">;

export type IntakeReadiness = "enriched" | "waited" | "no_intake" | "waiting";

/**
 * Is it time to switch on? Enriched → yes. Otherwise proceed with what we have once the
 * intake is INTAKE_WAIT_MS old and unanswered (pending / sent / opened / failed), or stuck in
 * submitted / enriching for ENRICHMENT_STUCK_MS. No intake row at all (bought before the
 * done-for-you flow) → yes once the purchase is INTAKE_WAIT_MS old.
 */
export function intakeReadiness(intake: IntakeRow | null, provisionedAtMs: number, nowMs: number): IntakeReadiness {
  if (!intake) return nowMs - provisionedAtMs >= INTAKE_WAIT_MS ? "no_intake" : "waiting";
  if (intake.status === "enriched") return "enriched";
  const created = Date.parse(intake.created_at);
  const age = Number.isFinite(created) ? nowMs - created : nowMs - provisionedAtMs;
  if (intake.status === "submitted" || intake.status === "enriching") {
    const since = Date.parse(intake.submitted_at ?? intake.created_at);
    return Number.isFinite(since) && nowMs - since >= ENRICHMENT_STUCK_MS ? "waited" : "waiting";
  }
  return age >= INTAKE_WAIT_MS ? "waited" : "waiting";
}

/**
 * When the 24h escalation is due: purchase + 24h, moved forward into operator business hours
 * (Mon–Fri 08:00–18:00 in `timeZone`) so nobody gets a "call them now" at 3am or on Sunday.
 * Walks in 15-minute steps (bounded) — simple and DST-safe.
 */
export function escalationDueAt(provisionedAtMs: number, timeZone: string): number {
  let t = provisionedAtMs + ESCALATE_AFTER_MS;
  for (let i = 0; i < 4 * 24 * 4; i++) {
    const clock = localClock(timeZone, t);
    const weekday = clock.weekday !== 0 && clock.weekday !== 6;
    if (weekday && clock.hour >= OPERATOR_HOURS.startHour && clock.hour < OPERATOR_HOURS.endHour) return t;
    t += 15 * 60_000;
  }
  return t;
}

// ── Loading ──────────────────────────────────────────────────────────────────

type CompanyRow = Pick<Tables<"companies">, "id" | "organization_id" | "name" | "timezone" | "owner_email" | "owner_phone_e164">;
type OrgRow = Pick<Tables<"organizations">, "id" | "crankleads_tier" | "subscription_status">;

interface CompanyState {
  company: CompanyRow;
  tier: CrankleadsTier;
  purchase: CrankleadsPurchase | null;
  intake: IntakeRow | null;
}

async function loadState(admin: AdminClient, companyId: string): Promise<CompanyState | { skip: string }> {
  const { data: companyData, error } = await admin
    .from("companies")
    .select("id, organization_id, name, timezone, owner_email, owner_phone_e164")
    .eq("id", companyId)
    .maybeSingle();
  if (error) throw new Error(`company lookup failed: ${error.message}`);
  const company = companyData as CompanyRow | null;
  if (!company) return { skip: "company_missing" };
  const org = company.organization_id;
  const [orgRes, purchaseRes, intakeRes] = await Promise.all([
    admin.from("organizations").select("id, crankleads_tier, subscription_status").eq("id", org).maybeSingle(),
    admin
      .from("crankleads_purchases")
      .select("*")
      .eq("organization_id", org)
      .eq("company_id", companyId)
      .order("created_at", { ascending: false })
      .limit(1),
    admin
      .from("setup_intakes")
      .select("status, created_at, submitted_at, enriched_at, token")
      .eq("organization_id", org)
      .eq("company_id", companyId)
      .maybeSingle(),
  ]);
  if (orgRes.error) throw new Error(`organization lookup failed: ${orgRes.error.message}`);
  if (purchaseRes.error) throw new Error(`purchase lookup failed: ${purchaseRes.error.message}`);
  const orgRow = orgRes.data as OrgRow | null;
  if (!orgRow || !isCrankleadsTier(orgRow.crankleads_tier)) return { skip: "not_crankleads" };
  if (orgRow.subscription_status === "canceled") return { skip: "subscription_canceled" };
  return {
    company,
    tier: orgRow.crankleads_tier,
    purchase: ((purchaseRes.data ?? []) as CrankleadsPurchase[])[0] ?? null,
    // setup_intakes is the intake builder's table; a read error just means "no intake yet".
    intake: intakeRes.error ? null : ((intakeRes.data as IntakeRow | null) ?? null),
  };
}

// ── Messages ─────────────────────────────────────────────────────────────────

async function ownerAddress(ctx: TenantServiceContext, state: CompanyState): Promise<{ email: string | null; phone: string | null }> {
  const contacts = await resolveOwnerContacts(ctx, state.company, { allowPlatformFallback: false });
  return {
    email: contacts.email ?? state.purchase?.owner_email ?? null,
    phone: contacts.phone ?? toE164(state.purchase?.owner_phone) ?? null,
  };
}

async function sendForwardingLink(
  admin: AdminClient,
  ctx: TenantServiceContext,
  state: CompanyState,
  row: DfyProgress,
  target: ForwardTarget,
  nowMs: number,
  deps: DoneForYouDeps,
): Promise<boolean> {
  if (!target.forwardTo || target.verified || row.forward_text_sent_at) return false;
  const timeZone = state.company.timezone?.trim() || "America/Toronto";
  if (!inLiveWindow(timeZone, nowMs)) return false;
  const token = await ensureForwardToken(admin, row);
  if (!(await claimOnce(admin, row, "forward_text_sent_at", new Date(nowMs).toISOString()))) return false;
  const plan = forwardingPlan({
    forwardTo: target.forwardTo.phone_e164,
    kind: target.company.business_phone_kind,
    carrier: target.company.business_phone_carrier,
  });
  const input = {
    ownerName: state.purchase?.owner_name ?? state.company.name,
    businessName: state.company.name,
    forwardUrl: forwardPageUrl(token),
    phonePath: target.phonePath,
    method: plan.method,
  };
  const to = await ownerAddress(ctx, state);
  const email = renderForwardingEmail(input);
  const base = { context: ctx, companyId: state.company.id, contactId: null, consentContact: null } as const;
  const results: string[] = [];
  for (const message of [
    to.phone ? ({ ...base, channel: "sms", to: to.phone, body: renderForwardingSms(input), smsFrom: "platform" } as const) : null,
    to.email ? ({ ...base, channel: "email", to: to.email, subject: email.subject, body: email.body, html: email.html, fromName: email.fromName } as const) : null,
  ]) {
    if (!message) continue;
    try {
      const result = await deps.deliver(message);
      results.push(`${message.channel}:${result.status}`);
    } catch (err) {
      results.push(`${message.channel}:failed`);
      console.error(`[dfy] forwarding ${message.channel} failed for ${state.company.id}: ${errorMessage(err)}`);
    }
  }
  console.log(`[dfy] forwarding link sent for company ${state.company.id} (${results.join(", ") || "no recipient"})`);
  return true;
}

function checklistLines(checklist: SetupChecklist | null): { done: string[]; left: string[] } {
  if (!checklist) return { done: [], left: [] };
  return {
    done: checklist.steps.filter((s) => s.done).map((s) => s.title),
    left: checklist.steps.filter((s) => !s.done).map((s) => s.title),
  };
}

function operatorCallInput(state: CompanyState, checklist: SetupChecklist | null, reason: string): OperatorCallInput {
  const lines = checklistLines(checklist);
  return {
    businessName: state.company.name,
    tier: state.tier,
    ownerName: state.purchase?.owner_name ?? "the owner",
    ownerPhone: state.purchase?.owner_phone ?? state.company.owner_phone_e164 ?? "",
    ownerEmail: state.purchase?.owner_email ?? state.company.owner_email ?? "",
    organizationId: state.company.organization_id,
    conciergeUrl: conciergeUrl(state.company.organization_id),
    done: lines.done,
    left: lines.left,
    reason,
  };
}

async function emailOperator(deps: DoneForYouDeps, email: { subject: string; body: string; html: string; fromName: string }): Promise<string> {
  const to = operatorEmail();
  if (!to) {
    console.error(`[dfy] OWNER_EMAIL is not set — operator email not sent: ${email.subject}`);
    return "skipped:no_owner_email_env";
  }
  try {
    await deps.sendEmail({ to, subject: email.subject, body: email.body, html: email.html, fromName: email.fromName });
    return "sent";
  } catch (err) {
    console.error(`[dfy] operator email failed (${email.subject}): ${errorMessage(err)}`);
    return "failed";
  }
}

/** The forwarding page's "Have us set it up — we'll call you" → operator email (once). */
export function forwardingHelpHandler(admin: AdminClient, deps: Partial<DoneForYouDeps> = {}) {
  const merged: DoneForYouDeps = { ...defaultDeps, ...deps };
  return async (row: DfyProgress, target: ForwardTarget): Promise<void> => {
    const state = await loadState(admin, row.company_id);
    if ("skip" in state) return;
    const ctx: TenantServiceContext = { organizationId: row.organization_id, actorProfileId: null, supabase: admin };
    const checklist = await loadSetupChecklist(ctx, { companyId: row.company_id, tier: state.tier }).catch(() => null);
    const kind = target.company.business_phone_kind ?? "unknown kind";
    const carrier = target.company.business_phone_carrier ?? "unknown carrier";
    await emailOperator(
      merged,
      renderOperatorForwardingHelpEmail(
        operatorCallInput(state, checklist, `They tapped "Have us set it up" on the forwarding page. Business line: ${kind}, ${carrier}.`),
      ),
    );
  };
}

// ── The state machine ────────────────────────────────────────────────────────

export type DfyStepOutcome =
  | "number_ready"
  | "number_bought"
  | "number_failed"
  | "number_waiting"
  | "number_flagged"
  | "switched_on"
  | "waiting_for_intake"
  | "forwarding_text_sent"
  | "forwarding_test_started"
  | "escalated"
  | "live";

export interface AdvanceResult {
  companyId: string;
  skipped?: string;
  steps: DfyStepOutcome[];
  error?: string;
}

function numberStep(outcome: EnsureNumberOutcome): DfyStepOutcome {
  switch (outcome.status) {
    case "ready":
      return outcome.purchasedNow ? "number_bought" : "number_ready";
    case "failed":
      return "number_failed";
    case "waiting":
      return "number_waiting";
    case "flagged":
      return "number_flagged";
  }
}

/**
 * Advance ONE company's done-for-you setup as far as the current state allows. Idempotent and
 * safe to run concurrently with itself (every once-only step is a conditional claim).
 * Never throws — an unexpected failure is recorded on dfy_progress.last_error.
 */
export async function advanceDoneForYou(
  admin: AdminClient,
  companyId: string,
  depsOverride: Partial<DoneForYouDeps> = {},
): Promise<AdvanceResult> {
  const deps: DoneForYouDeps = { ...defaultDeps, ...depsOverride };
  const nowMs = deps.now?.() ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const steps: DfyStepOutcome[] = [];
  let row: DfyProgress | null = null;
  try {
    const state = await loadState(admin, companyId);
    if ("skip" in state) return { companyId, skipped: state.skip, steps };
    const { company, tier, purchase } = state;
    const ctx: TenantServiceContext = { organizationId: company.organization_id, actorProfileId: null, supabase: admin };
    row = await ensureProgress(admin, company.organization_id, companyId);
    if (purchase?.live_at) return { companyId, skipped: "live", steps: ["live"] };

    // 1) Number.
    const numberOutcome = await (deps.ensureNumber ?? ensureDfyNumber)(
      admin,
      { organizationId: company.organization_id, companyId, tier, ownerPhone: purchase?.owner_phone ?? company.owner_phone_e164 },
      {
        twilio: deps.twilio,
        retell: deps.retell,
        now: () => nowMs,
        alertOperator: async ({ error }) => {
          await emailOperator(
            deps,
            renderOperatorNumberFlaggedEmail({
              businessName: company.name,
              organizationId: company.organization_id,
              error,
              attempts: row?.number_attempts ?? 0,
              conciergeUrl: conciergeUrl(company.organization_id),
            }),
          );
        },
      },
    );
    steps.push(numberStep(numberOutcome));
    row = (await loadProgress(admin, company.organization_id, companyId)) ?? row;

    // 2) Switch on (once).
    const provisionedMs = Date.parse(purchase?.provisioned_at ?? row.created_at);
    const readiness = intakeReadiness(state.intake, Number.isFinite(provisionedMs) ? provisionedMs : nowMs, nowMs);
    if (!row.switched_on_at) {
      if (readiness === "waiting") {
        steps.push("waiting_for_intake");
      } else if (await claimOnce(admin, row, "switched_on_at", nowIso)) {
        let detail: Json;
        try {
          const result = await (deps.switchOn ?? ((c, id, t) => switchOnEverything(c, id, t, { retell: deps.retell })))(ctx, companyId, tier);
          detail = toJson({ ...result, readiness });
        } catch (err) {
          detail = toJson({ error: errorMessage(err).slice(0, 300), readiness });
          console.error(`[dfy] switch-on failed for ${companyId}: ${errorMessage(err)}`);
        }
        await patchProgress(admin, row, { switch_on_detail: detail });
        steps.push("switched_on");
        row = (await loadProgress(admin, company.organization_id, companyId)) ?? row;
      }
    }

    // 3) Forwarding link (once) and 4) the automatic test after a tap.
    const target = await loadForwardTarget(admin, row);
    if (target && row.switched_on_at) {
      if (await sendForwardingLink(admin, ctx, state, row, target, nowMs, deps)) steps.push("forwarding_text_sent");
      if (await maybeStartAutoForwardingTest(admin, row, target, deps)) steps.push("forwarding_test_started");
    }

    // 5) 24h escalation (once).
    if (!row.escalated_at && Number.isFinite(provisionedMs) && nowMs >= escalationDueAt(provisionedMs, operatorTimeZone())) {
      const checklist = await loadSetupChecklist(ctx, { companyId, tier });
      if (checklist?.isLive) {
        steps.push("live");
      } else if (await claimOnce(admin, row, "escalated_at", nowIso)) {
        await emailOperator(
          deps,
          renderOperatorEscalationEmail(operatorCallInput(state, checklist, "Not live 24 hours after they bought. A quick call usually finishes it.")),
        );
        steps.push("escalated");
      }
    }

    await patchProgress(admin, row, { last_run_at: nowIso, last_error: null });
    return { companyId, steps };
  } catch (err) {
    const message = errorMessage(err).slice(0, 500);
    console.error(`[dfy] advance failed for company ${companyId}: ${message}`);
    if (row) await patchProgress(admin, row, { last_run_at: nowIso, last_error: message }).catch(() => undefined);
    return { companyId, steps, error: message };
  }
}

/**
 * One sweep (from the worker scheduler): advance up to DFY_BATCH_SIZE provisioned, not-yet-live
 * CrankLeads companies, least-recently-advanced first. Never throws.
 */
export async function processDoneForYou(
  admin: AdminClient,
  nowMs: number = Date.now(),
  depsOverride: Partial<DoneForYouDeps> = {},
): Promise<AdvanceResult[]> {
  const results: AdvanceResult[] = [];
  try {
    const { data, error } = await admin
      .from("crankleads_purchases")
      .select("organization_id, company_id, provisioned_at")
      .eq("status", "provisioned")
      .is("live_at", null)
      .gt("provisioned_at", new Date(nowMs - DFY_LOOKBACK_DAYS * 86_400_000).toISOString())
      .order("provisioned_at", { ascending: false })
      .limit(500);
    if (error) throw new Error(`purchase scan failed: ${error.message}`);
    const rows = ((data ?? []) as Array<Pick<CrankleadsPurchase, "organization_id" | "company_id">>).filter(
      (p): p is { organization_id: string; company_id: string } => Boolean(p.organization_id && p.company_id),
    );
    if (rows.length === 0) return results;
    const { data: progress, error: progressError } = await admin
      .from("dfy_progress")
      .select("company_id, last_run_at")
      .in("company_id", rows.map((r) => r.company_id));
    if (progressError) throw new Error(`progress scan failed: ${progressError.message}`);
    const lastRun = new Map(((progress ?? []) as Array<{ company_id: string; last_run_at: string | null }>).map((p) => [p.company_id, p.last_run_at ?? ""]));
    const batch = [...new Set(rows.map((r) => r.company_id))]
      .sort((a, b) => (lastRun.get(a) ?? "").localeCompare(lastRun.get(b) ?? ""))
      .slice(0, DFY_BATCH_SIZE);
    for (const companyId of batch) {
      results.push(await advanceDoneForYou(admin, companyId, { ...depsOverride, now: () => nowMs }));
    }
    const acted = results.filter((r) => r.steps.some((s) => s !== "number_ready" && s !== "waiting_for_intake" && s !== "number_waiting"));
    if (acted.length) console.log(`[dfy] ${acted.map((r) => `${r.companyId}:${r.steps.join("+")}`).join(", ")}`);
  } catch (err) {
    console.error(`[dfy] sweep failed: ${errorMessage(err)}`);
  }
  return results;
}

let lastSweepMs = 0;

/** The ONE line the worker scheduler calls each tick: throttled + self-guarded. */
export async function runDoneForYouSweep(admin: AdminClient, nowMs: number = Date.now()): Promise<void> {
  if (nowMs - lastSweepMs < DFY_SWEEP_INTERVAL_MS) return;
  lastSweepMs = nowMs;
  await processDoneForYou(admin, nowMs).catch((err) => console.error(`[dfy] sweep failed: ${errorMessage(err)}`));
}

/** Purchase provisioning → buy the number right away. Never throws (the sweep retries). */
export async function provisionDoneForYouNumber(
  admin: AdminClient,
  input: { organizationId: string; companyId: string; tier: CrankleadsTier; ownerPhone: string | null },
  depsOverride: Partial<DoneForYouDeps> = {},
): Promise<EnsureNumberOutcome | null> {
  try {
    const deps: DoneForYouDeps = { ...defaultDeps, ...depsOverride };
    return await (deps.ensureNumber ?? ensureDfyNumber)(admin, input, { twilio: deps.twilio, retell: deps.retell, now: deps.now });
  } catch (err) {
    console.error(`[dfy] number at purchase failed for company ${input.companyId} (the sweep retries): ${errorMessage(err)}`);
    return null;
  }
}

/** For the in-app progress view + the forwarding page link. */
export async function forwardLinkFor(admin: AdminClient, organizationId: string, companyId: string): Promise<string | null> {
  const row = await ensureProgress(admin, organizationId, companyId);
  return forwardPageUrl(await ensureForwardToken(admin, row));
}
