/**
 * Owner approvals: parse "Y" / "N 2" / "Y but $700", pick the right pending owner_approvals
 * row, claim it with a conditional update (so a double reply or an app click racing a text
 * can't run it twice), run it, and store the result. One decide path for SMS, the app and
 * expiry (docs/front-desk-ai.md "## Owner by text").
 */
import type { Tables } from "@/server/db/database.types";
import { toJson } from "@/server/db/json";
import type {
  AdminClient,
  ApprovalDecision,
  ApprovalStatus,
  ExecuteResult,
  OwnerApprovalRow,
} from "@/server/services/front-desk/contracts";
import { executeApprovedAction } from "@/server/services/sms-agent/approved";
import { executeOwnerCommand, OWNER_COMMAND_KIND } from "./owner-commands";

type ApprovalDbRow = Tables<"owner_approvals">;

// ── Parsing ───────────────────────────────────────────────────────────────────

export interface ParsedApprovalReply {
  approved: boolean;
  code: number | null;
  note: string | null;
}

const YES_WORDS = new Set(["y", "yes", "yep", "yup", "ok", "okay", "approve", "approved"]);
const NO_WORDS = new Set(["n", "no", "nope", "skip"]);
const REPLY_RE = /^\s*([a-z]+?)\s*#?\s*(\d{1,2})?(?=$|[\s,.:;!\-–—])\s*[,.:;!\-–—]*\s*([\s\S]*)$/i;

/**
 * "Y", "YES", "OK", "N", "NO", "Y 2", "N2", "Y but $700", "N tell them next week" → a decision.
 * Anything else → null (it's a command, not an approval reply).
 */
export function parseApprovalReply(body: string): ParsedApprovalReply | null {
  const match = REPLY_RE.exec(body ?? "");
  if (!match) return null;
  const word = match[1].toLowerCase();
  const approved = YES_WORDS.has(word) ? true : NO_WORDS.has(word) ? false : null;
  if (approved === null) return null;
  const code = match[2] ? Number.parseInt(match[2], 10) : null;
  const note = match[3]?.trim() || null;
  return { approved, code, note };
}

// ── Rows ──────────────────────────────────────────────────────────────────────

export function toApprovalRow(row: ApprovalDbRow): OwnerApprovalRow {
  return {
    id: row.id,
    organization_id: row.organization_id,
    company_id: row.company_id,
    contact_id: row.contact_id,
    conversation_id: row.conversation_id,
    kind: row.kind,
    summary: row.summary,
    payload: (row.payload && typeof row.payload === "object" && !Array.isArray(row.payload) ? row.payload : {}) as Record<string, unknown>,
    status: row.status as ApprovalStatus,
    short_code: row.short_code,
    requested_by: row.requested_by,
    expires_at: row.expires_at,
    created_at: row.created_at,
  };
}

export function isExpired(row: Pick<ApprovalDbRow, "expires_at">, nowMs: number): boolean {
  return Boolean(row.expires_at && Date.parse(row.expires_at) <= nowMs);
}

/** Pending approvals for these companies, oldest first. */
export async function listPendingApprovals(admin: AdminClient, companyIds: string[]): Promise<ApprovalDbRow[]> {
  if (companyIds.length === 0) return [];
  const { data, error } = await admin
    .from("owner_approvals")
    .select("*")
    .in("company_id", companyIds)
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(50);
  if (error) throw error;
  return (data ?? []) as ApprovalDbRow[];
}

/**
 * Give every pending approval of a company a short code (lowest free 1..99), so the owner can
 * say "Y 2". Codes are unique among a company's pending rows (owner_approvals_short_code_open_idx);
 * a lost race just retries with the next free code.
 */
export async function ensureShortCodes(admin: AdminClient, companyId: string): Promise<void> {
  const pending = await listPendingApprovals(admin, [companyId]);
  const used = new Set(pending.map((r) => r.short_code).filter((c): c is number => typeof c === "number"));
  for (const row of pending) {
    if (row.short_code != null) continue;
    for (let attempt = 0; attempt < 3; attempt++) {
      let code = 1;
      while (used.has(code) && code < 99) code++;
      const { data, error } = await admin
        .from("owner_approvals")
        .update({ short_code: code })
        .eq("id", row.id)
        .eq("status", "pending")
        .is("short_code", null)
        .select("id");
      used.add(code);
      if (!error) {
        if ((data ?? []).length > 0) row.short_code = code;
        break;
      }
    }
  }
}

export interface NewApprovalInput {
  organizationId: string;
  companyId: string;
  contactId?: string | null;
  kind: string;
  summary: string;
  payload: Record<string, unknown>;
  requestedBy: string;
  expiresInMinutes: number;
  /** Set when the owner is being asked inline (an owner-command confirmation). */
  notified?: boolean;
}

/** Create a pending approval with a short code. */
export async function createApproval(admin: AdminClient, input: NewApprovalInput): Promise<ApprovalDbRow> {
  const now = Date.now();
  const { data, error } = await admin
    .from("owner_approvals")
    .insert({
      organization_id: input.organizationId,
      company_id: input.companyId,
      contact_id: input.contactId ?? null,
      kind: input.kind,
      summary: input.summary,
      payload: toJson(input.payload),
      requested_by: input.requestedBy,
      status: "pending",
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + input.expiresInMinutes * 60_000).toISOString(),
      notified_at: input.notified ? new Date(now).toISOString() : null,
    })
    .select("*")
    .single();
  if (error) throw error;
  const row = data as ApprovalDbRow;
  await ensureShortCodes(admin, input.companyId);
  const { data: fresh } = await admin.from("owner_approvals").select("*").eq("id", row.id).maybeSingle();
  return ((fresh as ApprovalDbRow | null) ?? row);
}

