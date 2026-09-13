import { defaultSenders, sendPushToOrganization, type PushMessage, type PushSenders } from "@/server/services/push/dispatch";
import { localDailySlotUtcMs } from "@/server/services/workflow-engine/timing";
import type { createSupabaseAdminClient } from "@/server/supabase/admin";

/**
 * Daily digest push: one summary each morning at 07:00 local — today's jobs, leads waiting
 * on a reply, overdue tasks. Runs inside the worker's scheduler pass. `push_digest_log`
 * makes it once-per-person-per-day even with several workers or a restart, and a digest
 * that is more than three hours late is skipped rather than sent in the evening.
 */
type Admin = ReturnType<typeof createSupabaseAdminClient>;

const DIGEST_TIME = "07:00";
const LATE_CUTOFF_MS = 3 * 3_600_000;

export interface DigestCounts {
  jobsToday: number;
  leadsWaiting: number;
  overdueTasks: number;
}

export function digestMessage(organizationId: string, counts: DigestCounts): PushMessage | null {
  if (counts.jobsToday + counts.leadsWaiting + counts.overdueTasks === 0) return null;
  const parts = [
    counts.jobsToday ? `${counts.jobsToday} job${counts.jobsToday === 1 ? "" : "s"} today` : null,
    counts.leadsWaiting ? `${counts.leadsWaiting} lead${counts.leadsWaiting === 1 ? "" : "s"} waiting` : null,
    counts.overdueTasks ? `${counts.overdueTasks} overdue task${counts.overdueTasks === 1 ? "" : "s"}` : null,
  ].filter(Boolean);
  return {
    title: "Good morning",
    body: `${parts.join(" · ")}.`,
    category: "daily_digest",
    data: { screen: "home", organizationId },
  };
}

function localDate(nowMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(nowMs);
}

async function countsFor(admin: Admin, organizationId: string, dayStartMs: number, nowMs: number): Promise<DigestCounts> {
  const dayStart = new Date(dayStartMs).toISOString();
  const dayEnd = new Date(dayStartMs + 86_400_000).toISOString();
  const now = new Date(nowMs).toISOString();

  const [jobs, leads, overdue] = await Promise.all([
    admin
      .from("bookings")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .in("status", ["pending", "confirmed"])
      .gte("scheduled_for", dayStart)
      .lt("scheduled_for", dayEnd),
    admin.from("ui_inbox_v").select("contact_id", { count: "exact", head: true }).eq("organization_id", organizationId).eq("needs_reply", true),
    admin
      .from("tasks")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .neq("status", "completed")
      .lt("due_at", now),
  ]);

  return { jobsToday: jobs.count ?? 0, leadsWaiting: leads.count ?? 0, overdueTasks: overdue.count ?? 0 };
}

export async function sendDailyDigests(admin: Admin, nowMs: number = Date.now(), senders: PushSenders = defaultSenders()): Promise<number> {
  if (!senders.ios && !senders.android) return 0;
  const timeZone = process.env.BUSINESS_TIMEZONE?.trim() || "America/Toronto";

  const slotMs = localDailySlotUtcMs(DIGEST_TIME, timeZone, nowMs);
  if (nowMs < slotMs || nowMs - slotMs > LATE_CUTOFF_MS) return 0;
  const digestDate = localDate(nowMs, timeZone);
  const dayStartMs = localDailySlotUtcMs("00:00", timeZone, nowMs);

  // Organizations with at least one live device.
  const { data: tokenRows } = await admin.from("device_tokens").select("organization_id, user_id").is("revoked_at", null);
  const usersByOrg = new Map<string, Set<string>>();
  for (const row of tokenRows ?? []) {
    const users = usersByOrg.get(row.organization_id) ?? new Set<string>();
    users.add(row.user_id);
    usersByOrg.set(row.organization_id, users);
  }

  let sent = 0;
  for (const [organizationId, users] of usersByOrg) {
    try {
      const { data: already } = await admin
        .from("push_digest_log")
        .select("user_id")
        .eq("organization_id", organizationId)
        .eq("digest_date", digestDate);
      const done = new Set((already ?? []).map((r) => r.user_id));
      const pending = [...users].filter((id) => !done.has(id));
      if (pending.length === 0) continue;

      // Claim first (unique key), so a second worker racing this pass sends nothing.
      const { data: claimed } = await admin
        .from("push_digest_log")
        .upsert(
          pending.map((user_id) => ({ organization_id: organizationId, user_id, digest_date: digestDate })),
          { onConflict: "organization_id,user_id,digest_date", ignoreDuplicates: true },
        )
        .select("user_id");
      const recipients = (claimed ?? []).map((r) => r.user_id);
      if (recipients.length === 0) continue;

      const message = digestMessage(organizationId, await countsFor(admin, organizationId, dayStartMs, nowMs));
      if (!message) continue;
      const result = await sendPushToOrganization(admin, organizationId, message, { recipientUserIds: recipients, senders, now: new Date(nowMs) });
      sent += result.sent;
    } catch (error) {
      console.error("[push] digest failed for org", organizationId, error instanceof Error ? error.message : error);
    }
  }
  return sent;
}
