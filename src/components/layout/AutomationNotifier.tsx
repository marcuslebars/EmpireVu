import { useEffect, useRef } from "react";

import { toast } from "@/components/ui/sonner";
import { useOrg } from "@/lib/org-context";
import { useDashboardActivity } from "@/lib/api-hooks";

const NOTIFIABLE_EVENTS = new Set(["workflow.executed", "contact.sms_received", "call.missed"]);

/**
 * Invisible component mounted in the app shell. Watches the org's activity feed
 * and pops a toast whenever a workflow fires, a customer replies by SMS, or a call
 * is missed — so these announce themselves instead of working silently. Realtime
 * (useOrgRealtime) refetches the feed on insert, so the poll is just a fallback.
 */
export function AutomationNotifier() {
  const { organizationId } = useOrg();
  const { data } = useDashboardActivity(
    organizationId,
    { limit: 20 },
    { refetchInterval: 30_000 },
  );

  // Tracks which workflow-execution events we've already surfaced. `null` means
  // "not seeded yet" — on the first successful load we record everything as seen
  // without toasting, so opening the app doesn't flood you with old runs.
  const seenRef = useRef<Set<string> | null>(null);

  // Reseed when the active organization changes (a switch shouldn't replay the
  // new org's history as fresh toasts).
  useEffect(() => {
    seenRef.current = null;
  }, [organizationId]);

  useEffect(() => {
    if (!data) return;

    const events = data.filter((event) => NOTIFIABLE_EVENTS.has(event.eventType));

    if (seenRef.current === null) {
      seenRef.current = new Set(events.map((event) => event.id));
      return;
    }

    const seen = seenRef.current;
    // Oldest-first so a burst of new events stacks in chronological order.
    const fresh = events.filter((event) => !seen.has(event.id)).reverse();

    for (const event of fresh) {
      seen.add(event.id);
      const metadata = (event.metadata ?? {}) as Record<string, unknown>;
      const name = event.entity?.label || "A contact";

      if (event.eventType === "contact.sms_received") {
        const preview = typeof metadata.bodyPreview === "string" ? metadata.bodyPreview : undefined;
        toast(`💬 New reply from ${name}`, preview ? { description: preview } : undefined);
        continue;
      }

      if (event.eventType === "call.missed") {
        toast(`📞 Missed call from ${name}`, { description: "No answer or voicemail — follow up." });
        continue;
      }

      // workflow.executed
      const tasks = Number(metadata.createdTasksCount ?? 0);
      const actions = Number(metadata.actionsExecutedCount ?? 0);
      const workflowName = event.entity?.label || "A workflow";
      const description =
        tasks > 0
          ? `Created ${tasks} task${tasks === 1 ? "" : "s"}`
          : actions > 0
            ? `${actions} action${actions === 1 ? "" : "s"} run`
            : "Automation executed";

      toast(`⚡ ${workflowName} ran`, { description });
    }
  }, [data]);

  return null;
}
