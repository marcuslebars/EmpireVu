/**
 * Recurring jobs. A series (recurring_jobs) describes repeat work; each visit is an
 * ordinary booking tagged with recurring_job_id + occurrence_date, so the calendar,
 * My Jobs, reminders, crew alerts and job-done → invoice all work unchanged.
 *
 * Visits are created ~60 days ahead (always at least the next one, for monthly/yearly
 * work): immediately when the series is saved, then by the daily sweep (sweep.ts).
 * Generation is idempotent on (recurring_job_id, occurrence_date).
 *
 * Generated visits do NOT fire booking.created — a new weekly series would otherwise
 * send a pile of "you're booked" texts. booking.upcoming reminders still go out per visit.
 */
import { z } from "zod";

import type { Json, Tables } from "@/server/db/database.types";
import { ValidationError } from "@/server/organizations/context";
import { localDate, zonedInstant } from "@/server/services/booking-windows";
import { cleanChecklistLabels } from "@/server/services/crew/logic";
import { assertCompanyInOrganization, assertContactInOrganization, type TenantServiceContext } from "@/server/services/shared";
import { addDaysYmd, describeRule, nextOccurrence, occurrencesBetween, type RecurrenceRule } from "./rule";

type Series = Tables<"recurring_jobs">;

export const HORIZON_DAYS = 60;
/** Never create more than this many visits in one pass (daily cleaning for 60 days is 60). */
const MAX_PER_PASS = 120;

export class RecurringNotFoundError extends ValidationError {
  constructor(message = "Recurring job not found.") {
    super(message);
    this.name = "RecurringNotFoundError";
  }
}

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date.");
const lineSchema = z.object({
  label: z.string().trim().min(1, "Every price line needs a description.").max(300),
  quantity: z.number().positive().max(100_000),
  unitPriceCents: z.number().int().min(-100_000_000).max(100_000_000),
});

export const recurringJobSchema = z
  .object({
    companyId: z.string().uuid(),
    contactId: z.string().uuid().nullable().optional(),
    title: z.string().trim().min(1, "Give the job a name.").max(200),
    description: z.string().trim().max(4000).nullable().optional(),
    location: z.string().trim().max(300).nullable().optional(),
    durationMinutes: z.number().int().min(5).max(1440),
    frequency: z.enum(["weekly", "monthly", "yearly"]),
    interval: z.number().int().min(1).max(52),
    weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
    startDate: ymd,
    timeOfDay: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a 24-hour HH:MM time."),
    endsOn: ymd.nullable().optional(),
    maxOccurrences: z.number().int().min(1).max(1000).nullable().optional(),
    crewProfileIds: z.array(z.string().uuid()).max(20).optional(),
    checklistTemplateId: z.string().uuid().nullable().optional(),
    lineItems: z.array(lineSchema).max(50).optional(),
  })
  .refine((v) => !v.endsOn || v.endsOn >= v.startDate, { message: "The end date is before the start date.", path: ["endsOn"] });

export type RecurringJobInput = z.infer<typeof recurringJobSchema>;

export function ruleOf(s: Pick<Series, "frequency" | "interval_count" | "weekdays" | "start_date" | "ends_on" | "max_occurrences">): RecurrenceRule {
  return {
    frequency: s.frequency,
    interval: s.interval_count,
    weekdays: s.weekdays ?? [],
    startDate: s.start_date,
    endsOn: s.ends_on,
    maxOccurrences: s.max_occurrences,
  };
}

interface LineItem {
  label: string;
  quantity: number;
  unitPriceCents: number;
}

export function readLineItems(raw: Json | unknown): LineItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((l) => lineSchema.safeParse(l))
    .filter((r): r is z.SafeParseSuccess<LineItem> => r.success)
    .map((r) => r.data);
}

export function priceOf(lines: LineItem[]): number {
  return lines.reduce((sum, l) => sum + Math.round(l.quantity * l.unitPriceCents), 0);
}

// ── Loading ──────────────────────────────────────────────────────────────────

async function loadSeries(ctx: TenantServiceContext, id: string): Promise<Series> {
  const { data, error } = await ctx.supabase.from("recurring_jobs").select("*").eq("organization_id", ctx.organizationId).eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data) throw new RecurringNotFoundError();
  return data as Series;
}

async function companyZone(ctx: TenantServiceContext, companyId: string): Promise<string> {
  const { data } = await ctx.supabase.from("companies").select("timezone").eq("organization_id", ctx.organizationId).eq("id", companyId).maybeSingle();
  return data?.timezone || process.env.BUSINESS_TIMEZONE?.trim() || "America/Toronto";
}

