import type { Json, Tables } from "@/server/db/database.types";
import { createActivityEvent } from "@/server/services/activity-events";
import { sendDailyDigests } from "@/server/services/push/digest";
import { processOwnerDigests } from "@/server/services/owner-digest";
import type { TenantServiceContext } from "@/server/services/shared";
import type { createSupabaseAdminClient } from "@/server/supabase/admin";
import { emitActivityEventAndDispatch } from "@/server/services/workflow-engine/dispatch";
import { resumeWorkflowRun, runWorkflowNow } from "@/server/services/workflow-engine/processor";
import { localDailySlotUtcMs } from "@/server/services/workflow-engine/timing";

/**
 * Time-driven workflow work, run inside the existing worker (Task 9): resume due waiting
 * runs, materialize + process schedule.daily ticks, and scan for booking.upcoming /
 * quote.expiring / contact.stale. All service-role (cross-tenant), all idempotent.
 */
type Admin = ReturnType<typeof createSupabaseAdminClient>;

function ctxFor(admin: Admin, organizationId: string): TenantServiceContext {
  return { organizationId, actorProfileId: null, supabase: admin };
}

function fallbackTimezone(): string {
  return process.env.BUSINESS_TIMEZONE?.trim() || "America/Toronto";
}

interface ScheduleConfig {
  dailyTime: string;
  hoursBefore: number;
  staleDays: number;
}

function scheduleConfig(definition: Json): ScheduleConfig {
  const record = definition && typeof definition === "object" && !Array.isArray(definition)
    ? (definition as Record<string, unknown>)
    : {};
  const schedule = record.schedule && typeof record.schedule === "object" && !Array.isArray(record.schedule)
    ? (record.schedule as Record<string, unknown>)
    : {};
  return {
    dailyTime: typeof schedule.daily_time === "string" ? schedule.daily_time : "09:00",
    hoursBefore: typeof schedule.hours_before === "number" ? schedule.hours_before : 24,
    staleDays: typeof schedule.stale_days === "number" ? schedule.stale_days : 7,
  };
}

async function companyTimezone(admin: Admin, organizationId: string, companyId: string | null): Promise<string> {
  if (!companyId) return fallbackTimezone();
  const { data } = await admin
    .from("companies")
    .select("timezone")
    .eq("organization_id", organizationId)
    .eq("id", companyId)
    .maybeSingle();
  return (data as { timezone: string | null } | null)?.timezone?.trim() || fallbackTimezone();
}

async function activeWorkflowsForTriggers(admin: Admin, triggers: string[]): Promise<Tables<"workflows">[]> {
  const { data, error } = await admin
    .from("workflows")
    .select("*")
    .eq("status", "active")
    .in("trigger_event", triggers);
  if (error) throw error;
  return (data ?? []) as Tables<"workflows">[];
}

/** Has an activity event of this type already been emitted for the entity since `sinceIso`? */
async function recentEvents(
  admin: Admin,
  organizationId: string,
  entityId: string,
  eventType: string,
  sinceIso: string,
): Promise<Array<{ metadata_json: Json }>> {
  const { data } = await admin
    .from("activity_events")
    .select("metadata_json")
    .eq("organization_id", organizationId)
    .eq("entity_id", entityId)
    .eq("event_type", eventType)
    .gte("occurred_at", sinceIso)
    .limit(20);
  return (data ?? []) as Array<{ metadata_json: Json }>;
}

// ── Resume due waiting runs ──────────────────────────────────────────────────
export async function resumeDueWorkflowRuns(
  admin: Admin,
  options: { batch?: number; staleAfterSeconds?: number } = {},
): Promise<number> {
  const { data, error } = await admin.rpc("claim_waiting_workflow_runs", {
    p_batch: options.batch ?? 10,
    p_stale_after_seconds: options.staleAfterSeconds ?? 900,
  });
  if (error) throw error;
  const runs = (data ?? []) as Tables<"workflow_runs">[];
  for (const run of runs) {
    try {
      await resumeWorkflowRun(ctxFor(admin, run.organization_id), run);
    } catch (err) {
      console.error("[scheduler] resume failed", run.id, err instanceof Error ? err.message : err);
    }
  }
  return runs.length;
}

