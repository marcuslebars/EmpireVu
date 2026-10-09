/**
 * sms_conversations: one row per customer per company. State + the one-turn-at-a-time lease.
 *
 * Serialization: a turn starts only after a conditional update moves lock_until from the past
 * into the future (`lock_until < now`), stamping a fresh lock_token. Postgres runs that update
 * atomically, so of two texts arriving together exactly one worker gets the turn; the other
 * returns at once and its text is picked up by the holder (it re-reads the thread after the
 * coalescing pause, and again after releasing — see entry.ts).
 */
import { randomUUID } from "node:crypto";

import type { AdminClient } from "@/server/services/front-desk/contracts";

export type ConversationState = "ai" | "owner" | "paused" | "closed";

export interface ConversationRow {
  id: string;
  organization_id: string;
  company_id: string;
  contact_id: string;
  state: ConversationState;
  ai_turns: number;
  last_inbound_at: string | null;
  last_ai_reply_at: string | null;
  owner_takeover_at: string | null;
  collected: Record<string, unknown>;
  summary: string | null;
  last_error: string | null;
  lock_until: string;
  lock_token: string | null;
  last_handled_inbound_at: string | null;
  created_at: string;
  updated_at?: string;
}

export const LEASE_FREE = "1970-01-01T00:00:00.000Z";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

function db(admin: AdminClient): Db {
  return admin as Db;
}

function normalize(row: Record<string, unknown>): ConversationRow {
  const collected = row.collected && typeof row.collected === "object" && !Array.isArray(row.collected) ? row.collected : {};
  return {
    ...(row as unknown as ConversationRow),
    state: (["ai", "owner", "paused", "closed"].includes(row.state as string) ? row.state : "ai") as ConversationState,
    ai_turns: Number(row.ai_turns ?? 0),
    collected: collected as Record<string, unknown>,
    lock_until: (row.lock_until as string | null) ?? LEASE_FREE,
  };
}

export async function findConversation(
  admin: AdminClient,
  key: { companyId: string; contactId: string },
): Promise<ConversationRow | null> {
  const { data, error } = await db(admin)
    .from("sms_conversations")
    .select("*")
    .eq("company_id", key.companyId)
    .eq("contact_id", key.contactId)
    .maybeSingle();
  if (error) throw error;
  return data ? normalize(data) : null;
}

/** Find or create the conversation (a concurrent create → re-read the winner's row). */
export async function ensureConversation(
  admin: AdminClient,
  key: { organizationId: string; companyId: string; contactId: string },
  initial: Partial<Pick<ConversationRow, "state" | "owner_takeover_at">> = {},
): Promise<ConversationRow> {
  const existing = await findConversation(admin, key);
  if (existing) return existing;
  const { data, error } = await db(admin)
    .from("sms_conversations")
    .insert({
      organization_id: key.organizationId,
      company_id: key.companyId,
      contact_id: key.contactId,
      state: initial.state ?? "ai",
      owner_takeover_at: initial.owner_takeover_at ?? null,
      collected: {},
      lock_until: LEASE_FREE,
    })
    .select("*")
    .single();
  if (error) {
    if ((error as { code?: string }).code === "23505") {
      const winner = await findConversation(admin, key);
      if (winner) return winner;
    }
    throw error;
  }
  return normalize(data);
}

/**
 * The state that applies right now: an owner takeover lapses after `takeoverMs` (72h) and the
 * AI picks the conversation back up.
 */
export function effectiveState(conv: Pick<ConversationRow, "state" | "owner_takeover_at">, now: Date, takeoverMs: number): ConversationState {
  if (conv.state !== "owner") return conv.state;
  const at = conv.owner_takeover_at ? Date.parse(conv.owner_takeover_at) : NaN;
  if (Number.isFinite(at) && now.getTime() - at >= takeoverMs) return "ai";
  return "owner";
}

/** When an owner takeover ends on its own (null when not taken over / no timestamp). */
export function takeoverEndsAt(conv: Pick<ConversationRow, "state" | "owner_takeover_at">, takeoverMs: number): string | null {
  if (conv.state !== "owner" || !conv.owner_takeover_at) return null;
  const at = Date.parse(conv.owner_takeover_at);
  return Number.isFinite(at) ? new Date(at + takeoverMs).toISOString() : null;
}

/** Take the turn lease. Returns the token, or null when another turn holds it. */
export async function claimTurn(admin: AdminClient, conversationId: string, now: Date, leaseMs: number): Promise<string | null> {
  const token = randomUUID();
  const { data, error } = await db(admin)
    .from("sms_conversations")
    .update({ lock_until: new Date(now.getTime() + leaseMs).toISOString(), lock_token: token })
    .eq("id", conversationId)
    .lt("lock_until", now.toISOString())
    .select("id, lock_token");
  if (error) throw error;
  const rows = (data ?? []) as Array<{ lock_token: string | null }>;
  return rows.length === 1 && rows[0].lock_token === token ? token : null;
}

/** Give the lease back (only if we still hold it). Best-effort: it also expires on its own. */
export async function releaseTurn(admin: AdminClient, conversationId: string, token: string): Promise<void> {
  try {
    await db(admin)
      .from("sms_conversations")
      .update({ lock_until: LEASE_FREE, lock_token: null })
      .eq("id", conversationId)
      .eq("lock_token", token);
  } catch (err) {
    console.error("[sms-agent] lease release failed:", err instanceof Error ? err.message : err);
  }
}

export async function updateConversation(
  admin: AdminClient,
  conversationId: string,
  patch: Partial<Omit<ConversationRow, "id" | "organization_id" | "company_id" | "contact_id" | "created_at">>,
): Promise<void> {
  const { error } = await db(admin).from("sms_conversations").update(patch).eq("id", conversationId);
  if (error) throw error;
}

/**
 * Update only if nobody took the conversation over meanwhile: state and owner_takeover_at must
 * still be what the turn started with. Returns false (nothing written) when they changed — the
 * owner stepped in mid-turn, and their takeover must not be overwritten with state 'ai'.
 */
export async function updateConversationIf(
  admin: AdminClient,
  conversationId: string,
  expected: Pick<ConversationRow, "state" | "owner_takeover_at">,
  patch: Partial<Omit<ConversationRow, "id" | "organization_id" | "company_id" | "contact_id" | "created_at">>,
): Promise<boolean> {
  let query = db(admin).from("sms_conversations").update(patch).eq("id", conversationId).eq("state", expected.state);
  query = expected.owner_takeover_at ? query.eq("owner_takeover_at", expected.owner_takeover_at) : query.is("owner_takeover_at", null);
  const { data, error } = await query.select("id");
  if (error) throw error;
  return ((data ?? []) as unknown[]).length === 1;
}

/** Shallow-merge into collected (arrays of ids are unioned). PURE. */
export function mergeCollected(current: Record<string, unknown>, add: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(add)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      const prev = Array.isArray(out[key]) ? (out[key] as unknown[]) : [];
      out[key] = [...new Set([...prev, ...value])].slice(-20);
    } else {
      out[key] = value;
    }
  }
  return out;
}