/** Keep only people who are still on the team. */
async function currentCrew(ctx: TenantServiceContext, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const { data, error } = await ctx.supabase
    .from("organization_memberships")
    .select("profile_id")
    .eq("organization_id", ctx.organizationId)
    .in("profile_id", ids);
  if (error) throw error;
  const ok = new Set((data ?? []).map((m) => m.profile_id));
  return ids.filter((id) => ok.has(id));
}

// ── Generating visits ────────────────────────────────────────────────────────

/** Which dates to have visits for, as of `today` in the brand's zone. */
export function datesToGenerate(rule: RecurrenceRule, today: string, horizonDays = HORIZON_DAYS): { dates: string[]; through: string } {
  const from = rule.startDate > today ? rule.startDate : today;
  let to = addDaysYmd(today, horizonDays);
  let dates = occurrencesBetween(rule, from, to, MAX_PER_PASS);
  if (dates.length === 0) {
    // Monthly/yearly work: always have the next visit on the calendar.
    const next = nextOccurrence(rule, from);
    if (next) {
      to = next;
      dates = [next];
    }
  }
  return { dates, through: to };
}

/**
 * Create the missing visits for a series. Safe to call any number of times.
 * Returns the ids of the bookings it created.
 */
export async function generateVisits(ctx: TenantServiceContext, series: Series, now: Date = new Date()): Promise<string[]> {
  if (series.status !== "active") return [];
  const tz = await companyZone(ctx, series.company_id);
  const today = localDate(now, tz);
  const { dates, through } = datesToGenerate(ruleOf(series), today);

  let created: Array<{ id: string; occurrence_date: string | null }> = [];
  if (dates.length) {
    const rows = dates
      .map((date) => ({ date, at: zonedInstant(date, series.time_of_day, tz) }))
      .filter(({ at }) => at.getTime() > now.getTime()) // today's visit already passed → skip it
      .map(({ date, at }) => ({
        organization_id: ctx.organizationId,
        company_id: series.company_id,
        contact_id: series.contact_id,
        title: series.title,
        description: series.description,
        location: series.location,
        duration_minutes: series.duration_minutes,
        scheduled_for: at.toISOString(),
        status: "confirmed" as const,
        source: "recurring",
        created_by: series.created_by,
        recurring_job_id: series.id,
        occurrence_date: date,
        recurrence_exception: false,
      }));
    if (rows.length) {
      const { data, error } = await ctx.supabase
        .from("bookings")
        .upsert(rows, { onConflict: "recurring_job_id,occurrence_date", ignoreDuplicates: true })
        .select("id, occurrence_date");
      if (error) throw error;
      created = (data ?? []) as typeof created;
    }
  }

  if (created.length) {
    const crew = await currentCrew(ctx, series.crew_profile_ids ?? []);
    if (crew.length) {
      const { error } = await ctx.supabase.from("booking_assignments").upsert(
        created.flatMap((b) =>
          crew.map((profileId) => ({ organization_id: ctx.organizationId, booking_id: b.id, profile_id: profileId, assigned_by: series.created_by })),
        ),
        { onConflict: "booking_id,profile_id", ignoreDuplicates: true },
      );
      if (error) throw error;
    }
    if (series.checklist_template_id) {
      const { data: template } = await ctx.supabase
        .from("checklist_templates")
        .select("items, company_id")
        .eq("organization_id", ctx.organizationId)
        .eq("id", series.checklist_template_id)
        .maybeSingle();
      const labels = template && template.company_id === series.company_id ? cleanChecklistLabels(Array.isArray(template.items) ? template.items : []) : [];
      if (labels.length) {
        const { error } = await ctx.supabase.from("booking_checklist_items").insert(
          created.flatMap((b) =>
            labels.map((label, position) => ({ organization_id: ctx.organizationId, booking_id: b.id, label, position, created_by: series.created_by })),
          ),
        );
        if (error) throw error;
      }
    }
  }

  await ctx.supabase.from("recurring_jobs").update({ generated_through: through }).eq("organization_id", ctx.organizationId).eq("id", series.id);
  return created.map((b) => b.id);
}

/**
 * Remove upcoming visits nobody has touched, so a changed or paused series can be
 * re-laid. Keeps: anything moved by hand, started, on the way, done or cancelled.
 */
export async function clearUntouchedFutureVisits(ctx: TenantServiceContext, seriesId: string, now: Date = new Date()): Promise<number> {
  const { data, error } = await ctx.supabase
    .from("bookings")
    .delete()
    .eq("organization_id", ctx.organizationId)
    .eq("recurring_job_id", seriesId)
    .eq("recurrence_exception", false)
    .in("status", ["pending", "confirmed"])
    .is("en_route_at", null)
    .is("started_at", null)
    .gt("scheduled_for", now.toISOString())
    .select("id");
  if (error) throw error;
  return (data ?? []).length;
}

