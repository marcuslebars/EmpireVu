/**
 * Timesheets & job costing. Runs under the caller's session: RLS lets crew see and edit
 * only their own time, owners/admins everyone's; pay rates are owner/admin-only.
 */
import { z } from "zod";

import type { Tables } from "@/server/db/database.types";
import { AuthorizationError, ValidationError } from "@/server/organizations/context";
import { readLineItems, priceOf } from "@/server/services/recurring/service";
import type { TenantServiceContext } from "@/server/services/shared";
import { computeJobProfit, workedMinutes, labourCents, type JobProfit } from "./logic";

type Entry = Tables<"time_entries">;

export class TimeNotFoundError extends ValidationError {
  constructor(message = "Time entry not found.") {
    super(message);
    this.name = "TimeNotFoundError";
  }
}

export function assertManager(role: string): void {
  if (role !== "owner" && role !== "admin") throw new AuthorizationError("Only owners and admins can see costs and pay rates.");
}

const iso = z.string().datetime({ offset: true });

export const clockInSchema = z.object({
  bookingId: z.string().uuid().nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});

export const manualEntrySchema = z
  .object({
    profileId: z.string().uuid().optional(),
    bookingId: z.string().uuid().nullable().optional(),
    startedAt: iso,
    endedAt: iso,
    breakMinutes: z.number().int().min(0).max(600).optional(),
    notes: z.string().trim().max(1000).nullable().optional(),
  })
  .refine((v) => Date.parse(v.endedAt) > Date.parse(v.startedAt), { message: "The end must be after the start.", path: ["endedAt"] })
  .refine((v) => Date.parse(v.endedAt) - Date.parse(v.startedAt) <= 24 * 3_600_000, { message: "One entry can't be longer than 24 hours.", path: ["endedAt"] });

export const entryUpdateSchema = z.object({
  bookingId: z.string().uuid().nullable().optional(),
  startedAt: iso.optional(),
  endedAt: iso.nullable().optional(),
  breakMinutes: z.number().int().min(0).max(600).optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});

export const materialSchema = z.object({
  label: z.string().trim().min(1, "Describe the material.").max(200),
  quantity: z.number().positive().max(100_000),
  unitCostCents: z.number().int().min(0).max(100_000_000),
});

export const rateSchema = z.object({
  profileId: z.string().uuid(),
  hourlyCostCents: z.number().int().min(0).max(100_000).nullable(),
});

