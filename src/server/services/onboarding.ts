import type { Json, Tables } from "@/server/db/database.types";
import type { TenantServiceContext } from "@/server/services/shared";

/**
 * Onboarding wizard state + instrumentation (Task 13). Progress is one row per
 * (company, step) so the wizard is resumable from /onboarding; every step start/complete/
 * error is appended to onboarding_events for the funnel + time-to-complete ops report.
 */

export const ONBOARDING_STEPS = [
  "business",
  "services",
  "phone",
  "payments",
  "website",
  "test_call",
  "team",
  "recipes",
] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];
export type OnboardingStatus = "pending" | "in_progress" | "complete" | "error";
export type OnboardingEventType = "start" | "complete" | "error";

export function isOnboardingStep(value: string): value is OnboardingStep {
  return (ONBOARDING_STEPS as readonly string[]).includes(value);
}

/** The step to resume at: the first not-yet-complete step (the last step once all are done). */
export function nextOnboardingStep(completedSteps: readonly string[]): OnboardingStep {
  const done = new Set(completedSteps);
  return ONBOARDING_STEPS.find((step) => !done.has(step)) ?? ONBOARDING_STEPS[ONBOARDING_STEPS.length - 1];
}

export async function getOnboardingProgress(
  context: TenantServiceContext,
  companyId: string,
): Promise<Tables<"onboarding_progress">[]> {
  const { data, error } = await context.supabase
    .from("onboarding_progress")
    .select("*")
    .eq("organization_id", context.organizationId)
    .eq("company_id", companyId);
  if (error) throw error;
  return (data ?? []) as Tables<"onboarding_progress">[];
}

export interface UpsertStepInput {
  status?: OnboardingStatus;
  data?: Json;
  completed?: boolean;
}

export async function upsertOnboardingStep(
  context: TenantServiceContext,
  companyId: string,
  step: OnboardingStep,
  input: UpsertStepInput,
): Promise<Tables<"onboarding_progress">> {
  const now = new Date().toISOString();
  const status: OnboardingStatus = input.status ?? (input.completed ? "complete" : "in_progress");
  const row = {
    organization_id: context.organizationId,
    company_id: companyId,
    step,
    status,
    ...(input.data !== undefined ? { data: input.data } : {}),
    completed_at: status === "complete" ? now : null,
    updated_at: now,
  };
  const { data, error } = await context.supabase
    .from("onboarding_progress")
    .upsert(row, { onConflict: "organization_id,company_id,step" })
    .select("*")
    .single();
  if (error) throw error;
  return data as Tables<"onboarding_progress">;
}

export interface RecordOnboardingEventInput {
  companyId: string | null;
  step: OnboardingStep;
  event: OnboardingEventType;
  metadata?: Record<string, unknown>;
}

/** Append an instrumentation event. Best-effort — never fail a step because logging failed. */
export async function recordOnboardingEvent(
  context: TenantServiceContext,
  input: RecordOnboardingEventInput,
): Promise<void> {
  try {
    const { error } = await context.supabase.from("onboarding_events").insert({
      organization_id: context.organizationId,
      company_id: input.companyId,
      step: input.step,
      event: input.event,
      metadata: (input.metadata ?? {}) as Json,
    });
    if (error) throw error;
  } catch (err) {
    console.error(`[onboarding] event log failed (${input.step}/${input.event}):`, err instanceof Error ? err.message : err);
  }
}

/**
 * Run a step action with start/complete/error instrumentation around it. Returns the
 * action's result; on throw, records an error event (with the message) and re-throws.
 */
export async function withStepInstrumentation<T>(
  context: TenantServiceContext,
  args: { companyId: string | null; step: OnboardingStep },
  action: () => Promise<T>,
): Promise<T> {
  await recordOnboardingEvent(context, { ...args, event: "start" });
  try {
    const result = await action();
    await recordOnboardingEvent(context, { ...args, event: "complete" });
    return result;
  } catch (err) {
    await recordOnboardingEvent(context, {
      ...args,
      event: "error",
      metadata: { message: err instanceof Error ? err.message : String(err) },
    });
    throw err;
  }
}