// ── Deciding ──────────────────────────────────────────────────────────────────

export type DecideOutcome = "done" | "already" | "expired" | "not_found";

export interface DecideResult {
  outcome: DecideOutcome;
  approval: ApprovalDbRow | null;
  result: ExecuteResult | null;
  /** One short line for the owner. */
  message: string;
}

async function runApproval(admin: AdminClient, row: ApprovalDbRow, decision: ApprovalDecision): Promise<ExecuteResult> {
  try {
    if (row.kind === OWNER_COMMAND_KIND) return await executeOwnerCommand(admin, toApprovalRow(row), decision);
    return await executeApprovedAction(admin, toApprovalRow(row), decision);
  } catch (err) {
    console.error("[owner-channel] approval run failed", row.id, err instanceof Error ? err.message : err);
    return { ok: false, message: "Something went wrong doing that — check the app." };
  }
}

async function storeResult(admin: AdminClient, row: ApprovalDbRow, decision: ApprovalDecision, result: ExecuteResult, status: ApprovalStatus): Promise<void> {
  const { error } = await admin
    .from("owner_approvals")
    .update({
      status,
      result: toJson({ ok: result.ok, message: result.message, detail: result.detail ?? null, note: decision.ownerNote ?? null }),
    })
    .eq("id", row.id);
  if (error) console.error("[owner-channel] storing approval result failed", row.id, error.message);
}

/**
 * Expire one pending approval: claim it (status 'expired', decided_via 'expiry'), then tell the
 * executor it was NOT approved so the customer isn't left hanging. Idempotent.
 */
export async function expireApproval(admin: AdminClient, row: ApprovalDbRow, nowMs: number): Promise<DecideResult> {
  const { data } = await admin
    .from("owner_approvals")
    .update({ status: "expired", decided_at: new Date(nowMs).toISOString(), decided_via: "expiry", decided_by: "system" })
    .eq("id", row.id)
    .eq("status", "pending")
    .select("*");
  const claimed = ((data ?? []) as ApprovalDbRow[])[0];
  const message = `That one expired: ${row.summary}`;
  if (!claimed) return { outcome: "already", approval: row, result: null, message };
  const decision: ApprovalDecision = { approved: false, ownerNote: null, decidedVia: "expiry", decidedBy: "system" };
  // An owner's own command confirmation that timed out needs no follow-up.
  const result =
    claimed.kind === OWNER_COMMAND_KIND ? { ok: true, message: "Expired — nothing changed." } : await runApproval(admin, claimed, decision);
  await storeResult(admin, claimed, decision, result, "expired");
  return { outcome: "expired", approval: claimed, result, message };
}

function alreadyLine(row: ApprovalDbRow): string {
  const what =
    row.status === "rejected" ? "skipped" : row.status === "expired" ? "expired" : row.status === "failed" ? "tried (it failed)" : "approved";
  return `Already ${what}: ${row.summary}`;
}

/**
 * Decide one approval. The claim is a conditional update (status = 'pending'), so only one
 * caller ever runs it: a second "Y", or the app button racing the text, gets "Already…".
 */
export async function decideApproval(
  admin: AdminClient,
  approvalId: string,
  decision: ApprovalDecision,
  options: { organizationId?: string; nowMs?: number } = {},
): Promise<DecideResult> {
  const nowMs = options.nowMs ?? Date.now();
  let query = admin.from("owner_approvals").select("*").eq("id", approvalId);
  if (options.organizationId) query = query.eq("organization_id", options.organizationId);
  const { data: found } = await query.maybeSingle();
  const row = found as ApprovalDbRow | null;
  if (!row) return { outcome: "not_found", approval: null, result: null, message: "I couldn't find that one." };
  if (row.status !== "pending") return { outcome: "already", approval: row, result: null, message: alreadyLine(row) };
  if (isExpired(row, nowMs)) return expireApproval(admin, row, nowMs);

  const { data: claimedRows } = await admin
    .from("owner_approvals")
    .update({
      status: decision.approved ? "approved" : "rejected",
      decided_at: new Date(nowMs).toISOString(),
      decided_via: decision.decidedVia,
      decided_by: decision.decidedBy,
    })
    .eq("id", row.id)
    .eq("status", "pending")
    .select("*");
  const claimed = ((claimedRows ?? []) as ApprovalDbRow[])[0];
  if (!claimed) {
    const { data: now } = await admin.from("owner_approvals").select("*").eq("id", row.id).maybeSingle();
    const current = (now as ApprovalDbRow | null) ?? row;
    return { outcome: "already", approval: current, result: null, message: alreadyLine(current) };
  }

  const result = await runApproval(admin, claimed, decision);
  const status: ApprovalStatus = decision.approved ? (result.ok ? "executed" : "failed") : "rejected";
  await storeResult(admin, claimed, decision, result, status);
  const fallback = decision.approved ? "Done." : "OK, skipped.";
  return { outcome: "done", approval: { ...claimed, status }, result, message: result.message?.trim() || fallback };
}

/** "1) Quote for Dana: $650 · 2) Book Sam Fri 9am" — for "which one?" replies. */
export function listLine(rows: ApprovalDbRow[], companyNames?: Map<string, string>): string {
  return rows
    .map((r) => {
      const where = companyNames && companyNames.size > 1 ? `${companyNames.get(r.company_id) ?? ""}: ` : "";
      return `${r.short_code ?? "?"}) ${where}${r.summary}`;
    })
    .join(" · ");
}
