/**
 * A booking moved: wake every run that is waiting on it so the run re-times its wait
 * against the booking's new time (processor.resumeWorkflowRun re-resolves `until` waits
 * and re-pauses when the new time is still ahead). Without this, a "2 hours before"
 * reminder for a booking moved EARLIER would fire after the visit.
 *
 * Runs under the caller's client (members may update their org's runs); every query is
 * pinned to the caller's organization. Best-effort: never throws into the reschedule.
 */
import type { TenantServiceContext } from "@/server/services/shared";

export async function wakeWaitingRunsForBooking(ctx: TenantServiceContext, bookingId: string): Promise<number> {
  try {
    const { data: events, error } = await ctx.supabase
      .from("activity_events")
      .select("id")
      .eq("organization_id", ctx.organizationId)
      .eq("entity_type", "booking")
      .eq("entity_id", bookingId)
      .limit(200);
    if (error) throw error;
    const ids = (events ?? []).map((e: { id: string }) => e.id);
    if (ids.length === 0) return 0;
    const { data: woken, error: e2 } = await ctx.supabase
      .from("workflow_runs")
      .update({ resume_at: new Date().toISOString() })
      .eq("organization_id", ctx.organizationId)
      .eq("status", "waiting")
      .in("trigger_event_id", ids)
      .select("id");
    if (e2) throw e2;
    return (woken ?? []).length;
  } catch (err) {
    console.error("[workflow-engine] could not re-time waiting runs:", err instanceof Error ? err.message : err);
    return 0;
  }
}