// ── Writing ──────────────────────────────────────────────────────────────────

function toRow(input: RecurringJobInput) {
  const weekly = input.frequency === "weekly";
  return {
    company_id: input.companyId,
    contact_id: input.contactId ?? null,
    title: input.title,
    description: input.description || null,
    location: input.location || null,
    duration_minutes: input.durationMinutes,
    frequency: input.frequency,
    interval_count: input.interval,
    weekdays: weekly ? [...new Set(input.weekdays ?? [])].sort() : [],
    start_date: input.startDate,
    time_of_day: input.timeOfDay,
    ends_on: input.endsOn ?? null,
    max_occurrences: input.endsOn ? null : (input.maxOccurrences ?? null),
    crew_profile_ids: [...new Set(input.crewProfileIds ?? [])],
    checklist_template_id: input.checklistTemplateId ?? null,
    line_items: (input.lineItems ?? []) as unknown as Json,
  };
}

async function assertInputs(ctx: TenantServiceContext, input: RecurringJobInput): Promise<void> {
  await assertCompanyInOrganization(ctx, input.companyId);
  await assertContactInOrganization(ctx, input.contactId ?? undefined);
  const crew = [...new Set(input.crewProfileIds ?? [])];
  if (crew.length && (await currentCrew(ctx, crew)).length !== crew.length) {
    throw new ValidationError("Only people on your team can be the crew.");
  }
  if (input.checklistTemplateId) {
    const { data } = await ctx.supabase
      .from("checklist_templates")
      .select("company_id")
      .eq("organization_id", ctx.organizationId)
      .eq("id", input.checklistTemplateId)
      .maybeSingle();
    if (!data || data.company_id !== input.companyId) throw new ValidationError("That checklist belongs to another company.");
  }
}

export async function createRecurringJob(ctx: TenantServiceContext, input: RecurringJobInput, now: Date = new Date()): Promise<{ series: Series; visitsCreated: number }> {
  await assertInputs(ctx, input);
  const { data, error } = await ctx.supabase
    .from("recurring_jobs")
    .insert({ ...toRow(input), organization_id: ctx.organizationId, created_by: ctx.actorProfileId, status: "active" })
    .select("*")
    .single();
  if (error) throw error;
  const series = data as Series;
  const ids = await generateVisits(ctx, series, now);
  return { series, visitsCreated: ids.length };
}

/** Edit the series. Upcoming untouched visits are re-laid from the new rule. */
export async function updateRecurringJob(
  ctx: TenantServiceContext,
  id: string,
  input: RecurringJobInput,
  now: Date = new Date(),
): Promise<{ series: Series; visitsCreated: number; visitsRemoved: number }> {
  const existing = await loadSeries(ctx, id);
  if (existing.company_id !== input.companyId) throw new ValidationError("A recurring job can't move to another company.");
  await assertInputs(ctx, input);
  const { data, error } = await ctx.supabase
    .from("recurring_jobs")
    .update({ ...toRow(input), generated_through: null })
    .eq("organization_id", ctx.organizationId)
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;
  const series = data as Series;
  const visitsRemoved = await clearUntouchedFutureVisits(ctx, id, now);
  const ids = await generateVisits(ctx, series, now);
  return { series, visitsCreated: ids.length, visitsRemoved };
}

/** Pause or end: upcoming untouched visits come off the calendar. Resume: they go back on. */
export async function setRecurringStatus(
  ctx: TenantServiceContext,
  id: string,
  status: "active" | "paused" | "ended",
  now: Date = new Date(),
): Promise<{ series: Series; visitsCreated: number; visitsRemoved: number }> {
  const existing = await loadSeries(ctx, id);
  if (existing.status === "ended" && status !== "ended") throw new ValidationError("This recurring job has ended. Create a new one instead.");
  const { data, error } = await ctx.supabase
    .from("recurring_jobs")
    .update({ status, generated_through: null })
    .eq("organization_id", ctx.organizationId)
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;
  const series = data as Series;
  let visitsRemoved = 0;
  let visitsCreated = 0;
  if (status === "active") visitsCreated = (await generateVisits(ctx, series, now)).length;
  else visitsRemoved = await clearUntouchedFutureVisits(ctx, id, now);
  return { series, visitsCreated, visitsRemoved };
}

// ── Reading ──────────────────────────────────────────────────────────────────

export interface RecurringJobView {
  id: string;
  companyId: string;
  contactId: string | null;
  contactName: string | null;
  title: string;
  description: string | null;
  location: string | null;
  durationMinutes: number;
  frequency: Series["frequency"];
  interval: number;
  weekdays: number[];
  startDate: string;
  timeOfDay: string;
  endsOn: string | null;
  maxOccurrences: number | null;
  crewProfileIds: string[];
  crewNames: string[];
  checklistTemplateId: string | null;
  lineItems: LineItem[];
  priceCents: number;
  status: Series["status"];
  ruleText: string;
  nextVisitAt: string | null;
  upcomingCount: number;
  completedCount: number;
}

