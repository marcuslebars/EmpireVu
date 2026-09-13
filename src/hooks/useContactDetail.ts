import { useEffect, useMemo, useRef, useState } from "react";

import { useSyncContactCalls } from "@/lib/api-hooks";
import type { ContactDetailResponse } from "@/lib/api-client";

/**
 * Page-level state + effects for the contact-detail view (Task 12 decomposition). Holds the
 * active tab and the shared dialog open-states (the "New task" dialog is opened from both
 * the header's next-action banner and the Tasks tab), and runs the once-per-view call-sync
 * that resolves any placed-but-unreconciled Marina calls.
 */
export function useContactDetailController(orgId: string, detail: ContactDetailResponse) {
  const [activeTab, setActiveTab] = useState("activity");
  const [taskOpen, setTaskOpen] = useState(false);
  const [bookingOpen, setBookingOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  const { timeline } = detail;
  const contactId = detail.contact.id;
  const syncCalls = useSyncContactCalls(orgId, contactId);

  // A placed call carries `agentCallId`; its outcome event adds `callStatus`. Anything
  // placed without a matching outcome is still unresolved.
  const hasUnresolvedCalls = useMemo(() => {
    const placed = new Set<string>();
    const resolved = new Set<string>();
    for (const item of timeline) {
      const meta = item.metadata as Record<string, unknown> | undefined;
      const callId = meta?.agentCallId;
      if (typeof callId !== "string") continue;
      if (typeof meta?.callStatus === "string") resolved.add(callId);
      else placed.add(callId);
    }
    return [...placed].some((id) => !resolved.has(id));
  }, [timeline]);

  // Fire once per view — the endpoint is idempotent, and a call that's still ringing stays
  // unresolved, so a ref keeps this from looping.
  const attemptedCallSync = useRef(false);
  useEffect(() => {
    if (!hasUnresolvedCalls || attemptedCallSync.current) return;
    attemptedCallSync.current = true;
    syncCalls.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasUnresolvedCalls]);

  return {
    activeTab,
    setActiveTab,
    taskOpen,
    setTaskOpen,
    bookingOpen,
    setBookingOpen,
    editOpen,
    setEditOpen,
  };
}
