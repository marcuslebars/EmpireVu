/**
 * Crew & job dispatch: who is on a job, the job's checklist, and the field steps
 * (on my way → started → done). Everything runs under the caller's session (RLS);
 * the only service-role step is the push fan-out in push/notify.ts.
 *
 * "Crew" = people assigned to the booking directly (booking_assignments), plus anyone
 * assigned one of its tasks — the older, implicit way crews were recorded.
 */
import { z } from "zod";

import type { Tables } from "@/server/db/database.types";
import { ValidationError } from "@/server/organizations/context";
import { createActivityEvent } from "@/server/services/activity-events";
import { updateBookingStatus } from "@/server/services/bookings";
import type { TenantServiceContext } from "@/server/services/shared";
import { emitActivityEventAndDispatch } from "@/server/services/workflow-engine/dispatch";
import {
  checklistProgress,
  cleanChecklistLabels,
  diffCrew,
  itemsToAdd,
  jobStage,
  MAX_CHECKLIST_ITEMS,
  type ChecklistProgress,
  type JobStage,
} from "./logic";
import { notifyCrewAssigned } from "./notify";

type Booking = Tables<"bookings">;

export class CrewNotFoundError extends ValidationError {
  constructor(message = "Job not found.") {
    super(message);
    this.name = "CrewNotFoundError";
  }
}

/** Marking a job done with checklist items still open (→ 409; the UI offers "done anyway"). */
export class ChecklistIncompleteError extends Error {
  constructor(readonly openItems: number) {
    super(`${openItems} checklist item${openItems === 1 ? " is" : "s are"} still open.`);
    this.name = "ChecklistIncompleteError";
  }
}

export interface CrewMember {
  profileId: string;
  name: string;
  email: string | null;
}

export interface ChecklistItem {
  id: string;
  label: string;
  position: number;
  doneAt: string | null;
  doneBy: string | null;
}

export interface JobSummary {
  id: string;
  title: string;
  status: Booking["status"];
  stage: JobStage;
  scheduledFor: string;
  durationMinutes: number;
  location: string | null;
  companyId: string;
  companyName: string | null;
  timeZone: string;
  contactId: string | null;
  contactName: string | null;
  contactPhone: string | null;
  crew: CrewMember[];
  checklist: ChecklistProgress;
  assignedToMe: boolean;
}

export interface JobSheet extends JobSummary {
  description: string | null;
  contactEmail: string | null;
  quoteId: string | null;
  enRouteAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  completedBy: string | null;
  checklistItems: ChecklistItem[];
  invoiceId: string | null;
}

// ── Schemas ──────────────────────────────────────────────────────────────────

export const setCrewSchema = z.object({ profileIds: z.array(z.string().uuid()).max(20) });
export const updateJobSchema = z.object({
  location: z.string().trim().max(300).nullish(),
  description: z.string().trim().max(4000).nullish(),
});
export const addChecklistSchema = z.object({ labels: z.array(z.string().max(500)).min(1).max(MAX_CHECKLIST_ITEMS) });
export const toggleChecklistSchema = z.object({ done: z.boolean() });
export const completeJobSchema = z.object({ force: z.boolean().optional() });
export const templateSchema = z.object({
  companyId: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
  items: z.array(z.string().max(500)).max(MAX_CHECKLIST_ITEMS),
});
export const templateUpdateSchema = templateSchema.omit({ companyId: true }).partial();

// ── Loading ──────────────────────────────────────────────────────────────────

const ACTIVE_STATUSES: Booking["status"][] = ["pending", "confirmed"];

