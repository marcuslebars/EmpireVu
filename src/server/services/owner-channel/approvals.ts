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
import { insertApproval, nextShortCode, recentShortCodes } from "@/server/services/front-desk/approvals";
import { parseOwnerNote } from "@/server/services/front-desk/owner-note";
import { executeApprovedAction } from "@/server/services/sms-agent/approved";
import { executeOwnerCommand, OWNER_COMMAND_KIND } from "./owner-commands";

type ApprovalDbRow = Tables<"owner_approvals">;

// ── Parsing ───────────────────────────────────────────────────────────────────

export interface ParsedApprovalReply {
  approved: boolean;
  code: number | null;
  /** Only ever a price ("$700", "but 700 + HST") — anything else isn't a decision. */
  note: string | null;
}

const YES_WORDS = ["y", "yes", "yep", "yup", "yeah", "ok", "okay", "approve", "approved"];
const NO_WORDS = ["n", "no", "nope", "nah", "skip"];
const WORD = `(${[...YES_WORDS, ...NO_WORDS].sort((a, b) => b.length - a.length).join("|")})`;
/** The bare word + optional code: "Y", "yes!", "N 2", "y#12", "OK 3." */
const BARE_RE = new RegExp(`^\\s*${WORD}\\s*#?\\s*(\\d{1,4})?\\s*[.!]*\\s*$`, "i");
/** A yes-word + optional code + the rest (a price note, if it is one). */
const WITH_NOTE_RE = new RegExp(`^\\s*${WORD}(?:\\s*#?\\s*(\\d{1,4})(?=$|[\\s,.:;!$-]))?\\s*[,.:;!-]*\\s*([\\s\\S]+)$`, "i");

/**
 * A decision is ONLY: the bare word (Y/YES/OK/N/NO and close variants) with an optional code,
 * or a yes-word + optional code + one clear price ("Y but $700", "Y 2 $700", "Y $700 + HST").
 * "ok actually no, keep it", "Ok what's on tomorrow", "No worries, tell Jamie 9am works" are NOT
 * decisions (null) — they go to the command agent, or we ask (see looksLikeApprovalAttempt).
 */
export function parseApprovalReply(body: string): ParsedApprovalReply | null {
  const text = (body ?? "").trim();
  const bare = BARE_RE.exec(text);
  if (bare) {
    const word = bare[1].toLowerCase();
    return { approved: YES_WORDS.includes(word), code: bare[2] ? Number.parseInt(bare[2], 10) : null, note: null };
  }
  const withNote = WITH_NOTE_RE.exec(text);
  if (!withNote || !YES_WORDS.includes(withNote[1].toLowerCase())) return null;
  const code = withNote[2] ? Number.parseInt(withNote[2], 10) : null;
  const rest = withNote[3].trim();
  if (parseOwnerNote(rest).kind === "price") return { approved: true, code, note: rest };
  // "Y 700 + HST" — the digits were the price, not a code.
  if (code != null && parseOwnerNote(`${withNote[2]} ${rest}`).kind === "price") return { approved: true, code: null, note: `${withNote[2]} ${rest}` };
  return null;
}

const QUESTION_OR_IDIOM = /^(what|what's|whats|who|who's|when|where|how|why|is|are|do|does|can|could|any|worries|problem|prob|way|idea|clue|rush)\b/i;
const ACTION = /^(move|cancel|reschedule|tell|text|send|list|show|pause|resume|stop|start|ai|book|find|call|remind|help)\b/i;

/**
 * Starts like an answer ("ok actually no, keep it", "Y but tell them 9am", "N tell them next
 * week") but isn't a clean one: if something is waiting, we ask "Did you mean …?" instead of
 * guessing. Questions and idioms ("Ok what's on tomorrow", "No worries, tell Jamie…") are
 * commands, and so is "ok/okay" + an action ("ok move Jones to Friday"). PURE.
 */