// ── schedule.daily ───────────────────────────────────────────────────────────
export async function materializeDailyTicks(admin: Admin, nowMs: number = Date.now()): Promise<number> {
  const workflows = await activeWorkflowsForTriggers(admin, ["schedule.daily"]);
  let inserted = 0;
  for (const workflow of workflows) {
    const cfg = scheduleConfig(workflow.definition);
    const tz = await companyTimezone(admin, workflow.organization_id, workflow.company_id);
    const slotMs = localDailySlotUtcMs(cfg.dailyTime, tz, nowMs);
    if (slotMs > nowMs) continue; // today's slot hasn't arrived
    const { error } = await admin.from("workflow_schedule_ticks").upsert(
      {
        organization_id: workflow.organization_id,
        workflow_id: workflow.id,
        scheduled_for: new Date(slotMs).toISOString(),
        status: "pending",
      },
      { onConflict: "workflow_id,scheduled_for", ignoreDuplicates: true },
    );
    if (!error) inserted += 1;
  }
  return inserted;
}

export async function processDueScheduleTicks(admin: Admin, workerId: string): Promise<number> {
  const { data, error } = await admin.rpc("claim_workflow_schedule_ticks", {
    p_batch: 50,
    p_worker_id: workerId,
    p_stale_after_seconds: 300,
  });
  if (error) throw error;
  const ticks = (data ?? []) as Tables<"workflow_schedule_ticks">[];

  for (const tick of ticks) {
    try {
      const context = ctxFor(admin, tick.organization_id);
      const { data: workflowRow } = await admin
        .from("workflows")
        .select("*")
        .eq("id", tick.workflow_id)
        .maybeSingle();
      const workflow = workflowRow as Tables<"workflows"> | null;
      if (!workflow) {
        await admin.from("workflow_schedule_ticks").update({ status: "completed" }).eq("id", tick.id);
        continue;
      }
      // A per-workflow schedule fires exactly this workflow (not all schedule.daily ones).
      const event = await createActivityEvent(context, {
        companyId: workflow.company_id,
        entityId: workflow.id,
        entityType: "workflow",
        eventType: workflow.trigger_event,
        metadata: { scheduledFor: tick.scheduled_for, scheduleTickId: tick.id },
      });
      await runWorkflowNow(context, workflow.id, { eventId: event.id });
      await admin.from("workflow_schedule_ticks").update({ status: "completed" }).eq("id", tick.id);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await admin.from("workflow_schedule_ticks").update({ status: "failed", last_error: reason }).eq("id", tick.id);
      console.error("[scheduler] tick failed", tick.id, reason);
    }
  }
  return ticks.length;
}

// ── Entity-driven scheduled triggers ─────────────────────────────────────────
async function emitEntityTrigger(
  admin: Admin,
  args: { organizationId: string; companyId: string | null; entityType: string; entityId: string; eventType: string; metadata: Record<string, unknown> },
): Promise<void> {
  await emitActivityEventAndDispatch(ctxFor(admin, args.organizationId), {
    companyId: args.companyId,
    entityId: args.entityId,
    entityType: args.entityType,
    eventType: args.eventType,
    metadata: args.metadata,
  });
}

export async function scanBookingUpcoming(admin: Admin, nowMs: number = Date.now()): Promise<number> {
  const workflows = await activeWorkflowsForTriggers(admin, ["booking.upcoming"]);
  if (workflows.length === 0) return 0;
  const maxHoursBefore = Math.max(...workflows.map((w) => scheduleConfig(w.definition).hoursBefore));
  const windowEnd = new Date(nowMs + maxHoursBefore * 3_600_000).toISOString();
  const nowIso = new Date(nowMs).toISOString();

  const { data } = await admin
    .from("bookings")
    .select("id, organization_id, company_id, scheduled_for, status")
    .in("status", ["pending", "confirmed"])
    .gte("scheduled_for", nowIso)
    .lte("scheduled_for", windowEnd)
    .limit(500);
  const bookings = (data ?? []) as Array<Pick<Tables<"bookings">, "id" | "organization_id" | "company_id" | "scheduled_for">>;

  let emitted = 0;
  const since = new Date(nowMs - 30 * 86_400_000).toISOString();
  for (const booking of bookings) {
    const prior = await recentEvents(admin, booking.organization_id, booking.id, "booking.upcoming", since);
    if (prior.length > 0) continue; // already fired for this booking
    await emitEntityTrigger(admin, {
      organizationId: booking.organization_id,
      companyId: booking.company_id,
      entityType: "booking",
      entityId: booking.id,
      eventType: "booking.upcoming",
      metadata: { scheduledFor: booking.scheduled_for },
    });
    emitted += 1;
  }
  return emitted;
}

