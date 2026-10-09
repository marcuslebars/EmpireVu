/**
 * Monthly AI call-minute accounting (docs/front-desk-ai.md → "## Phone answering").
 *
 * Every Retell call is metered once as a `voice_minutes` usage event (lead-adapter →
 * recordUsage, idempotent on the Retell call id), with the company id. The allowance is:
 *
 *   • Front Desk (plan includes marina_reception): the plan's monthly allowance (500, or a
 *     feature_flags override) — ORG-wide, exactly what requireFeature('marina_reception') and the
 *     outbound-call guard already count, so the two never disagree.
 *   • Catch / Close (and house orgs that opt in): ai_settings.call_answering.included_minutes
 *     (default 100) — per COMPANY.
 *   • internal / house plans with marina_reception: unlimited (null), as everywhere else.
 *
 * Months are America/Toronto calendar months (usage_monthly_v).
 */
import { orgCan, orgLimit } from "@/server/services/billing/gating";
import { torontoMonthStart } from "@/server/services/usage";
import type { createSupabaseAdminClient } from "@/server/supabase/admin";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;
// gating.ts is typed against the RLS server client; the admin client is structurally the same.
type GatingClient = Parameters<typeof orgLimit>[0];

export interface MinuteAllowance {
  /** Whose minutes count against it. */
  scope: "company" | "organization";
  /** Which allowance applies (the Front Desk plan's, or the call-answering setting). */
  source: "marina_reception" | "call_answering";
  /** null = unlimited. */
  includedMinutes: number | null;
  usedMinutes: number;
  /** null = unlimited; may be negative (a long call crossed the line). */
  remainingMinutes: number | null;
  /** 'YYYY-MM-01' (Toronto). */
  month: string;
}

async function sumVoiceMinutes(
  admin: AdminClient,
  filter: { organizationId: string; companyId?: string },
  month: string,
): Promise<number> {
  let query = admin
    .from("usage_monthly_v")
    .select("quantity, company_id")
    .eq("organization_id", filter.organizationId)
    .eq("month", month)
    .eq("kind", "voice_minutes");
  if (filter.companyId) query = query.eq("company_id", filter.companyId);
  const { data, error } = await query;
  if (error) throw error;
  const rows = (data ?? []) as Array<{ quantity: number | null }>;
  return rows.reduce((sum, row) => sum + Number(row.quantity ?? 0), 0);
}

/**
 * Does this org's plan carry the Front Desk receptionist allowance? (marina_reception is on
 * front_desk and internal plans only.) House/internal orgs answer true here, but their limit is
 * null (unlimited) — see loadMinuteAllowance.
 */
export async function hasReceptionistPlan(admin: AdminClient, organizationId: string): Promise<boolean> {
  return orgCan(admin as unknown as GatingClient, organizationId, "marina_reception");
}

export async function loadMinuteAllowance(
  admin: AdminClient,
  input: {
    organizationId: string;
    companyId: string;
    /** organizations.crankleads_tier (null for house orgs). */
    tier: string | null;
    plan: string | null;
    /** ai_settings.call_answering.included_minutes (with default). */
    includedMinutes: number;
  },
  now: Date = new Date(),
): Promise<MinuteAllowance> {
  const month = torontoMonthStart(now);
  const frontDesk = input.tier === "front_desk" || input.plan === "front_desk";
  if (frontDesk) {
    const limit = await orgLimit(admin as unknown as GatingClient, input.organizationId, "marina_reception");
    const used = await sumVoiceMinutes(admin, { organizationId: input.organizationId }, month);
    return {
      scope: "organization",
      source: "marina_reception",
      includedMinutes: limit,
      usedMinutes: roundMinutes(used),
      remainingMinutes: limit === null ? null : roundMinutes(limit - used),
      month,
    };
  }
  const used = await sumVoiceMinutes(admin, { organizationId: input.organizationId, companyId: input.companyId }, month);
  return {
    scope: "company",
    source: "call_answering",
    includedMinutes: input.includedMinutes,
    usedMinutes: roundMinutes(used),
    remainingMinutes: roundMinutes(input.includedMinutes - used),
    month,
  };
}

function roundMinutes(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Longest single AI-answered call (seconds), capped by what is left this month. */
export const MAX_AI_CALL_SECONDS = 15 * 60;
export const MIN_AI_CALL_SECONDS = 60;

export function aiCallTimeLimitSeconds(remainingMinutes: number | null): number {
  if (remainingMinutes === null) return MAX_AI_CALL_SECONDS;
  const seconds = Math.floor(remainingMinutes * 60);
  return Math.max(MIN_AI_CALL_SECONDS, Math.min(MAX_AI_CALL_SECONDS, seconds));
}

/** "October" — the month name in the owner notice. */
export function monthName(monthStart: string): string {
  const [year, month] = monthStart.split("-").map((part) => Number(part));
  return new Intl.DateTimeFormat("en-CA", { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(year, (month || 1) - 1, 15)));
}
