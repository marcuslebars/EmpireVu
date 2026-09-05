import type { Json } from "@/server/db/database.types";
import { orgUsageRemaining } from "@/server/services/billing/gating";
import type { TenantServiceContext } from "@/server/services/shared";
import type { WorkflowAction, WorkflowEventContext } from "@/server/services/workflow-engine/types";

/**
 * Abuse guard for PAID workflow actions (Task 5): a public form or an unverified inbound
 * event must not be able to trigger unbounded, billable outbound AI calls.
 *
 * A trigger is "unauthenticated-sourced" when it has no acting user AND its source is one
 * a stranger controls. Signed intake (HMAC) stamps `intake`, which is trusted and NOT in
 * this set, so intake-triggered automations are never throttled here.
 */
const UNAUTHENTICATED_SOURCES = new Set(["public_booking", "waitlist", "intake_unverified"]);

/** Feature key an operator can override to raise/lower the daily cap per org. */
export const PUBLIC_OUTBOUND_CALLS_DAILY_FEATURE = "public_outbound_calls_daily";
const DEFAULT_DAILY_CAP = 20;
const COOLDOWN_HOURS = 24;

export type PaidActionGuardReason = "guard:cooldown" | "guard:daily_cap" | "guard:usage_cap";

/**
 * A deliberate, expected refusal — NOT a crash. Its message is the reason string, so the
 * processor records it verbatim as the workflow run's `failure_reason` and surfaces it in
 * Automations (see processor.ts, which logs it at warn level rather than as an error).
 */
export class PaidActionGuardError extends Error {
  readonly reason: PaidActionGuardReason;
  constructor(reason: PaidActionGuardReason) {
    super(reason);
    this.name = "PaidActionGuardError";
    this.reason = reason;
  }
}

function asRecord(value: Json | null | undefined): Record<string, Json> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, Json>) : {};
}

function readString(value: Json | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Last 10 digits — the stable identity across +1 / formatting differences. */
function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : digits || null;
}

/**
 * The unauthenticated source of a trigger event, or null when the event is
 * authenticated (has an actor) or its source is trusted. Exported so the caller can tag
 * the resulting call for the daily-cap counter.
 */
export function unauthenticatedSource(eventContext: WorkflowEventContext): string | null {
  if (eventContext.activityEvent.actor_user_id !== null) {
    return null;
  }
  const source = readString(asRecord(eventContext.metadata)["source"]);
  return source && UNAUTHENTICATED_SOURCES.has(source) ? source : null;
}

async function resolveDailyCap(context: TenantServiceContext): Promise<number> {
  const { data, error } = await context.supabase
    .from("feature_flags")
    .select("limit_value")
    .eq("organization_id", context.organizationId)
    .eq("feature", PUBLIC_OUTBOUND_CALLS_DAILY_FEATURE)
    .maybeSingle();
  if (error) throw error;
  const limit = (data as { limit_value: number | null } | null)?.limit_value;
  return typeof limit === "number" && limit >= 0 ? limit : DEFAULT_DAILY_CAP;
}

/**
 * Refuse a paid outbound action when it originates from an unauthenticated source AND
 * either (a) the same phone already got an outbound call from this company in the last
 * 24h, or (b) the company has hit its daily cap of unauthenticated-sourced calls.
 * Authenticated/trusted triggers pass straight through.
 *
 * Throws PaidActionGuardError on refusal (recorded as the run's failure_reason). Query
 * errors propagate — for a billable action we fail CLOSED rather than risk spend during
 * a DB hiccup; the affected lead still exists and other automations still ran.
 *
 * `contactId` is the already-resolved target (passed by the caller to avoid re-deriving
 * the interpolated contact id here).
 */
export async function assertPaidActionAllowed(
  context: TenantServiceContext,
  eventContext: WorkflowEventContext,
  action: WorkflowAction,
  contactId: string | null,
): Promise<void> {
  // Usage cap (Task 6): an outbound paid call is refused once the month's metered
  // allowance (Front Desk voice minutes) is spent — regardless of trigger source.
  // Unlimited plans (or features with no cap) return null and pass.
  const remaining = await orgUsageRemaining(context.supabase, context.organizationId, "marina_reception");
  if (remaining !== null && remaining <= 0) {
    logRefusal("guard:usage_cap", action, context.organizationId, eventContext.companyId);
    throw new PaidActionGuardError("guard:usage_cap");
  }

  const source = unauthenticatedSource(eventContext);
  if (!source) {
    return; // authenticated or trusted — no further throttle
  }

  // The call targets the contact's company; fall back to the event's company.
  let companyId = eventContext.companyId;
  let targetPhone: string | null = null;
  if (contactId) {
    const { data, error } = await context.supabase
      .from("contacts")
      .select("phone, company_id")
      .eq("organization_id", context.organizationId)
      .eq("id", contactId)
      .maybeSingle();
    if (error) throw error;
    const contact = data as { phone: string | null; company_id: string | null } | null;
    if (contact) {
      targetPhone = contact.phone;
      companyId = contact.company_id ?? companyId;
    }
  }

  const sinceIso = new Date(Date.now() - COOLDOWN_HOURS * 60 * 60 * 1000).toISOString();

  // One read serves both checks: recent placed calls for this company.
  let query = context.supabase
    .from("activity_events")
    .select("metadata_json")
    .eq("organization_id", context.organizationId)
    .eq("event_type", "contact.call_placed")
    .gte("occurred_at", sinceIso)
    .order("occurred_at", { ascending: false })
    .limit(500);
  query = companyId ? query.eq("company_id", companyId) : query;

  const { data, error } = await query;
  if (error) throw error;
  const events = (data ?? []) as Array<{ metadata_json: Json }>;

  const targetLast10 = normalizePhone(targetPhone);
  let unauthenticatedCallCount = 0;
  for (const event of events) {
    const meta = asRecord(event.metadata_json);
    if (targetLast10 && normalizePhone(readString(meta["toNumber"])) === targetLast10) {
      logRefusal("guard:cooldown", action, context.organizationId, companyId);
      throw new PaidActionGuardError("guard:cooldown");
    }
    const triggerSource = readString(meta["triggerSource"]);
    if (triggerSource && UNAUTHENTICATED_SOURCES.has(triggerSource)) {
      unauthenticatedCallCount += 1;
    }
  }

  const cap = await resolveDailyCap(context);
  if (unauthenticatedCallCount >= cap) {
    logRefusal("guard:daily_cap", action, context.organizationId, companyId);
    throw new PaidActionGuardError("guard:daily_cap");
  }
}

function logRefusal(
  reason: PaidActionGuardReason,
  action: WorkflowAction,
  organizationId: string,
  companyId: string | null,
): void {
  // No PII (no phone / contact) — just the reason and the tenant it applies to.
  console.warn(
    `[paid-action-guard] blocked reason=${reason} action=${action.type} org=${organizationId} company=${companyId ?? "-"}`,
  );
}