export async function scanQuoteExpiring(admin: Admin, nowMs: number = Date.now()): Promise<number> {
  const workflows = await activeWorkflowsForTriggers(admin, ["quote.expiring"]);
  if (workflows.length === 0) return 0;
  const windowEnd = new Date(nowMs + 24 * 3_600_000).toISOString();
  const nowIso = new Date(nowMs).toISOString();

  const { data } = await admin
    .from("quotes")
    .select("id, organization_id, company_id, contact_id, valid_until, approved_at")
    .is("approved_at", null)
    .gte("valid_until", nowIso)
    .lte("valid_until", windowEnd)
    .limit(500);
  const quotes = (data ?? []) as Array<{ id: string; organization_id: string; company_id: string | null; contact_id: string | null; valid_until: string | null }>;

  let emitted = 0;
  const since = new Date(nowMs - 3 * 86_400_000).toISOString();
  for (const quote of quotes) {
    // Anchor to the contact (a valid trace entity); dedup per-quote via metadata.quoteId.
    const anchorId = quote.contact_id ?? quote.company_id;
    if (!anchorId) continue;
    const anchorType = quote.contact_id ? "contact" : "company";
    const prior = await recentEvents(admin, quote.organization_id, anchorId, "quote.expiring", since);
    const alreadyForThisQuote = prior.some((event) => {
      const meta = event.metadata_json && typeof event.metadata_json === "object" && !Array.isArray(event.metadata_json)
        ? (event.metadata_json as Record<string, unknown>)
        : {};
      return meta.quoteId === quote.id;
    });
    if (alreadyForThisQuote) continue;
    await emitEntityTrigger(admin, {
      organizationId: quote.organization_id,
      companyId: quote.company_id,
      entityType: anchorType,
      entityId: anchorId,
      eventType: "quote.expiring",
      metadata: { quoteId: quote.id, validUntil: quote.valid_until },
    });
    emitted += 1;
  }
  return emitted;
}

export async function scanContactStale(admin: Admin, nowMs: number = Date.now()): Promise<number> {
  const workflows = await activeWorkflowsForTriggers(admin, ["contact.stale"]);
  if (workflows.length === 0) return 0;
  const staleDays = Math.max(...workflows.map((w) => scheduleConfig(w.definition).staleDays));
  const cutoffIso = new Date(nowMs - staleDays * 86_400_000).toISOString();

  // Lead-stage contacts untouched since the cutoff (updated_at is a cheap first filter).
  const { data } = await admin
    .from("contacts")
    .select("id, organization_id, company_id, updated_at")
    .eq("stage", "lead")
    .lte("updated_at", cutoffIso)
    .order("updated_at", { ascending: true })
    .limit(200);
  const contacts = (data ?? []) as Array<Pick<Tables<"contacts">, "id" | "organization_id" | "company_id" | "updated_at">>;

  let emitted = 0;
  for (const contact of contacts) {
    // Confirm no activity since the cutoff, and not already flagged stale in this window.
    const { data: recent } = await admin
      .from("activity_events")
      .select("event_type")
      .eq("organization_id", contact.organization_id)
      .eq("entity_id", contact.id)
      .gte("occurred_at", cutoffIso)
      .limit(1);
    if ((recent ?? []).length > 0) continue;
    await emitEntityTrigger(admin, {
      organizationId: contact.organization_id,
      companyId: contact.company_id,
      entityType: "contact",
      entityId: contact.id,
      eventType: "contact.stale",
      metadata: { staleSince: contact.updated_at },
    });
    emitted += 1;
  }
  return emitted;
}

/** One scheduler pass — called ~once/minute by the worker. */
export async function runScheduler(
  admin: Admin,
  options: { workerId: string; nowMs?: number },
): Promise<{ ticksMaterialized: number; ticksProcessed: number; entitiesEmitted: number }> {
  const nowMs = options.nowMs ?? Date.now();
  const ticksMaterialized = await materializeDailyTicks(admin, nowMs);
  const ticksProcessed = await processDueScheduleTicks(admin, options.workerId);
  const entitiesEmitted =
    (await scanBookingUpcoming(admin, nowMs)) +
    (await scanQuoteExpiring(admin, nowMs)) +
    (await scanContactStale(admin, nowMs));
  // Mobile morning digest (push). Never lets a push problem break the scheduler pass.
  await sendDailyDigests(admin, nowMs).catch((error) =>
    console.error("[scheduler] digest failed", error instanceof Error ? error.message : error),
  );
  // Owner daily digest (SMS/email, per-company, Task 15) — self-guarded + idempotent per
  // (company, local_date). Distinct from the push digest above (different channel/audience).
  await processOwnerDigests(admin, nowMs).catch((error) =>
    console.error("[scheduler] owner digest failed", error instanceof Error ? error.message : error),
  );
  return { ticksMaterialized, ticksProcessed, entitiesEmitted };
}
