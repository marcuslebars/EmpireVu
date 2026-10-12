/**
 * Purchasing's background passes (docs/ai-staff.md → "Purchasing"):
 *
 *   purchasing:draft      every 10 min. Confirmed jobs with a quote that start between `lead_days`
 *                         and 14 days from now get a materials list and ONE materials_order
 *                         question each (at most `max_per_day` per company per local day).
 *                         Claimed per job in purchase_order_drafts (claims.ts), the daily cap by a
 *                         per-day counter; a failure is retried up to 3 times, a dead worker's
 *                         claim after 15 min. Draft orders that never got their question are cleared.
 *   purchasing:reminders  every 10 min. From 15:00 to 20:00 local the day before a job, one text
 *                         to the owner per PO that isn't picked up / delivered yet. Also (08:00–21:00)
 *                         a text when a job with an order out is moved to another day or cancelled.
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { addDays, localDate, zonedInstant } from "@/server/services/booking-windows";
import { localHour } from "@/server/services/owner-channel/common";
import { claimable, claimDraft, finishDraft, releaseDailySlot, reserveDailySlot } from "./claims";
import type { Db, PurchaseOrderDraftRow, PurchaseOrderRow } from "./db-types";
import { dayLabel } from "./format";
import { AlreadyOrderedError, BOOKING_COLUMNS, clearOrphanDrafts, defaultPurchasingDeps, draftForJob, jobName, toJobs, type PurchasingDeps } from "./orders";
import { HORIZON_DAYS, type PurchasingCompany } from "./settings";

const DAY = 86_400_000;
/** Jobs looked at per company per pass (the rest wait for the next pass). */
const JOBS_PER_PASS = 25;

/** The UTC instant of local midnight starting `dateStr`. */
function localMidnight(dateStr: string, timeZone: string): Date {
  return zonedInstant(dateStr, "00:00", timeZone);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String((err as { message?: unknown })?.message ?? err);
}

/** One company's draft pass. */
export async function runCompanyDrafts(admin: AdminClient, company: PurchasingCompany, nowMs: number, deps: PurchasingDeps = defaultPurchasingDeps): Promise<{ asked: number; skipped: number }> {
  const db = admin as Db;
  if (!company.settings.enabled || !company.active) return { asked: 0, skipped: 0 };
  await clearOrphanDrafts(admin, company.companyId, nowMs);
  const from = new Date(nowMs + company.settings.leadDays * DAY).toISOString();
  const to = new Date(nowMs + HORIZON_DAYS * DAY).toISOString();
  if (from >= to) return { asked: 0, skipped: 0 };
  const { data: bookings, error } = await db
    .from("bookings")
    .select(BOOKING_COLUMNS)
    .eq("organization_id", company.organizationId)
    .eq("company_id", company.companyId)
    .eq("status", "confirmed")
    .not("quote_id", "is", null)
    .gte("scheduled_for", from)
    .lt("scheduled_for", to)
    .order("scheduled_for", { ascending: true })
    .limit(200);
  if (error) throw error;
  const rows = ((bookings ?? []) as Array<{ id: string; quote_id: string | null }>).filter((b) => b.quote_id);
  if (rows.length === 0) return { asked: 0, skipped: 0 };
  const ids = rows.map((b) => b.id);
  const claims = new Map<string, PurchaseOrderDraftRow>();
  const hasPo = new Set<string>();
  for (let i = 0; i < ids.length; i += 200) {
    const part = ids.slice(i, i + 200);
    const [{ data: drafts, error: e1 }, { data: pos, error: e2 }] = await Promise.all([
      db.from("purchase_order_drafts").select("*").eq("company_id", company.companyId).in("booking_id", part),
      db.from("purchase_orders").select("booking_id, status").eq("company_id", company.companyId).in("booking_id", part),
    ]);
    if (e1) throw e1;
    if (e2) throw e2;
    for (const d of (drafts ?? []) as PurchaseOrderDraftRow[]) claims.set(d.booking_id, d);
    // A job the owner already ordered for by hand (order_materials) isn't drafted again.
    for (const p of (pos ?? []) as Array<{ booking_id: string; status: string }>) if (p.status !== "cancelled") hasPo.add(p.booking_id);
  }
  const todo = rows.filter((b) => !hasPo.has(b.id) && (!claims.has(b.id) || claimable(claims.get(b.id)!, nowMs))).slice(0, JOBS_PER_PASS);
  if (todo.length === 0) return { asked: 0, skipped: 0 };
  const today = localDate(new Date(nowMs), company.timeZone);
  const jobs = await toJobs(admin, company.organizationId, todo as never);
  let asked = 0;
  let skipped = 0;
  for (const job of jobs) {
    // The day's slot first (a conditional increment), so overlapping workers can't pass the cap.
    if (!(await reserveDailySlot(admin, company, today, company.settings.maxPerDay))) {
      skipped += 1;
      break;
    }
    const claim = await claimDraft(admin, company, job.bookingId, nowMs, { existing: claims.get(job.bookingId) ?? null });
    if (!claim) {
      await releaseDailySlot(admin, company.companyId, today);
      continue;
    }
    try {
      const result = await draftForJob(admin, company, job, { source: "auto", nowMs }, deps);
      if (result.outcome === "asked") {
        await finishDraft(admin, claim.id, "asked", { poId: result.po.id }, nowMs);
        asked += 1;
      } else {
        await finishDraft(admin, claim.id, "no_materials", {}, nowMs);
        await releaseDailySlot(admin, company.companyId, today);
        skipped += 1;
      }
    } catch (err) {
      await releaseDailySlot(admin, company.companyId, today);
      if (err instanceof AlreadyOrderedError) {
        await finishDraft(admin, claim.id, "already_ordered", {}, nowMs);
        continue;
      }
      const reason = errorText(err);
      console.error("[purchasing] draft failed", job.bookingId, reason);
      await finishDraft(admin, claim.id, "failed", { error: reason }, nowMs);
    }
  }
  return { asked, skipped };
}