export interface TimeEntryView {
  id: string;
  profileId: string;
  personName: string;
  bookingId: string | null;
  jobTitle: string | null;
  startedAt: string;
  endedAt: string | null;
  breakMinutes: number;
  minutes: number;
  notes: string | null;
  source: Entry["source"];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function bookingCompany(ctx: TenantServiceContext, bookingId: string): Promise<{ id: string; company_id: string; status: string }> {
  const { data, error } = await ctx.supabase
    .from("bookings")
    .select("id, company_id, status")
    .eq("organization_id", ctx.organizationId)
    .eq("id", bookingId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new ValidationError("Job not found.");
  return data;
}

async function views(ctx: TenantServiceContext, rows: Entry[], now = new Date()): Promise<TimeEntryView[]> {
  if (rows.length === 0) return [];
  const people = [...new Set(rows.map((r) => r.profile_id))];
  const bookings = [...new Set(rows.map((r) => r.booking_id).filter((v): v is string => !!v))];
  const [p, b] = await Promise.all([
    ctx.supabase.from("profiles").select("id, full_name, email").in("id", people),
    bookings.length
      ? ctx.supabase.from("bookings").select("id, title").eq("organization_id", ctx.organizationId).in("id", bookings)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (p.error) throw p.error;
  if (b.error) throw b.error;
  const names = new Map((p.data ?? []).map((x) => [x.id, x.full_name?.trim() || x.email || "Team member"]));
  const titles = new Map((b.data ?? []).map((x) => [x.id, x.title]));
  return rows.map((r) => ({
    id: r.id,
    profileId: r.profile_id,
    personName: names.get(r.profile_id) ?? "Team member",
    bookingId: r.booking_id,
    jobTitle: r.booking_id ? (titles.get(r.booking_id) ?? null) : null,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    breakMinutes: r.break_minutes,
    minutes: workedMinutes(r, now),
    notes: r.notes,
    source: r.source,
  }));
}

async function runningEntry(ctx: TenantServiceContext): Promise<Entry | null> {
  if (!ctx.actorProfileId) return null;
  const { data, error } = await ctx.supabase
    .from("time_entries")
    .select("*")
    .eq("organization_id", ctx.organizationId)
    .eq("profile_id", ctx.actorProfileId)
    .is("ended_at", null)
    .maybeSingle();
  if (error) throw error;
  return (data as Entry) ?? null;
}

// ── Clock ────────────────────────────────────────────────────────────────────

export async function getMyClock(ctx: TenantServiceContext): Promise<TimeEntryView | null> {
  const running = await runningEntry(ctx);
  return running ? (await views(ctx, [running]))[0] : null;
}

async function stopRunning(ctx: TenantServiceContext, entry: Entry, now: Date): Promise<void> {
  // A clock can't run past 24h (the table enforces it) — cap a forgotten one.
  const capped = Math.min(now.getTime(), Date.parse(entry.started_at) + 24 * 3_600_000);
  const end = Math.max(capped, Date.parse(entry.started_at) + 60_000);
  const { error } = await ctx.supabase
    .from("time_entries")
    .update({ ended_at: new Date(end).toISOString() })
    .eq("organization_id", ctx.organizationId)
    .eq("id", entry.id)
    .is("ended_at", null);
  if (error) throw error;
}

/** Clock in (to a job, or general time). Clocking in elsewhere stops your running clock first. */
export async function clockIn(ctx: TenantServiceContext, input: z.infer<typeof clockInSchema>, now = new Date()): Promise<TimeEntryView> {
  if (!ctx.actorProfileId) throw new AuthorizationError("Sign in to clock in.");
  let companyId: string | null = null;
  if (input.bookingId) {
    const b = await bookingCompany(ctx, input.bookingId);
    if (b.status === "cancelled" || b.status === "no_show") throw new ValidationError("This job was cancelled.");
    companyId = b.company_id;
  }
  const running = await runningEntry(ctx);
  if (running) {
    if (running.booking_id === (input.bookingId ?? null)) return (await views(ctx, [running], now))[0];
    await stopRunning(ctx, running, now);
  }
  const { data, error } = await ctx.supabase
    .from("time_entries")
    .insert({
      organization_id: ctx.organizationId,
      company_id: companyId,
      booking_id: input.bookingId ?? null,
      profile_id: ctx.actorProfileId,
      started_at: now.toISOString(),
      notes: input.notes || null,
      source: "clock",
      created_by: ctx.actorProfileId,
    })
    .select("*")
    .single();
  if (error) throw error;
  return (await views(ctx, [data as Entry], now))[0];
}

export async function clockOut(ctx: TenantServiceContext, now = new Date()): Promise<TimeEntryView | null> {
  const running = await runningEntry(ctx);
  if (!running) return null;
  await stopRunning(ctx, running, now);
  const { data } = await ctx.supabase.from("time_entries").select("*").eq("organization_id", ctx.organizationId).eq("id", running.id).maybeSingle();
  return data ? (await views(ctx, [data as Entry], now))[0] : null;
}

/** Job done: stop every running clock on it (the whole crew's). */
export async function closeJobTime(ctx: TenantServiceContext, bookingId: string): Promise<number> {
  const { data, error } = await ctx.supabase.rpc("close_job_time_entries", { p_booking_id: bookingId });
  if (error) throw error;
  return typeof data === "number" ? data : 0;
}

// ── Entries ──────────────────────────────────────────────────────────────────

export async function listEntries(
  ctx: TenantServiceContext,
  opts: { from: string; to: string; profileId?: string | null; bookingId?: string | null; companyId?: string | null },
  now = new Date(),
): Promise<TimeEntryView[]> {
  let q = ctx.supabase
    .from("time_entries")
    .select("*")
    .eq("organization_id", ctx.organizationId)
    .gte("started_at", opts.from)
    .lt("started_at", opts.to)
    .order("started_at", { ascending: false })
    .limit(2000);
  if (opts.profileId) q = q.eq("profile_id", opts.profileId);
  if (opts.bookingId) q = q.eq("booking_id", opts.bookingId);
  if (opts.companyId) q = q.eq("company_id", opts.companyId);
  const { data, error } = await q;
  if (error) throw error;
  return views(ctx, (data ?? []) as Entry[], now);
}

export async function jobEntries(ctx: TenantServiceContext, bookingId: string, now = new Date()): Promise<TimeEntryView[]> {
  const { data, error } = await ctx.supabase
    .from("time_entries")
    .select("*")
    .eq("organization_id", ctx.organizationId)
    .eq("booking_id", bookingId)
    .order("started_at", { ascending: true });
  if (error) throw error;
  return views(ctx, (data ?? []) as Entry[], now);
}

export async function createManualEntry(ctx: TenantServiceContext, input: z.infer<typeof manualEntrySchema>): Promise<TimeEntryView> {
  const profileId = input.profileId ?? ctx.actorProfileId;
  if (!profileId) throw new AuthorizationError("Sign in to log time.");
  const companyId = input.bookingId ? (await bookingCompany(ctx, input.bookingId)).company_id : null;
  const { data, error } = await ctx.supabase
    .from("time_entries")
    .insert({
      organization_id: ctx.organizationId,
      company_id: companyId,
      booking_id: input.bookingId ?? null,
      profile_id: profileId,
      started_at: new Date(input.startedAt).toISOString(),
      ended_at: new Date(input.endedAt).toISOString(),
      break_minutes: input.breakMinutes ?? 0,
      notes: input.notes || null,
      source: "manual",
      created_by: ctx.actorProfileId,
    })
    .select("*")
    .single();
  if (error) {
    // RLS: a crew member logging someone else's time.
    if (error.code === "42501") throw new AuthorizationError("You can only log your own time.");
    throw error;
  }
  return (await views(ctx, [data as Entry]))[0];
}

export async function updateEntry(ctx: TenantServiceContext, id: string, input: z.infer<typeof entryUpdateSchema>): Promise<TimeEntryView> {
  const { data: existing, error: e1 } = await ctx.supabase.from("time_entries").select("*").eq("organization_id", ctx.organizationId).eq("id", id).maybeSingle();
  if (e1) throw e1;
  if (!existing) throw new TimeNotFoundError();
  const patch: Partial<Entry> = {};
  if (input.bookingId !== undefined) {
    patch.booking_id = input.bookingId;
    patch.company_id = input.bookingId ? (await bookingCompany(ctx, input.bookingId)).company_id : null;
  }
  if (input.startedAt !== undefined) patch.started_at = new Date(input.startedAt).toISOString();
  if (input.endedAt !== undefined) patch.ended_at = input.endedAt ? new Date(input.endedAt).toISOString() : null;
  if (input.breakMinutes !== undefined) patch.break_minutes = input.breakMinutes;
  if (input.notes !== undefined) patch.notes = input.notes || null;
  const start = Date.parse(patch.started_at ?? existing.started_at);
  const end = patch.ended_at !== undefined ? patch.ended_at : existing.ended_at;
  if (end && Date.parse(end) <= start) throw new ValidationError("The end must be after the start.");
  if (end && Date.parse(end) - start > 24 * 3_600_000) throw new ValidationError("One entry can't be longer than 24 hours.");
  const { data, error } = await ctx.supabase.from("time_entries").update(patch).eq("organization_id", ctx.organizationId).eq("id", id).select("*").maybeSingle();
  if (error) throw error;
  if (!data) throw new TimeNotFoundError();
  return (await views(ctx, [data as Entry]))[0];
}

export async function deleteEntry(ctx: TenantServiceContext, id: string): Promise<void> {
  const { data, error } = await ctx.supabase.from("time_entries").delete().eq("organization_id", ctx.organizationId).eq("id", id).select("id");
  if (error) throw error;
  if (!data?.length) throw new TimeNotFoundError();
}

// ── Materials ────────────────────────────────────────────────────────────────

export interface MaterialView {
  id: string;
  label: string;
  quantity: number;
  unitCostCents: number;
  totalCents: number;
  createdBy: string | null;
}

export async function listMaterials(ctx: TenantServiceContext, bookingId: string): Promise<MaterialView[]> {
  const { data, error } = await ctx.supabase
    .from("job_materials")
    .select("*")
    .eq("organization_id", ctx.organizationId)
    .eq("booking_id", bookingId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((m) => ({
    id: m.id,
    label: m.label,
    quantity: Number(m.quantity),
    unitCostCents: m.unit_cost_cents,
    totalCents: Math.round(Number(m.quantity) * m.unit_cost_cents),
    createdBy: m.created_by,
  }));
}

export async function addMaterial(ctx: TenantServiceContext, bookingId: string, input: z.infer<typeof materialSchema>): Promise<MaterialView[]> {
  await bookingCompany(ctx, bookingId);
  const { error } = await ctx.supabase.from("job_materials").insert({
    organization_id: ctx.organizationId,
    booking_id: bookingId,
    label: input.label,
    quantity: input.quantity,
    unit_cost_cents: input.unitCostCents,
    created_by: ctx.actorProfileId,
  });
  if (error) throw error;
  return listMaterials(ctx, bookingId);
}

export async function deleteMaterial(ctx: TenantServiceContext, bookingId: string, id: string): Promise<MaterialView[]> {
  const { data, error } = await ctx.supabase
    .from("job_materials")
    .delete()
    .eq("organization_id", ctx.organizationId)
    .eq("booking_id", bookingId)
    .eq("id", id)
    .select("id");
  if (error) throw error;
  if (!data?.length) throw new ValidationError("You can only remove materials you added.");
  return listMaterials(ctx, bookingId);
}

// ── Pay rates (owners/admins) ────────────────────────────────────────────────

export interface RateView {
  profileId: string;
  name: string;
  email: string | null;
  role: string;
  hourlyCostCents: number | null;
}

export async function listRates(ctx: TenantServiceContext): Promise<RateView[]> {
  const [members, rates] = await Promise.all([
    ctx.supabase.from("organization_memberships").select("profile_id, role").eq("organization_id", ctx.organizationId),
    ctx.supabase.from("member_pay_rates").select("profile_id, hourly_cost_cents").eq("organization_id", ctx.organizationId),
  ]);
  if (members.error) throw members.error;
  if (rates.error) throw rates.error;
  const ids = (members.data ?? []).map((m) => m.profile_id);
  const { data: people, error } = ids.length ? await ctx.supabase.from("profiles").select("id, full_name, email").in("id", ids) : { data: [], error: null };
  if (error) throw error;
  const byId = new Map((people ?? []).map((p) => [p.id, p]));
  const rateBy = new Map((rates.data ?? []).map((r) => [r.profile_id, r.hourly_cost_cents]));
  return (members.data ?? [])
    .map((m) => {
      const p = byId.get(m.profile_id);
      return {
        profileId: m.profile_id,
        name: p?.full_name?.trim() || p?.email || "Team member",
        email: p?.email ?? null,
        role: m.role,
        hourlyCostCents: rateBy.get(m.profile_id) ?? null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function setRate(ctx: TenantServiceContext, input: z.infer<typeof rateSchema>): Promise<RateView[]> {
  if (input.hourlyCostCents === null) {
    const { error } = await ctx.supabase.from("member_pay_rates").delete().eq("organization_id", ctx.organizationId).eq("profile_id", input.profileId);
    if (error) throw error;
  } else {
    const { error } = await ctx.supabase.from("member_pay_rates").upsert(
      {
        organization_id: ctx.organizationId,
        profile_id: input.profileId,
        hourly_cost_cents: input.hourlyCostCents,
        updated_by: ctx.actorProfileId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "organization_id,profile_id" },
    );
    if (error) {
      if (error.code === "42501") throw new ValidationError("That person isn't on your team.");
      throw error;
    }
  }
  return listRates(ctx);
}

async function rateMap(ctx: TenantServiceContext): Promise<Map<string, number>> {
  const { data, error } = await ctx.supabase.from("member_pay_rates").select("profile_id, hourly_cost_cents").eq("organization_id", ctx.organizationId);
  if (error) throw error;
  return new Map((data ?? []).map((r) => [r.profile_id, r.hourly_cost_cents]));
}

// ── Job profit (owners/admins) ───────────────────────────────────────────────

type BookingForRevenue = Pick<Tables<"bookings">, "id" | "quote_id" | "recurring_job_id">;

/** Pre-tax revenue per booking: its invoice, else the approved quote / series price. */
async function revenueFor(ctx: TenantServiceContext, bookings: BookingForRevenue[]): Promise<Map<string, { cents: number; source: JobProfit["revenueSource"] }>> {
  const out = new Map<string, { cents: number; source: JobProfit["revenueSource"] }>();
  if (bookings.length === 0) return out;
  const ids = bookings.map((b) => b.id);
  const quoteIds = [...new Set(bookings.map((b) => b.quote_id).filter((v): v is string => !!v))];
  const seriesIds = [...new Set(bookings.map((b) => b.recurring_job_id).filter((v): v is string => !!v))];
  const [inv, quotes, series] = await Promise.all([
    ctx.supabase.from("invoices").select("booking_id, quote_id, subtotal_cents, status").eq("organization_id", ctx.organizationId).neq("status", "void").in("booking_id", ids),
    quoteIds.length
      ? ctx.supabase.from("quotes").select("id, subtotal_cents, approved_subtotal_cents").eq("organization_id", ctx.organizationId).in("id", quoteIds)
      : Promise.resolve({ data: [], error: null }),
    seriesIds.length
      ? ctx.supabase.from("recurring_jobs").select("id, line_items").eq("organization_id", ctx.organizationId).in("id", seriesIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  for (const r of [inv, quotes, series]) if (r.error) throw r.error;
  const invBy = new Map<string, number>();
  for (const i of inv.data ?? []) if (i.booking_id) invBy.set(i.booking_id, (invBy.get(i.booking_id) ?? 0) + i.subtotal_cents);
  const quoteBy = new Map((quotes.data ?? []).map((q) => [q.id, q.approved_subtotal_cents ?? q.subtotal_cents]));
  const seriesBy = new Map((series.data ?? []).map((s) => [s.id, priceOf(readLineItems(s.line_items))]));
  for (const b of bookings) {
    if (invBy.has(b.id)) out.set(b.id, { cents: invBy.get(b.id)!, source: "invoice" });
    else if (b.quote_id && quoteBy.has(b.quote_id)) out.set(b.id, { cents: quoteBy.get(b.quote_id)!, source: "estimate" });
    else if (b.recurring_job_id && (seriesBy.get(b.recurring_job_id) ?? 0) > 0) out.set(b.id, { cents: seriesBy.get(b.recurring_job_id)!, source: "estimate" });
    else out.set(b.id, { cents: 0, source: "none" });
  }
  return out;
}

export async function jobProfit(ctx: TenantServiceContext, bookingId: string, now = new Date()): Promise<JobProfit & { missingRateNames: string[] }> {
  const { data: booking, error } = await ctx.supabase
    .from("bookings")
    .select("id, quote_id, recurring_job_id")
    .eq("organization_id", ctx.organizationId)
    .eq("id", bookingId)
    .maybeSingle();
  if (error) throw error;
  if (!booking) throw new ValidationError("Job not found.");
  const [revenue, entries, materials, expenses, rates] = await Promise.all([
    revenueFor(ctx, [booking]),
    ctx.supabase.from("time_entries").select("profile_id, started_at, ended_at, break_minutes").eq("organization_id", ctx.organizationId).eq("booking_id", bookingId),
    ctx.supabase.from("job_materials").select("quantity, unit_cost_cents").eq("organization_id", ctx.organizationId).eq("booking_id", bookingId),
    ctx.supabase.from("expenses").select("amount_cents, tax_cents").eq("organization_id", ctx.organizationId).eq("booking_id", bookingId),
    rateMap(ctx),
  ]);
  if (entries.error) throw entries.error;
  if (materials.error) throw materials.error;
  if (expenses.error) throw expenses.error;
  const rev = revenue.get(bookingId)!;
  const profit = computeJobProfit({
    revenueCents: rev.cents,
    revenueSource: rev.source,
    entries: entries.data ?? [],
    rates,
    materials: (materials.data ?? []).map((m) => ({ quantity: Number(m.quantity), unit_cost_cents: m.unit_cost_cents })),
    expenses: expenses.data ?? [],
    now,
  });
  let missingRateNames: string[] = [];
  if (profit.missingRates.length) {
    const { data: people } = await ctx.supabase.from("profiles").select("id, full_name, email").in("id", profit.missingRates);
    missingRateNames = (people ?? []).map((p) => p.full_name?.trim() || p.email || "Team member");
  }
  return { ...profit, missingRateNames };
}

export interface ProfitRow extends JobProfit {
  bookingId: string;
  title: string;
  scheduledFor: string;
  contactName: string | null;
}

/** Finished jobs in a window with revenue, cost and profit — the job-costing report. */
export async function profitReport(
  ctx: TenantServiceContext,
  opts: { from: string; to: string; companyId?: string | null },
  now = new Date(),
): Promise<{ rows: ProfitRow[]; totals: { revenueCents: number; costCents: number; profitCents: number; labourMinutes: number }; missingRateNames: string[] }> {
  let q = ctx.supabase
    .from("bookings")
    .select("id, title, scheduled_for, contact_id, quote_id, recurring_job_id")
    .eq("organization_id", ctx.organizationId)
    .eq("status", "completed")
    .gte("scheduled_for", opts.from)
    .lt("scheduled_for", opts.to)
    .order("scheduled_for", { ascending: false })
    .limit(500);
  if (opts.companyId) q = q.eq("company_id", opts.companyId);
  const { data: bookings, error } = await q;
  if (error) throw error;
  const list = bookings ?? [];
  if (list.length === 0) return { rows: [], totals: { revenueCents: 0, costCents: 0, profitCents: 0, labourMinutes: 0 }, missingRateNames: [] };
  const ids = list.map((b) => b.id);
  const contactIds = [...new Set(list.map((b) => b.contact_id).filter((v): v is string => !!v))];
  const [revenue, entries, materials, expenses, rates, contacts] = await Promise.all([
    revenueFor(ctx, list),
    ctx.supabase.from("time_entries").select("booking_id, profile_id, started_at, ended_at, break_minutes").eq("organization_id", ctx.organizationId).in("booking_id", ids),
    ctx.supabase.from("job_materials").select("booking_id, quantity, unit_cost_cents").eq("organization_id", ctx.organizationId).in("booking_id", ids),
    ctx.supabase.from("expenses").select("booking_id, amount_cents, tax_cents").eq("organization_id", ctx.organizationId).in("booking_id", ids),
    rateMap(ctx),
    contactIds.length
      ? ctx.supabase.from("contacts").select("id, first_name, last_name").eq("organization_id", ctx.organizationId).in("id", contactIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  for (const r of [entries, materials, expenses, contacts]) if (r.error) throw r.error;
  const contactName = new Map((contacts.data ?? []).map((c) => [c.id, [c.first_name, c.last_name].filter(Boolean).join(" ").trim() || null]));
  const missing = new Set<string>();
  const rows: ProfitRow[] = list.map((b) => {
    const rev = revenue.get(b.id)!;
    const p = computeJobProfit({
      revenueCents: rev.cents,
      revenueSource: rev.source,
      entries: (entries.data ?? []).filter((e) => e.booking_id === b.id),
      rates,
      materials: (materials.data ?? []).filter((m) => m.booking_id === b.id).map((m) => ({ quantity: Number(m.quantity), unit_cost_cents: m.unit_cost_cents })),
      expenses: (expenses.data ?? []).filter((e) => e.booking_id === b.id),
      now,
    });
    p.missingRates.forEach((id) => missing.add(id));
    return { ...p, bookingId: b.id, title: b.title, scheduledFor: b.scheduled_for, contactName: b.contact_id ? (contactName.get(b.contact_id) ?? null) : null };
  });
  const totals = rows.reduce(
    (t, r) => ({
      revenueCents: t.revenueCents + r.revenueCents,
      costCents: t.costCents + r.costCents,
      profitCents: t.profitCents + r.profitCents,
      labourMinutes: t.labourMinutes + r.labourMinutes,
    }),
    { revenueCents: 0, costCents: 0, profitCents: 0, labourMinutes: 0 },
  );
  let missingRateNames: string[] = [];
  if (missing.size) {
    const { data: people } = await ctx.supabase.from("profiles").select("id, full_name, email").in("id", [...missing]);
    missingRateNames = (people ?? []).map((p) => p.full_name?.trim() || p.email || "Team member");
  }
  return { rows, totals, missingRateNames };
}

/** Per-person totals for a timesheet window; cost only when the caller can see rates. */
export async function timesheetSummary(
  ctx: TenantServiceContext,
  entries: TimeEntryView[],
  withCost: boolean,
): Promise<Array<{ profileId: string; name: string; minutes: number; costCents: number | null; entries: number }>> {
  const rates = withCost ? await rateMap(ctx) : new Map<string, number>();
  const by = new Map<string, { profileId: string; name: string; minutes: number; costCents: number | null; entries: number }>();
  for (const e of entries) {
    const rate = withCost ? rates.get(e.profileId) : undefined;
    // No pay rate → cost unknown (null), not $0.
    const row = by.get(e.profileId) ?? { profileId: e.profileId, name: e.personName, minutes: 0, costCents: rate === undefined ? null : 0, entries: 0 };
    row.minutes += e.minutes;
    row.entries += 1;
    if (rate !== undefined) row.costCents = (row.costCents ?? 0) + labourCents(e.minutes, rate);
    by.set(e.profileId, row);
  }
  return [...by.values()].sort((a, b) => b.minutes - a.minutes);
}
