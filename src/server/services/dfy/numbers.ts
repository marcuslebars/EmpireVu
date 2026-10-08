// ─────────────────────────────────────────────────────────────────────────────
// SANCTIONED EXCEPTION (service role): done-for-you number purchase.
// Called from CrankLeads purchase provisioning (billing worker) right after the company
// exists, and retried by the done-for-you sweep (worker scheduler). Neither has a user
// session; the tenant is the purchase's own organization_id + company_id (never request
// input), and the work runs through the same tenant services the wizard routes use
// (provisionMissedCallCatcher / provisionPhoneForCompany) with a context pinned to that org.
// docs/done-for-you.md → "Automatic switch-on".
// ─────────────────────────────────────────────────────────────────────────────
import type { Json } from "@/server/db/database.types";
import type { CrankleadsTier } from "@/server/services/crankleads/config";
import type { AdminClient } from "@/server/services/crankleads/purchases";
import {
  claimOnce,
  ensureProgress,
  errorMessage,
  patchProgress,
  type DfyProgress,
} from "@/server/services/dfy/progress";
import { getOnboardingProgress, upsertOnboardingStep } from "@/server/services/onboarding";
import { provisionPhoneForCompany } from "@/server/services/onboarding-provision";
import type { RetellClient } from "@/server/services/retell/provision";
import type { TenantServiceContext } from "@/server/services/shared";
import { CATCHER_MODE } from "@/server/services/twilio/missed-call";
import { provisionMissedCallCatcher, type TwilioNumbersClient } from "@/server/services/twilio/provision";

/** Area code used when the checkout phone has none we can buy in (central/northern Ontario). */
export const FALLBACK_AREA_CODE = 705;
/** Give up (and flag for an operator) after this many failed purchases. */
export const NUMBER_MAX_ATTEMPTS = 5;
/** Wait before retry n (1-based attempts already made). */
export const NUMBER_RETRY_BACKOFF_MS = [0, 60_000, 5 * 60_000, 20 * 60_000, 60 * 60_000];

export type DfyNumberKind = "catcher" | "ai";

/** Catch / Close buy the missed-call text-back (catcher) number; Front Desk the AI receptionist's. */
export function numberKindForTier(tier: CrankleadsTier): DfyNumberKind {
  return tier === "front_desk" ? "ai" : "catcher";
}

const NON_GEOGRAPHIC = new Set([800, 833, 844, 855, 866, 877, 888, 900, 976, 600, 500, 700]);

/** The NPA of a NANP phone ("+1 (416) 555-0100" → 416), or the fallback. PURE. */
export function areaCodeFromPhone(raw: string | null | undefined): number {
  const digits = (raw ?? "").replace(/\D/g, "");
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (ten.length !== 10) return FALLBACK_AREA_CODE;
  const npa = Number(ten.slice(0, 3));
  if (!/^[2-9]\d[0-9]$/.test(ten.slice(0, 3)) || NON_GEOGRAPHIC.has(npa) || ten[1] === "9") return FALLBACK_AREA_CODE;
  return npa;
}

/**
 * Which area code to try on attempt n (1-based): the owner's own twice, then the fallback,
 * then any (Twilio/Retell pick) — a full area code shouldn't strand the buyer.
 */
export function areaCodeForAttempt(ownerAreaCode: number, attempt: number): number | null {
  if (attempt <= 2) return ownerAreaCode;
  if (attempt === 3 && ownerAreaCode !== FALLBACK_AREA_CODE) return FALLBACK_AREA_CODE;
  return attempt >= NUMBER_MAX_ATTEMPTS ? null : FALLBACK_AREA_CODE;
}

export interface DfyNumberDeps {
  twilio?: TwilioNumbersClient;
  retell?: RetellClient;
  /** Operator alert when the number is flagged (sent once). */
  alertOperator?: (input: { organizationId: string; companyId: string; error: string }) => Promise<void>;
  now?: () => number;
}

export interface EnsureNumberInput {
  organizationId: string;
  companyId: string;
  tier: CrankleadsTier;
  /** The phone the buyer gave at checkout (area code source). */
  ownerPhone: string | null;
}

export type EnsureNumberOutcome =
  | { status: "ready"; phoneNumber: string; purchasedNow: boolean }
  | { status: "failed"; error: string; attempts: number }
  | { status: "waiting"; attempts: number }
  | { status: "flagged"; error: string | null };

/** The company's active number of this kind, if any (E.164). */
export async function currentNumber(ctx: TenantServiceContext, companyId: string, kind: DfyNumberKind): Promise<string | null> {
  let query = ctx.supabase
    .from("voice_numbers")
    .select("phone_e164, mode, provider")
    .eq("organization_id", ctx.organizationId)
    .eq("company_id", companyId)
    .eq("active", true);
  query = kind === "catcher" ? query.eq("provider", "twilio").eq("mode", CATCHER_MODE) : query.eq("mode", "ai_receptionist");
  const { data, error } = await query.limit(1);
  if (error) throw new Error(`voice number lookup failed: ${error.message}`);
  return ((data ?? []) as Array<{ phone_e164: string }>)[0]?.phone_e164 ?? null;
}

function objectData(value: Json | null | undefined): Record<string, Json | undefined> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, Json | undefined>) : {};
}