// ── The day-before reminder ─────────────────────────────────────────────────────

/** POs still waiting on pickup / delivery. */
export const WAITING_STATUSES = ["approved", "sent", "confirmed", "ready"] as const;
const REMIND_FROM_HOUR = 15;
const REMIND_UNTIL_HOUR = 20;

/** The reminder text for one PO. PURE. */
export function reminderText(input: { poNumber: string; supplier: string | null; job: string; jobTime: string; fulfilment: "pickup" | "delivery"; status: string }): string {
  const from = input.supplier ? ` from ${input.supplier}` : "";
  if (input.fulfilment === "delivery") {
    return `Tomorrow: ${input.job} (${input.jobTime}). Materials ${input.poNumber}${from} aren't marked delivered yet - check with the supplier. Text "${input.poNumber} delivered" when they're on site.`;
  }
  const ready = input.status === "ready" ? " (marked ready)" : "";
  return `Tomorrow: ${input.job} (${input.jobTime}). Materials ${input.poNumber}${from} aren't picked up yet${ready}. Text "${input.poNumber} picked up" once you have them.`;
}

/** One company's reminder pass: the afternoon before each job with a PO not picked up / delivered. */
export async function runCompanyReminders(admin: AdminClient, company: PurchasingCompany, nowMs: number, deps: PurchasingDeps = defaultPurchasingDeps): Promise<number> {
  if (!company.settings.enabled || !company.active || !company.ownerPhone) return 0;
  const hour = localHour(nowMs, company.timeZone);
  if (hour < REMIND_FROM_HOUR || hour >= REMIND_UNTIL_HOUR) return 0;
  const db = admin as Db;
  const tomorrow = addDays(localDate(new Date(nowMs), company.timeZone), 1);
  const start = localMidnight(tomorrow, company.timeZone).toISOString();
  const end = localMidnight(addDays(tomorrow, 1), company.timeZone).toISOString();
  const { data: pos, error } = await db
    .from("purchase_orders")
    .select("*")
    .eq("organization_id", company.organizationId)
    .eq("company_id", company.companyId)
    .in("status", [...WAITING_STATUSES])
    .is("reminder_sent_at", null)
    .limit(100);
  if (error) throw error;
  const open = ((pos ?? []) as PurchaseOrderRow[]).filter((p) => p.booking_id);
  if (open.length === 0) return 0;
  const { data: bookings, error: bErr } = await db
    .from("bookings")
    .select(BOOKING_COLUMNS)
    .eq("organization_id", company.organizationId)
    .eq("company_id", company.companyId)
    .in("id", open.map((p) => p.booking_id))
    .in("status", ["pending", "confirmed"])
    .gte("scheduled_for", start)
    .lt("scheduled_for", end);
  if (bErr) throw bErr;
  const jobs = new Map((await toJobs(admin, company.organizationId, (bookings ?? []) as never)).map((j) => [j.bookingId, j]));
  let sent = 0;
  for (const po of open) {
    const job = po.booking_id ? jobs.get(po.booking_id) : undefined;
    if (!job) continue;
    const nowIso = new Date(nowMs).toISOString();
    const { data: claimed } = await db.from("purchase_orders").update({ reminder_sent_at: nowIso }).eq("id", po.id).is("reminder_sent_at", null).select("id");
    if (((claimed ?? []) as unknown[]).length === 0) continue;
    const jobTime = new Date(job.scheduledFor).toLocaleTimeString("en-CA", { timeZone: company.timeZone, hour: "numeric", minute: "2-digit" });
    const result = await deps.textOwner(admin, company, reminderText({ poNumber: po.po_number, supplier: po.supplier_name, job: jobName(job), jobTime, fulfilment: po.fulfilment, status: po.status }));
    if (result.status === "failed") await db.from("purchase_orders").update({ reminder_sent_at: null }).eq("id", po.id);
    else sent += 1;
  }
  return sent;
}

