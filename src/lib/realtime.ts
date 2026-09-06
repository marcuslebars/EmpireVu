import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";

import { getSupabaseBrowserClient } from "@/lib/supabase";

/**
 * Live UI updates (Task 11). Subscribe to INSERTs on activity_events + message_log, scoped
 * to the active org, and invalidate the React Query families those inserts can change so the
 * dashboard, activity feed, open contact, and inbox refetch the moment something lands.
 *
 * What a subscriber can SEE is governed by the tables' RLS SELECT policies (the browser uses
 * the authenticated anon client) — the org filter here is a narrowing convenience, not the
 * security boundary. Verified separately (see the RUNBOOK): a non-member subscription
 * receives no rows.
 */

const WATCHED_TABLES = ["activity_events", "message_log"] as const;

// Minimal shape of the pieces of the Supabase realtime client we use — lets the hook be
// unit-tested with a mock channel without depending on supabase-js internals.
interface RealtimeChannelLike {
  on: (event: "postgres_changes", filter: Record<string, unknown>, cb: (payload: unknown) => void) => RealtimeChannelLike;
  subscribe: (cb?: (status: string) => void) => RealtimeChannelLike;
}
interface RealtimeClientLike {
  channel: (name: string) => RealtimeChannelLike;
  removeChannel: (channel: RealtimeChannelLike) => void;
}

/** Invalidate the query families an inbound activity/message insert can change. */
export function invalidateOrgRealtimeQueries(qc: QueryClient, orgId: string): void {
  void qc.invalidateQueries({ queryKey: ["dashboard"] });
  void qc.invalidateQueries({ queryKey: ["crm"] });
  void qc.invalidateQueries({ queryKey: ["inbox"] });
  void qc.invalidateQueries({ queryKey: ["automations", "jobs", orgId] });
}

/** Wire an org-scoped subscription; returns an unsubscribe fn. Pass a mock client to test. */
export function subscribeOrgRealtime(
  client: RealtimeClientLike,
  orgId: string,
  onChange: () => void,
): () => void {
  let channel = client.channel(`org-realtime:${orgId}`);
  for (const table of WATCHED_TABLES) {
    channel = channel.on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table, filter: `organization_id=eq.${orgId}` },
      () => onChange(),
    );
  }
  channel.subscribe();
  return () => client.removeChannel(channel);
}

export function useOrgRealtime(orgId: string): void {
  const qc = useQueryClient();
  useEffect(() => {
    if (!orgId) return;
    const client = getSupabaseBrowserClient();
    if (!client) return;
    return subscribeOrgRealtime(client as unknown as RealtimeClientLike, orgId, () =>
      invalidateOrgRealtimeQueries(qc, orgId),
    );
  }, [orgId, qc]);
}