/** Buy (or re-find) the number and record the wizard's Phone step exactly like the org routes do. */
async function purchase(
  ctx: TenantServiceContext,
  companyId: string,
  kind: DfyNumberKind,
  areaCode: number | null,
  deps: DfyNumberDeps,
): Promise<string> {
  const progress = await getOnboardingProgress(ctx, companyId);
  const prior = objectData(progress.find((p) => p.step === "phone")?.data);
  if (kind === "catcher") {
    const result = await provisionMissedCallCatcher(ctx, { companyId, areaCode }, deps.twilio ? { client: deps.twilio } : {});
    await upsertOnboardingStep(ctx, companyId, "phone", {
      completed: true,
      data: {
        ...prior,
        mode: CATCHER_MODE,
        phoneNumber: result.phoneNumber,
        catcherNumber: result.phoneNumber,
        catcherNumberSid: result.numberSid,
        source: "done_for_you",
      },
    });
    return result.phoneNumber;
  }
  const result = await provisionPhoneForCompany(
    ctx,
    {
      companyId,
      areaCode,
      existing: {
        llmId: typeof prior.llmId === "string" ? prior.llmId : null,
        agentId: typeof prior.agentId === "string" ? prior.agentId : null,
        phoneNumber: typeof prior.phoneNumber === "string" ? prior.phoneNumber : null,
      },
    },
    deps.retell,
  );
  await upsertOnboardingStep(ctx, companyId, "phone", {
    completed: true,
    data: { ...prior, llmId: result.llmId, agentId: result.agentId, phoneNumber: result.phoneNumber, source: "done_for_you" },
  });
  return result.phoneNumber;
}

/**
 * Make sure the company has the number its tier needs. NEVER throws: a failure is recorded on
 * dfy_progress (attempts, last error) for the sweep to retry with backoff; after
 * NUMBER_MAX_ATTEMPTS it is flagged for an operator (number_flagged_at + one alert).
 * Idempotent: an existing active number is just recorded as ready; Twilio purchases are
 * crash-safe (FriendlyName tag) and Retell re-runs update the ids stored on the Phone step.
 */
export async function ensureDfyNumber(
  admin: AdminClient,
  input: EnsureNumberInput,
  deps: DfyNumberDeps = {},
): Promise<EnsureNumberOutcome> {
  const now = deps.now?.() ?? Date.now();
  const nowIso = new Date(now).toISOString();
  const kind = numberKindForTier(input.tier);
  const ctx: TenantServiceContext = { organizationId: input.organizationId, actorProfileId: null, supabase: admin };
  let row: DfyProgress;
  try {
    row = await ensureProgress(admin, input.organizationId, input.companyId);
    const existing = await currentNumber(ctx, input.companyId, kind);
    if (existing) {
      if (!row.number_ready_at || row.number_last_error) {
        await patchProgress(admin, row, { number_ready_at: row.number_ready_at ?? nowIso, number_last_error: null });
      }
      return { status: "ready", phoneNumber: existing, purchasedNow: false };
    }
  } catch (err) {
    console.error(`[dfy/number] state read failed for company ${input.companyId}: ${errorMessage(err)}`);
    return { status: "failed", error: errorMessage(err), attempts: 0 };
  }

  if (row.number_flagged_at) return { status: "flagged", error: row.number_last_error };
  const attempts = row.number_attempts ?? 0;
  const lastAttempt = row.number_last_attempt_at ? Date.parse(row.number_last_attempt_at) : null;
  const wait = NUMBER_RETRY_BACKOFF_MS[Math.min(attempts, NUMBER_RETRY_BACKOFF_MS.length - 1)] ?? 0;
  if (lastAttempt !== null && now - lastAttempt < wait) return { status: "waiting", attempts };

  const attempt = attempts + 1;
  try {
    // Claim the attempt (guarded on the count we read, so two workers never buy at once).
    const { data: claimed, error } = await admin
      .from("dfy_progress")
      .update({ number_attempts: attempt, number_last_attempt_at: nowIso })
      .eq("organization_id", row.organization_id)
      .eq("company_id", row.company_id)
      .eq("number_attempts", attempts)
      .select("company_id");
    if (error) throw new Error(`attempt claim failed: ${error.message}`);
    if ((claimed ?? []).length === 0) return { status: "waiting", attempts };
  } catch (err) {
    console.error(`[dfy/number] ${errorMessage(err)}`);
    return { status: "failed", error: errorMessage(err), attempts };
  }

  const areaCode = areaCodeForAttempt(areaCodeFromPhone(input.ownerPhone), attempt);
  try {
    const phoneNumber = await purchase(ctx, input.companyId, kind, areaCode, deps);
    await patchProgress(admin, row, { number_ready_at: nowIso, number_last_error: null });
    console.log(`[dfy/number] ${kind} number ready for company ${input.companyId} (attempt ${attempt}, area ${areaCode ?? "any"})`);
    return { status: "ready", phoneNumber, purchasedNow: true };
  } catch (err) {
    const message = errorMessage(err).slice(0, 500);
    console.error(`[dfy/number] ${kind} number attempt ${attempt} failed for company ${input.companyId}: ${message}`);
    try {
      await patchProgress(admin, row, { number_last_error: message });
      if (attempt >= NUMBER_MAX_ATTEMPTS && (await claimOnce(admin, row, "number_flagged_at", nowIso))) {
        await deps.alertOperator?.({ organizationId: input.organizationId, companyId: input.companyId, error: message });
      }
    } catch (recordErr) {
      console.error(`[dfy/number] could not record the failure: ${errorMessage(recordErr)}`);
    }
    return { status: "failed", error: message, attempts: attempt };
  }
}