async function loadBooking(ctx: TenantServiceContext, bookingId: string): Promise<Booking> {
  const { data, error } = await ctx.supabase
    .from("bookings")
    .select("*")
    .eq("organization_id", ctx.organizationId)
    .eq("id", bookingId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new CrewNotFoundError();
  return data as Booking;
}

/** booking id → crew profile ids (direct assignments first, then task assignees). */
async function crewIdsFor(ctx: TenantServiceContext, bookingIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (bookingIds.length === 0) return out;
  const [{ data: direct, error: e1 }, { data: tasks, error: e2 }] = await Promise.all([
    ctx.supabase
      .from("booking_assignments")
      .select("booking_id, profile_id, created_at")
      .eq("organization_id", ctx.organizationId)
      .in("booking_id", bookingIds)
      .order("created_at", { ascending: true }),
    ctx.supabase
      .from("tasks")
      .select("booking_id, assigned_to_profile_id")
      .eq("organization_id", ctx.organizationId)
      .in("booking_id", bookingIds)
      .not("assigned_to_profile_id", "is", null),
  ]);
  if (e1) throw e1;
  if (e2) throw e2;
  const add = (bookingId: string | null, profileId: string | null) => {
    if (!bookingId || !profileId) return;
    const list = out.get(bookingId) ?? [];
    if (!list.includes(profileId)) list.push(profileId);
    out.set(bookingId, list);
  };
  for (const r of direct ?? []) add(r.booking_id, r.profile_id);
  for (const r of tasks ?? []) add(r.booking_id, r.assigned_to_profile_id);
  return out;
}

async function profilesById(ctx: TenantServiceContext, ids: string[]): Promise<Map<string, CrewMember>> {
  const out = new Map<string, CrewMember>();
  if (ids.length === 0) return out;
  const { data, error } = await ctx.supabase.from("profiles").select("id, full_name, email").in("id", ids);
  if (error) throw error;
  for (const p of data ?? []) {
    out.set(p.id, { profileId: p.id, name: p.full_name?.trim() || p.email || "Team member", email: p.email ?? null });
  }
  return out;
}

async function hydrate(ctx: TenantServiceContext, bookings: Booking[]): Promise<JobSummary[]> {
  if (bookings.length === 0) return [];
  const ids = bookings.map((b) => b.id);
  const contactIds = [...new Set(bookings.map((b) => b.contact_id).filter((v): v is string => !!v))];
  const companyIds = [...new Set(bookings.map((b) => b.company_id))];

  const [crewIds, contacts, companies, checklist] = await Promise.all([
    crewIdsFor(ctx, ids),
    contactIds.length
      ? ctx.supabase.from("contacts").select("id, first_name, last_name, phone").eq("organization_id", ctx.organizationId).in("id", contactIds)
      : Promise.resolve({ data: [], error: null }),
    ctx.supabase.from("companies").select("id, name, timezone").eq("organization_id", ctx.organizationId).in("id", companyIds),
    ctx.supabase.from("booking_checklist_items").select("booking_id, done_at").eq("organization_id", ctx.organizationId).in("booking_id", ids),
  ]);
  for (const r of [contacts, companies, checklist]) if (r.error) throw r.error;

  const people = await profilesById(ctx, [...new Set([...crewIds.values()].flat())]);
  const contactMap = new Map((contacts.data ?? []).map((c) => [c.id, c]));
  const companyMap = new Map((companies.data ?? []).map((c) => [c.id, c]));
  const checklistMap = new Map<string, Array<{ done_at: string | null }>>();
  for (const item of checklist.data ?? []) {
    const list = checklistMap.get(item.booking_id) ?? [];
    list.push(item);
    checklistMap.set(item.booking_id, list);
  }

  return bookings.map((b) => {
    const contact = b.contact_id ? contactMap.get(b.contact_id) : undefined;
    const company = companyMap.get(b.company_id);
    const crew = (crewIds.get(b.id) ?? []).map((id) => people.get(id)).filter((m): m is CrewMember => !!m);
    return {
      id: b.id,
      title: b.title,
      status: b.status,
      stage: jobStage(b),
      scheduledFor: b.scheduled_for,
      durationMinutes: b.duration_minutes,
      location: b.location ?? null,
      companyId: b.company_id,
      companyName: company?.name ?? null,
      timeZone: company?.timezone || "America/Toronto",
      contactId: b.contact_id,
      contactName: contact ? [contact.first_name, contact.last_name].filter(Boolean).join(" ").trim() || null : null,
      contactPhone: contact?.phone ?? null,
      crew,
      checklist: checklistProgress(checklistMap.get(b.id) ?? []),
      assignedToMe: !!ctx.actorProfileId && crew.some((m) => m.profileId === ctx.actorProfileId),
    };
  });
}

// ── Reading ──────────────────────────────────────────────────────────────────

export interface ListJobsOptions {
  /** "mine": jobs I'm on. "all": every job (dispatch view). */
  scope: "mine" | "all";
  from: string;
  to: string;
  companyId?: string | null;
  includeDone?: boolean;
}

export async function listJobs(ctx: TenantServiceContext, options: ListJobsOptions): Promise<JobSummary[]> {
  let bookingIds: string[] | null = null;
  if (options.scope === "mine") {
    if (!ctx.actorProfileId) return [];
    const [{ data: direct, error: e1 }, { data: tasks, error: e2 }] = await Promise.all([
      ctx.supabase.from("booking_assignments").select("booking_id").eq("organization_id", ctx.organizationId).eq("profile_id", ctx.actorProfileId),
      ctx.supabase
        .from("tasks")
        .select("booking_id")
        .eq("organization_id", ctx.organizationId)
        .eq("assigned_to_profile_id", ctx.actorProfileId)
        .not("booking_id", "is", null),
    ]);
    if (e1) throw e1;
    if (e2) throw e2;
    bookingIds = [...new Set([...(direct ?? []).map((r) => r.booking_id), ...(tasks ?? []).map((r) => r.booking_id as string)])];
    if (bookingIds.length === 0) return [];
  }

  let query = ctx.supabase
    .from("bookings")
    .select("*")
    .eq("organization_id", ctx.organizationId)
    .gte("scheduled_for", options.from)
    .lte("scheduled_for", options.to)
    .in("status", options.includeDone ? [...ACTIVE_STATUSES, "completed"] : ACTIVE_STATUSES)
    .order("scheduled_for", { ascending: true })
    .limit(200);
  if (options.companyId) query = query.eq("company_id", options.companyId);
  if (bookingIds) query = query.in("id", bookingIds.slice(0, 500));
  const { data, error } = await query;
  if (error) throw error;
  return hydrate(ctx, (data ?? []) as Booking[]);
}

export async function getJobSheet(ctx: TenantServiceContext, bookingId: string): Promise<JobSheet> {
  const booking = await loadBooking(ctx, bookingId);
  const [[summary], items, contact, invoice] = await Promise.all([
    hydrate(ctx, [booking]),
    listChecklist(ctx, bookingId),
    booking.contact_id
      ? ctx.supabase.from("contacts").select("email").eq("organization_id", ctx.organizationId).eq("id", booking.contact_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    ctx.supabase
      .from("invoices")
      .select("id")
      .eq("organization_id", ctx.organizationId)
      .eq("booking_id", bookingId)
      .neq("status", "void")
      .limit(1)
      .maybeSingle(),
  ]);
  return {
    ...summary,
    description: booking.description,
    contactEmail: contact.data?.email ?? null,
    quoteId: booking.quote_id,
    enRouteAt: booking.en_route_at ?? null,
    startedAt: booking.started_at ?? null,
    completedAt: booking.completed_at ?? null,
    completedBy: booking.completed_by ?? null,
    checklistItems: items,
    invoiceId: invoice.data?.id ?? null,
  };
}

// ── Crew ─────────────────────────────────────────────────────────────────────

/** Replace the job's direct crew. Newly added people (other than you) are notified. */
export async function setCrew(ctx: TenantServiceContext, bookingId: string, profileIds: string[]): Promise<CrewMember[]> {
  const booking = await loadBooking(ctx, bookingId);
  const wanted = [...new Set(profileIds)];

  if (wanted.length) {
    const { data: members, error } = await ctx.supabase
      .from("organization_memberships")
      .select("profile_id")
      .eq("organization_id", ctx.organizationId)
      .in("profile_id", wanted);
    if (error) throw error;
    const ok = new Set((members ?? []).map((m) => m.profile_id));
    if (wanted.some((id) => !ok.has(id))) throw new ValidationError("Only people on your team can be put on a job.");
  }

  const { data: current, error: curErr } = await ctx.supabase
    .from("booking_assignments")
    .select("profile_id")
    .eq("organization_id", ctx.organizationId)
    .eq("booking_id", bookingId);
  if (curErr) throw curErr;
  const { add, remove } = diffCrew((current ?? []).map((r) => r.profile_id), wanted);

  if (remove.length) {
    const { error } = await ctx.supabase
      .from("booking_assignments")
      .delete()
      .eq("organization_id", ctx.organizationId)
      .eq("booking_id", bookingId)
      .in("profile_id", remove);
    if (error) throw error;
  }
  if (add.length) {
    const { error } = await ctx.supabase.from("booking_assignments").insert(
      add.map((profileId) => ({
        organization_id: ctx.organizationId,
        booking_id: bookingId,
        profile_id: profileId,
        assigned_by: ctx.actorProfileId,
      })),
    );
    if (error) throw error;
  }

  if (add.length || remove.length) {
    await createActivityEvent(ctx, {
      companyId: booking.company_id,
      entityId: booking.id,
      entityType: "booking",
      eventType: "booking.crew_changed",
      metadata: { bookingId: booking.id, added: add, removed: remove },
      relatedEntityId: booking.contact_id,
      relatedEntityType: booking.contact_id ? "contact" : null,
    }).catch((err: unknown) => console.error("[crew] activity failed:", err instanceof Error ? err.message : err));
  }

  const toNotify = add.filter((id) => id !== ctx.actorProfileId);
  if (toNotify.length && ACTIVE_STATUSES.includes(booking.status)) {
    await notifyCrewAssigned(ctx, booking, toNotify);
  }

  const [summary] = await hydrate(ctx, [await loadBooking(ctx, bookingId)]);
  return summary.crew;
}

export async function updateJob(ctx: TenantServiceContext, bookingId: string, input: z.infer<typeof updateJobSchema>): Promise<void> {
  await loadBooking(ctx, bookingId);
  const patch: { location?: string | null; description?: string | null } = {};
  if (input.location !== undefined) patch.location = input.location || null;
  if (input.description !== undefined) patch.description = input.description || null;
  if (Object.keys(patch).length === 0) return;
  const { error } = await ctx.supabase.from("bookings").update(patch).eq("organization_id", ctx.organizationId).eq("id", bookingId);
  if (error) throw error;
}

// ── Field steps ──────────────────────────────────────────────────────────────

function assertOpen(booking: Booking): void {
  if (booking.status === "cancelled" || booking.status === "no_show") throw new ValidationError("This job was cancelled.");
  if (booking.status === "completed") throw new ValidationError("This job is already done.");
}

/** "On my way" — once per job. Fires booking.en_route (the customer heads-up automation). */
export async function markEnRoute(ctx: TenantServiceContext, bookingId: string): Promise<void> {
  const booking = await loadBooking(ctx, bookingId);
  assertOpen(booking);
  if (booking.en_route_at) return;
  const now = new Date().toISOString();
  const { data, error } = await ctx.supabase
    .from("bookings")
    .update({ en_route_at: now })
    .eq("organization_id", ctx.organizationId)
    .eq("id", bookingId)
    .is("en_route_at", null)
    .select("id");
  if (error) throw error;
  if (!data?.length) return; // someone else on the crew tapped it first
  await emitActivityEventAndDispatch(ctx, {
    companyId: booking.company_id,
    entityId: booking.id,
    entityType: "booking",
    eventType: "booking.en_route",
    metadata: { bookingId: booking.id, by: ctx.actorProfileId },
    relatedEntityId: booking.contact_id,
    relatedEntityType: booking.contact_id ? "contact" : null,
  });
}

export async function startJob(ctx: TenantServiceContext, bookingId: string): Promise<void> {
  const booking = await loadBooking(ctx, bookingId);
  assertOpen(booking);
  if (booking.started_at) return;
  const { error } = await ctx.supabase
    .from("bookings")
    .update({ started_at: new Date().toISOString() })
    .eq("organization_id", ctx.organizationId)
    .eq("id", bookingId)
    .is("started_at", null);
  if (error) throw error;
  await createActivityEvent(ctx, {
    companyId: booking.company_id,
    entityId: booking.id,
    entityType: "booking",
    eventType: "booking.started",
    metadata: { bookingId: booking.id, by: ctx.actorProfileId },
    relatedEntityId: booking.contact_id,
    relatedEntityType: booking.contact_id ? "contact" : null,
  }).catch((err: unknown) => console.error("[crew] activity failed:", err instanceof Error ? err.message : err));
}

/**
 * Done. Refuses while checklist items are open unless `force`. Completing runs the
 * normal booking.completed path — review request, auto-invoice, and so on.
 */
export async function completeJob(ctx: TenantServiceContext, bookingId: string, options: { force?: boolean } = {}): Promise<Booking> {
  const booking = await loadBooking(ctx, bookingId);
  if (booking.status === "completed") return booking;
  if (booking.status === "cancelled" || booking.status === "no_show") throw new ValidationError("This job was cancelled.");

  if (!options.force) {
    const items = await listChecklist(ctx, bookingId);
    const open = items.filter((i) => !i.doneAt).length;
    if (open > 0) throw new ChecklistIncompleteError(open);
  }

  const now = new Date().toISOString();
  const { error } = await ctx.supabase
    .from("bookings")
    .update({ completed_at: now, completed_by: ctx.actorProfileId, started_at: booking.started_at ?? now })
    .eq("organization_id", ctx.organizationId)
    .eq("id", bookingId);
  if (error) throw error;
  return updateBookingStatus(ctx, { bookingId, status: "completed" });
}

// ── Checklist ────────────────────────────────────────────────────────────────

export async function listChecklist(ctx: TenantServiceContext, bookingId: string): Promise<ChecklistItem[]> {
  const { data, error } = await ctx.supabase
    .from("booking_checklist_items")
    .select("id, label, position, done_at, done_by")
    .eq("organization_id", ctx.organizationId)
    .eq("booking_id", bookingId)
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((r) => ({ id: r.id, label: r.label, position: r.position, doneAt: r.done_at, doneBy: r.done_by }));
}

async function appendItems(ctx: TenantServiceContext, bookingId: string, labels: readonly unknown[]): Promise<ChecklistItem[]> {
  const existing = await listChecklist(ctx, bookingId);
  const fresh = itemsToAdd(existing.map((i) => i.label), labels);
  if (fresh.length) {
    const start = existing.reduce((max, i) => Math.max(max, i.position), -1) + 1;
    const { error } = await ctx.supabase.from("booking_checklist_items").insert(
      fresh.map((label, i) => ({
        organization_id: ctx.organizationId,
        booking_id: bookingId,
        label,
        position: start + i,
        created_by: ctx.actorProfileId,
      })),
    );
    if (error) throw error;
  }
  return listChecklist(ctx, bookingId);
}

export async function addChecklistItems(ctx: TenantServiceContext, bookingId: string, labels: string[]): Promise<ChecklistItem[]> {
  await loadBooking(ctx, bookingId);
  if (cleanChecklistLabels(labels).length === 0) throw new ValidationError("Add some text for the checklist item.");
  return appendItems(ctx, bookingId, labels);
}

export async function setChecklistItemDone(ctx: TenantServiceContext, bookingId: string, itemId: string, done: boolean): Promise<ChecklistItem[]> {
  const { data, error } = await ctx.supabase
    .from("booking_checklist_items")
    .update(done ? { done_at: new Date().toISOString(), done_by: ctx.actorProfileId } : { done_at: null, done_by: null })
    .eq("organization_id", ctx.organizationId)
    .eq("booking_id", bookingId)
    .eq("id", itemId)
    .select("id");
  if (error) throw error;
  if (!data?.length) throw new CrewNotFoundError("Checklist item not found.");
  return listChecklist(ctx, bookingId);
}

export async function deleteChecklistItem(ctx: TenantServiceContext, bookingId: string, itemId: string): Promise<ChecklistItem[]> {
  const { error } = await ctx.supabase
    .from("booking_checklist_items")
    .delete()
    .eq("organization_id", ctx.organizationId)
    .eq("booking_id", bookingId)
    .eq("id", itemId);
  if (error) throw error;
  return listChecklist(ctx, bookingId);
}

export async function applyChecklistTemplate(ctx: TenantServiceContext, bookingId: string, templateId: string): Promise<ChecklistItem[]> {
  const booking = await loadBooking(ctx, bookingId);
  const { data: template, error } = await ctx.supabase
    .from("checklist_templates")
    .select("id, company_id, items")
    .eq("organization_id", ctx.organizationId)
    .eq("id", templateId)
    .maybeSingle();
  if (error) throw error;
  if (!template || template.company_id !== booking.company_id) throw new CrewNotFoundError("Checklist not found.");
  return appendItems(ctx, bookingId, Array.isArray(template.items) ? template.items : []);
}

// ── Templates ────────────────────────────────────────────────────────────────

export interface ChecklistTemplate {
  id: string;
  companyId: string;
  name: string;
  items: string[];
  updatedAt: string;
}

function toTemplate(r: Tables<"checklist_templates">): ChecklistTemplate {
  return {
    id: r.id,
    companyId: r.company_id,
    name: r.name,
    items: cleanChecklistLabels(Array.isArray(r.items) ? r.items : []),
    updatedAt: r.updated_at,
  };
}

export async function listTemplates(ctx: TenantServiceContext, companyId: string): Promise<ChecklistTemplate[]> {
  const { data, error } = await ctx.supabase
    .from("checklist_templates")
    .select("*")
    .eq("organization_id", ctx.organizationId)
    .eq("company_id", companyId)
    .order("name", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((r) => toTemplate(r as Tables<"checklist_templates">));
}

export async function createTemplate(ctx: TenantServiceContext, input: z.infer<typeof templateSchema>): Promise<ChecklistTemplate> {
  const items = cleanChecklistLabels(input.items);
  if (items.length === 0) throw new ValidationError("Add at least one checklist item.");
  const { data, error } = await ctx.supabase
    .from("checklist_templates")
    .insert({ organization_id: ctx.organizationId, company_id: input.companyId, name: input.name, items, created_by: ctx.actorProfileId })
    .select("*")
    .single();
  if (error) throw error;
  return toTemplate(data as Tables<"checklist_templates">);
}

export async function updateTemplate(
  ctx: TenantServiceContext,
  templateId: string,
  input: z.infer<typeof templateUpdateSchema>,
): Promise<ChecklistTemplate> {
  const patch: { name?: string; items?: string[] } = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.items !== undefined) {
    patch.items = cleanChecklistLabels(input.items);
    if (patch.items.length === 0) throw new ValidationError("Add at least one checklist item.");
  }
  const { data, error } = await ctx.supabase
    .from("checklist_templates")
    .update(patch)
    .eq("organization_id", ctx.organizationId)
    .eq("id", templateId)
    .select("*")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new CrewNotFoundError("Checklist not found.");
  return toTemplate(data as Tables<"checklist_templates">);
}

export async function deleteTemplate(ctx: TenantServiceContext, templateId: string): Promise<void> {
  const { error } = await ctx.supabase.from("checklist_templates").delete().eq("organization_id", ctx.organizationId).eq("id", templateId);
  if (error) throw error;
}
