/**
 * Purchasing's background passes (docs/ai-staff.md → "Purchasing"):
 *
 *   purchasing:draft      every 10 min. Confirmed jobs with a quote that start between `lead_days`
 *                         and 14 days from now get a materials list and ONE materials_order
 *                         question each (at most `max_per_day` per company per local day).
 *                         Claimed per job in purchase_order_drafts (unique booking_id), so a job is
 *                         looked at once across workers; a failure is retried up to 3 times.
 *   purchasing:reminders  every 10 min. From 15:00 to 20:00 local the day before a job, one text
 *                         to the owner per PO that isn't picked up / delivered yet.
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { addDays, localDate, zonedInstant } from "@/server/services/booking-windows";
import { localHour } from "@/server/services/owner-channel/common";
import type { Db, PurchaseOrderDraftRow, PurchaseOrderRow } from "./db-types";
import { BOOKING_COLUMNS, defaultPurchasingDeps, draftForJob, jobName, toJobs, type PurchasingDeps } from "./orders";
import { HORIZON_DAYS, type PurchasingCompany } from "./settings";

const DAY = 86_400_000;
const RETRY_AFTER_MS = 30 * 60_000;
const MAX_ATTEMPTS = 3;
/** Jobs looked at per company per pass (the rest wait for the next pass). */
const JOBS_PER_PASS = 25;

/** The UTC instant of local midnight starting `dateStr`. */
function localMidnight(dateStr: string, timeZone: string): Date {
  return zonedInstant(dateStr, "00:00", timeZone);
}

/** Questions the draft sweep asked today (local) for a company. */
async function askedToday(admin: AdminClient, company: PurchasingCompany, nowMs: number): Promise<number> {
  const since = localMidnight(localDate(new Date(nowMs), company.timeZone), company.timeZone).toISOString();
  const { data, error } = await (admin as Db)
    .from("purchase_order_drafts")
    .select("id")
    .eq("company_id", company.companyId)
    .eq("outcome", "asked")
    .gte("updated_at", since);
  if (error) throw error;
  return ((data ?? []) as unknown[]).length;
}

/** Claim a job: a new claim row, or a failed one past its retry wait. Null → someone else has it. */
async function claimJob(admin: AdminClient, company: PurchasingCompany, bookingId: string, existing: PurchaseOrderDraftRow | undefined, nowMs: number): Promise<PurchaseOrderDraftRow | null> {
  const db = admin as Db;
  const nowIso = new Date(nowMs).toISOString();
  if (!existing) {
    const { data, error } = await db
      .from("purchase_order_drafts")
      .insert({ organization_id: company.organizationId, company_id: company.companyId, booking_id: bookingId, outcome: "working", attempts: 1, created_at: nowIso, updated_at: nowIso })
      .select("*")
      .single();
    if (error) return null;
    return data as PurchaseOrderDraftRow;
  }
  if (existing.outcome !== "failed" || existing.attempts >= MAX_ATTEMPTS || nowMs - Date.parse(existing.updated_at) < RETRY_AFTER_MS) return null;
  const { data } = await db
    .from("purchase_order_drafts")
    .update({ outcome: "working", attempts: existing.attempts + 1, updated_at: nowIso })
    .eq("id", existing.id)
    .eq("outcome", "failed")
    .eq("attempts", existing.attempts)
    .select("*");
  return ((data ?? []) as PurchaseOrderDraftRow[])[0] ?? null;
}

/** One company's draft pass. */
export async function runCompanyDrafts(admin: AdminClient, company: PurchasingCompany, nowMs: number, deps: PurchasingDeps = defaultPurchasingDeps): Promise<{ asked: number; skipped: number }> {
  const db = admin as Db;
  if (!company.settings.enabled || !company.active) return { asked: 0, skipped: 0 };
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
  const todo = rows.filter((b) => !hasPo.has(b.id) && (!claims.has(b.id) || claims.get(b.id)!.outcome === "failed")).slice(0, JOBS_PER_PASS);
  if (todo.length === 0) return { asked: 0, skipped: 0 };
  let budget = company.settings.maxPerDay - (await askedToday(admin, company, nowMs));
  if (budget <= 0) return { asked: 0, skipped: todo.length };
  const jobs = await toJobs(admin, company.organizationId, todo as never);
  let asked = 0;
  let skipped = 0;
  for (const job of jobs) {
    if (budget <= 0) break;
    const claim = await claimJob(admin, company, job.bookingId, claims.get(job.bookingId), nowMs);
    if (!claim) continue;
    try {
      const result = await draftForJob(admin, company, job, { source: "auto", nowMs }, deps);
      const outcome = result.outcome === "asked" ? "asked" : "no_materials";
      await db
        .from("purchase_order_drafts")
        .update({ outcome, purchase_order_id: result.outcome === "asked" ? result.po.id : null, last_error: null, updated_at: new Date(nowMs).toISOString() })
        .eq("id", claim.id);
      if (result.outcome === "asked") {
        asked += 1;
        budget -= 1;
      } else skipped += 1;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String((err as { message?: unknown })?.message ?? err);
      console.error("[purchasing] draft failed", job.bookingId, reason);
      await db.from("purchase_order_drafts").update({ outcome: "failed", last_error: reason.slice(0, 500), updated_at: new Date(nowMs).toISOString() }).eq("id", claim.id);
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