async function hydrate(ctx: TenantServiceContext, rows: Series[], now: Date): Promise<RecurringJobView[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const contactIds = [...new Set(rows.map((r) => r.contact_id).filter((v): v is string => !!v))];
  const crewIds = [...new Set(rows.flatMap((r) => r.crew_profile_ids ?? []))];
  const [visits, contacts, people] = await Promise.all([
    ctx.supabase
      .from("bookings")
      .select("recurring_job_id, scheduled_for, status")
      .eq("organization_id", ctx.organizationId)
      .in("recurring_job_id", ids),
    contactIds.length
      ? ctx.supabase.from("contacts").select("id, first_name, last_name").eq("organization_id", ctx.organizationId).in("id", contactIds)
      : Promise.resolve({ data: [], error: null }),
    crewIds.length ? ctx.supabase.from("profiles").select("id, full_name, email").in("id", crewIds) : Promise.resolve({ data: [], error: null }),
  ]);
  for (const r of [visits, contacts, people]) if (r.error) throw r.error;

  const nowIso = now.toISOString();
  const byId = new Map(rows.map((r) => [r.id, { next: null as string | null, upcoming: 0, done: 0 }]));
  for (const v of visits.data ?? []) {
    const agg = v.recurring_job_id ? byId.get(v.recurring_job_id) : undefined;
    if (!agg) continue;
    if (v.status === "completed") agg.done += 1;
    else if ((v.status === "pending" || v.status === "confirmed") && v.scheduled_for > nowIso) {
      agg.upcoming += 1;
      if (!agg.next || v.scheduled_for < agg.next) agg.next = v.scheduled_for;
    }
  }
  const contactName = new Map((contacts.data ?? []).map((c) => [c.id, [c.first_name, c.last_name].filter(Boolean).join(" ").trim() || null]));
  const personName = new Map((people.data ?? []).map((p) => [p.id, p.full_name?.trim() || p.email || "Team member"]));

  return rows.map((r) => {
    const lines = readLineItems(r.line_items);
    const agg = byId.get(r.id)!;
    return {
      id: r.id,
      companyId: r.company_id,
      contactId: r.contact_id,
      contactName: r.contact_id ? (contactName.get(r.contact_id) ?? null) : null,
      title: r.title,
      description: r.description,
      location: r.location,
      durationMinutes: r.duration_minutes,
      frequency: r.frequency,
      interval: r.interval_count,
      weekdays: r.weekdays ?? [],
      startDate: r.start_date,
      timeOfDay: r.time_of_day,
      endsOn: r.ends_on,
      maxOccurrences: r.max_occurrences,
      crewProfileIds: r.crew_profile_ids ?? [],
      crewNames: (r.crew_profile_ids ?? []).map((id) => personName.get(id)).filter((n): n is string => !!n),
      checklistTemplateId: r.checklist_template_id,
      lineItems: lines,
      priceCents: priceOf(lines),
      status: r.status,
      ruleText: describeRule(ruleOf(r)),
      nextVisitAt: agg.next,
      upcomingCount: agg.upcoming,
      completedCount: agg.done,
    };
  });
}

export async function listRecurringJobs(ctx: TenantServiceContext, opts: { companyId?: string | null } = {}, now: Date = new Date()): Promise<RecurringJobView[]> {
  let q = ctx.supabase.from("recurring_jobs").select("*").eq("organization_id", ctx.organizationId).order("created_at", { ascending: false }).limit(500);
  if (opts.companyId) q = q.eq("company_id", opts.companyId);
  const { data, error } = await q;
  if (error) throw error;
  const views = await hydrate(ctx, (data ?? []) as Series[], now);
  const rank = { active: 0, paused: 1, ended: 2 } as const;
  return views.sort((a, b) => rank[a.status] - rank[b.status] || (a.nextVisitAt ?? "9").localeCompare(b.nextVisitAt ?? "9"));
}

export async function getRecurringJob(ctx: TenantServiceContext, id: string, now: Date = new Date()): Promise<RecurringJobView> {
  const [view] = await hydrate(ctx, [await loadSeries(ctx, id)], now);
  return view;
}

/** Line items for invoicing a visit of this series (empty when it has no price). */
export async function seriesLineItems(ctx: TenantServiceContext, seriesId: string): Promise<LineItem[]> {
  const { data } = await ctx.supabase.from("recurring_jobs").select("line_items").eq("organization_id", ctx.organizationId).eq("id", seriesId).maybeSingle();
  return readLineItems(data?.line_items);
}