// ── A job with an order out was moved or cancelled ───────────────────────────────

const OWNER_FROM_HOUR = 8;
const OWNER_UNTIL_HOUR = 21;

/** The owner's text about a moved / cancelled job. PURE. */
export function jobChangeText(input: { job: string; poNumber: string; supplier: string | null; fulfilment: "pickup" | "delivery"; neededBy: string | null; movedTo: string | null }): string {
  const at = input.supplier ? ` at ${input.supplier}` : "";
  if (!input.movedTo) return `${input.job} was cancelled - ${input.poNumber}${at} is still on order. Call them to cancel, then text "cancel ${input.poNumber}".`;
  const says = input.neededBy ? ` still says ${input.fulfilment === "pickup" ? "pickup" : "delivery"} ${dayLabel(input.neededBy)}` : " is still on order";
  return `${input.job} moved to ${input.movedTo} - ${input.poNumber}${at}${says}; call them.`;
}

/**
 * Orders that are out (approved / sent / confirmed / ready) whose job moved to another local day or
 * was cancelled (or deleted): one text each, claimed by a conditional update on the job time we last
 * knew. A move also clears reminder_sent_at, so the day-before reminder follows the new day.
 */
export async function runCompanyJobChanges(admin: AdminClient, company: PurchasingCompany, nowMs: number, deps: PurchasingDeps = defaultPurchasingDeps): Promise<number> {
  if (!company.settings.enabled || !company.active) return 0;
  const hour = localHour(nowMs, company.timeZone);
  if (hour < OWNER_FROM_HOUR || hour >= OWNER_UNTIL_HOUR) return 0;
  const db = admin as Db;
  const { data: pos, error } = await db
    .from("purchase_orders")
    .select("*")
    .eq("organization_id", company.organizationId)
    .eq("company_id", company.companyId)
    .in("status", [...WAITING_STATUSES])
    .limit(200);
  if (error) throw error;
  const open = ((pos ?? []) as PurchaseOrderRow[]).filter((p) => p.job_scheduled_for && p.job_change_notice !== "cancelled");
  if (open.length === 0) return 0;
  const bookingIds = [...new Set(open.map((p) => p.booking_id).filter((id): id is string => Boolean(id)))];
  const { data: bookings, error: bErr } = bookingIds.length
    ? await db.from("bookings").select(BOOKING_COLUMNS).eq("organization_id", company.organizationId).eq("company_id", company.companyId).in("id", bookingIds)
    : { data: [], error: null };
  if (bErr) throw bErr;
  const jobs = new Map((await toJobs(admin, company.organizationId, (bookings ?? []) as never)).map((j) => [j.bookingId, j]));
  let told = 0;
  for (const po of open) {
    const job = po.booking_id ? jobs.get(po.booking_id) : undefined;
    if (job?.status === "completed") continue;
    const cancelled = !job || job.status === "cancelled" || job.status === "no_show";
    const was = localDate(new Date(po.job_scheduled_for!), company.timeZone);
    const now = job ? localDate(new Date(job.scheduledFor), company.timeZone) : null;
    if (!cancelled && now === was) continue;
    const label = job ? jobName(job) : po.job_label ?? po.po_number;
    const update: Record<string, unknown> = cancelled
      ? { job_change_notice: "cancelled" }
      : { job_scheduled_for: job!.scheduledFor, job_change_notice: `moved:${job!.scheduledFor}`, reminder_sent_at: null };
    const { data: claimed } = await db.from("purchase_orders").update(update).eq("id", po.id).eq("job_scheduled_for", po.job_scheduled_for).select("id");
    if (((claimed ?? []) as unknown[]).length === 0) continue;
    const body = jobChangeText({ job: label, poNumber: po.po_number, supplier: po.supplier_name, fulfilment: po.fulfilment, neededBy: po.needed_by, movedTo: cancelled ? null : dayLabel(now) });
    const sent = await deps.textOwner(admin, company, body);
    if (sent.status === "failed") {
      // Give the change back so the next pass tells them.
      await db.from("purchase_orders").update({ job_scheduled_for: po.job_scheduled_for, job_change_notice: po.job_change_notice, reminder_sent_at: po.reminder_sent_at }).eq("id", po.id);
      continue;
    }
    told += 1;
  }
  return told;
}
