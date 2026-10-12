/**
 * Plan templates (service_plans): what the owner sells. Read by the public page, the SMS agent's
 * offer_service_plan and the owner tools; written only from Settings (owners/admins, through the
 * route → service role, always scoped by organization + company).
 */
import { z } from "zod";

import type { AdminClient } from "@/server/services/front-desk/contracts";
import type { Db, ServicePlanRow } from "./db-types";
import { cleanMonths, type PlanSchedule } from "./schedule";

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** No links, prices or deal words in names / included lines (they're shown to customers as written). */
const plainText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((v) => !/https?:|www\.|<|>/i.test(v), "Links and angle brackets aren't allowed here.");

export const planInputSchema = z
  .object({
    name: plainText(80).pipe(z.string().min(2, "Give the plan a name.")),
    description: plainText(1000).nullable().optional(),
    priceCents: z.number().int().min(100, "The price must be at least $1.").max(10_000_000, "That price is too high."),
    billing: z.enum(["annual", "per_visit"]),
    months: z.array(z.number().int().min(1).max(12)).min(1, "Pick at least one visit month.").max(12),
    weekday: z.number().int().min(0).max(6).optional(),
    week: z.number().int().min(1).max(4).optional(),
    timeOfDay: z.string().regex(HHMM, "Use a 24-hour HH:MM time.").optional(),
    durationMinutes: z.number().int().min(15).max(720).optional(),
    included: z.array(plainText(120).pipe(z.string().min(1))).max(10).optional(),
    active: z.boolean().optional(),
  })
  .strict();

export type PlanInput = z.infer<typeof planInputSchema>;
export const planPatchSchema = planInputSchema.partial().strict();
export type PlanPatch = z.infer<typeof planPatchSchema>;

export function includedOf(row: Pick<ServicePlanRow, "included">): string[] {
  return Array.isArray(row.included) ? (row.included as unknown[]).filter((v): v is string => typeof v === "string" && v.trim().length > 0).slice(0, 10) : [];
}

export function planSchedule(row: Pick<ServicePlanRow, "visit_months" | "weekday" | "week_of_month">): PlanSchedule {
  return { months: cleanMonths(row.visit_months), weekday: row.weekday ?? 1, week: row.week_of_month ?? 1 };
}

function toRow(input: PlanPatch): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (input.name !== undefined) row.name = input.name;
  if (input.description !== undefined) row.description = input.description?.trim() || null;
  if (input.priceCents !== undefined) row.price_cents = input.priceCents;
  if (input.billing !== undefined) row.billing = input.billing;
  if (input.months !== undefined) row.visit_months = cleanMonths(input.months);
  if (input.weekday !== undefined) row.weekday = input.weekday;
  if (input.week !== undefined) row.week_of_month = input.week;
  if (input.timeOfDay !== undefined) row.time_of_day = input.timeOfDay;
  if (input.durationMinutes !== undefined) row.duration_minutes = input.durationMinutes;
  if (input.included !== undefined) row.included = input.included.map((s) => s.trim()).filter(Boolean);
  if (input.active !== undefined) row.active = input.active;
  return row;
}

export async function listPlans(admin: AdminClient, scope: { organizationId: string; companyId: string }, options: { activeOnly?: boolean } = {}): Promise<ServicePlanRow[]> {
  let q = (admin as Db).from("service_plans").select("*").eq("organization_id", scope.organizationId).eq("company_id", scope.companyId);
  if (options.activeOnly) q = q.eq("active", true);
  const { data, error } = await q.order("created_at", { ascending: true }).limit(100);
  if (error) throw error;
  return (data ?? []) as ServicePlanRow[];
}

export async function loadPlan(admin: AdminClient, scope: { organizationId: string; companyId: string }, planId: string): Promise<ServicePlanRow | null> {
  if (!planId) return null;
  const { data, error } = await (admin as Db)
    .from("service_plans")
    .select("*")
    .eq("organization_id", scope.organizationId)
    .eq("company_id", scope.companyId)
    .eq("id", planId)
    .maybeSingle();
  if (error) throw error;
  return (data as ServicePlanRow | null) ?? null;
}

export async function createPlan(admin: AdminClient, scope: { organizationId: string; companyId: string }, input: PlanInput, actorProfileId: string | null): Promise<ServicePlanRow> {
  const { data, error } = await (admin as Db)
    .from("service_plans")
    .insert({
      organization_id: scope.organizationId,
      company_id: scope.companyId,
      weekday: 1,
      week_of_month: 1,
      time_of_day: "09:00",
      duration_minutes: 60,
      included: [],
      active: true,
      ...toRow(input),
      created_by: actorProfileId,
    })
    .select("*")
    .single();
  if (error) throw error;
  return data as ServicePlanRow;
}

/** Edits apply to new sign-ups and renewals; agreements already running keep what they agreed to. */
export async function updatePlan(admin: AdminClient, scope: { organizationId: string; companyId: string }, planId: string, patch: PlanPatch): Promise<ServicePlanRow | null> {
  const row = toRow(patch);
  if (Object.keys(row).length === 0) return loadPlan(admin, scope, planId);
  const { data, error } = await (admin as Db)
    .from("service_plans")
    .update(row)
    .eq("organization_id", scope.organizationId)
    .eq("company_id", scope.companyId)
    .eq("id", planId)
    .select("*");
  if (error) throw error;
  return (((data ?? []) as ServicePlanRow[])[0] ?? null);
}

/** Owner words ("lawn plan", "spring fall") → the active plans that match. */
export function matchPlans(plans: ServicePlanRow[], words: string | null | undefined): ServicePlanRow[] {
  const active = plans.filter((p) => p.active);
  const tokens = (words ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1 && !["plan", "the", "and"].includes(t));
  if (tokens.length === 0) return active.length === 1 ? active : [];
  const exact = active.filter((p) => p.name.toLowerCase() === (words ?? "").trim().toLowerCase());
  if (exact.length) return exact;
  return active.filter((p) => tokens.every((t) => p.name.toLowerCase().includes(t)));
}
