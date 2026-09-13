/**
 * Pure inbox helpers (Task 12). `deriveNeedsReply` / `deriveUnread` are the canonical
 * semantics that `ui_inbox_v` computes in SQL — kept here as a client-safe, unit-tested
 * spec (the view is the runtime source; these guard the intended definition and are used
 * for any client-side recompute). `toChronological` orders a fetched thread page for chat
 * display, since `ui_conversation_thread` returns newest-first.
 */

function ms(ts: string | null): number | null {
  if (!ts) return null;
  const t = Date.parse(ts);
  return Number.isFinite(t) ? t : null;
}

/** A conversation needs a reply when the newest inbound is more recent than the newest outbound. */
export function deriveNeedsReply(lastInboundAt: string | null, lastOutboundAt: string | null): boolean {
  const inbound = ms(lastInboundAt);
  if (inbound === null) return false;
  const outbound = ms(lastOutboundAt);
  if (outbound === null) return true;
  return inbound > outbound;
}

/** Unread when the newest inbound arrived after this user last read the conversation. */
export function deriveUnread(lastInboundAt: string | null, lastReadAt: string | null): boolean {
  const inbound = ms(lastInboundAt);
  if (inbound === null) return false;
  const read = ms(lastReadAt);
  if (read === null) return true;
  return inbound > read;
}

/** Oldest→newest, for rendering a chat thread bottom-anchored. Stable, non-mutating. */
export function toChronological<T extends { occurred_at: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => (ms(a.occurred_at) ?? 0) - (ms(b.occurred_at) ?? 0));
}