export function looksLikeApprovalAttempt(body: string): boolean {
  const text = (body ?? "").trim();
  if (parseApprovalReply(text)) return false;
  const m = new RegExp(`^\\s*${WORD}\\b\\s*#?\\s*\\d{0,4}\\s*([,.:;!-]*)\\s*([\\s\\S]*)$`, "i").exec(text);
  if (!m) return false;
  const word = m[1].toLowerCase();
  const rest = m[3].trim();
  if (!rest) return true;
  if (text.includes("?") || QUESTION_OR_IDIOM.test(rest)) return false;
  const afterFiller = rest.replace(/^(so|and|then|but|well|um|uh|actually)\b[\s,]*/i, "");
  if ((word === "ok" || word === "okay") && ACTION.test(afterFiller)) return false;
  return true;
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
 * Give every pending approval of a company a short code (rows created before codes were
 * assigned at insert). Same sequence as insertApproval: never a code used in the last 7 days.
 */
export async function ensureShortCodes(admin: AdminClient, companyId: string): Promise<void> {
  const pending = await listPendingApprovals(admin, [companyId]);
  if (pending.every((r) => r.short_code != null)) return;
  const used = await recentShortCodes(admin, companyId, new Date());
  for (const row of pending) {
    if (row.short_code != null) continue;
    for (let attempt = 0; attempt < 3; attempt++) {
      const code = nextShortCode(used);
      used.push(code);
      const { data, error } = await admin
        .from("owner_approvals")
        .update({ short_code: code })
        .eq("id", row.id)
        .eq("status", "pending")
        .is("short_code", null)
        .select("id");
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
  /** Set when the owner is being asked inline (an owner-command confirmation): the phone asked. */
  notifiedTo?: string | null;
}

/** Create a pending approval with a short code (the shared insert — front-desk/approvals.ts). */
export async function createApproval(admin: AdminClient, input: NewApprovalInput): Promise<ApprovalDbRow> {
  const now = new Date();
  return insertApproval(admin, {
    organizationId: input.organizationId,
    companyId: input.companyId,
    contactId: input.contactId ?? null,
    kind: input.kind,
    summary: input.summary,
    payload: input.payload,
    requestedBy: input.requestedBy,
    createdAt: now,
    expiresAt: new Date(now.getTime() + input.expiresInMinutes * 60_000),
    notifiedAt: input.notifiedTo ? now : null,
    notifiedTo: input.notifiedTo ?? null,
  });
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
 * After the run: who records the outcome. owner_command rows → here. Every other kind →
 * executeApprovedAction already did (status executed / failed / rejected / expired + result, or
 * back to 'pending' when it asked the owner to clarify), so we don't write over it; we only
 * fill in an outcome when the executor never recorded one (it crashed mid-way).
 */
async function settle(
  admin: AdminClient,
  claimed: ApprovalDbRow,
  decision: ApprovalDecision,
  result: ExecuteResult,
  fallbackStatus: ApprovalStatus,
): Promise<ApprovalDbRow> {
  if (claimed.kind === OWNER_COMMAND_KIND) {
    await storeResult(admin, claimed, decision, result, fallbackStatus);
    return { ...claimed, status: fallbackStatus };
  }
  const { data } = await admin.from("owner_approvals").select("*").eq("id", claimed.id).maybeSingle();
  const current = data as ApprovalDbRow | null;
  if (current && (current.status === "pending" || current.result != null)) return current;
  await storeResult(admin, claimed, decision, result, fallbackStatus);
  return { ...claimed, status: fallbackStatus };
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
  const message = `#${row.short_code ?? "?"} expired before you answered, so nothing was done: ${clipLine(row.summary, 140)}`;
  if (!claimed) return { outcome: "already", approval: row, result: null, message };
  const decision: ApprovalDecision = { approved: false, ownerNote: null, decidedVia: "expiry", decidedBy: "system" };
  // An owner's own command confirmation that timed out needs no follow-up.
  const result =
    claimed.kind === OWNER_COMMAND_KIND ? { ok: true, message: "Expired — nothing changed." } : await runApproval(admin, claimed, decision);
  const settled = await settle(admin, claimed, decision, result, "expired");
  return { outcome: "expired", approval: settled, result, message };
}

function alreadyLine(row: ApprovalDbRow): string {
  return `#${row.short_code ?? "?"} was already ${statusWord(row.status)}: ${clipLine(row.summary, 140)}`;
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
      result: null, // a clarification question from an earlier round isn't the outcome
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
  const settled = await settle(admin, claimed, decision, result, status);
  const fallback = decision.approved ? "Done." : "OK, skipped.";
  return { outcome: "done", approval: settled, result, message: result.message?.trim() || fallback };
}

function clipLine(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 3).trimEnd()}...` : t;
}

/** "#4 Dana Lee - send them a quote… · #5 Book Sam…" — for "which one?" replies (each line short). */
export function listLine(rows: ApprovalDbRow[], companyNames?: Map<string, string>): string {
  const each = rows.length > 3 ? 60 : 90;
  return rows
    .slice(0, 6)
    .map((r) => {
      const where = companyNames && companyNames.size > 1 ? `${companyNames.get(r.company_id) ?? ""}: ` : "";
      return `#${r.short_code ?? "?"} ${where}${clipLine(r.summary, each)}`;
    })
    .join(" · ");
}

/** "approved" / "skipped" / … for a decided row. */
export function statusWord(status: string): string {
  return status === "rejected" ? "skipped" : status === "expired" ? "expired" : status === "failed" ? "tried (it failed)" : status === "superseded" ? "replaced" : status === "pending" ? "waiting" : "approved";
}
