import type { Json, Tables } from "@/server/db/database.types";
import { toJson } from "@/server/db/json";
import type { AdminClient, InboundOwnerSms } from "@/server/services/front-desk/contracts";
import { normalizePhoneLast10 } from "@/server/services/lead-intake/matching";
import { runOwnerCommandAgent } from "./agent";
import { decideApproval, ensureShortCodes, isExpired, listLine, listPendingApprovals, parseApprovalReply, type ParsedApprovalReply } from "./approvals";
import { consumeLimit, findOwnerCompanies, sendOwnerSms, type OwnerCompany } from "./common";
import { OWNER_COMMAND_KIND } from "./owner-commands";

/** Texts per phone per hour we'll act on at all, and model-backed commands per hour. */
const OWNER_SMS_PER_HOUR = 60;
const OWNER_AI_PER_HOUR = 20;
/** A "Which business?" question stays answerable this long. */
const ASK_TTL_MS = 30 * 60_000;
/** "The business we were just talking about" for commands that don't name one. */
const RECENT_CONTEXT_MS = 12 * 3_600_000;
/** A bare "Y" right after "Move Dana…? Reply Y" goes to that confirmation. */
const FRESH_CONFIRMATION_MS = 10 * 60_000;

type ApprovalDbRow = Tables<"owner_approvals">;
type LogRow = Tables<"owner_command_log">;

interface Outcome {
  intent: string;
  reply: string | null;
  company: OwnerCompany | null;
  result?: Record<string, unknown>;
}

// ── owner_command_log ─────────────────────────────────────────────────────────

async function insertLog(admin: AdminClient, sms: InboundOwnerSms): Promise<{ id: string } | "duplicate"> {
  const { data, error } = await admin
    .from("owner_command_log")
    .insert({ from_phone: sms.from, to_phone: sms.to, provider_ref: sms.providerRef, body: sms.body, intent: "received", company_id: sms.companyId, created_at: new Date().toISOString() })
    .select("id")
    .single();
  if (error) {
    if ((error as { code?: string }).code === "23505") return "duplicate";
    throw error;
  }
  return data as { id: string };
}

async function updateLog(admin: AdminClient, id: string, outcome: Outcome, extra: Record<string, unknown> = {}): Promise<void> {
  const { error } = await admin
    .from("owner_command_log")
    .update({
      intent: outcome.intent,
      company_id: outcome.company?.companyId ?? null,
      organization_id: outcome.company?.organizationId ?? null,
      result: toJson({ reply: outcome.reply, ...(outcome.result ?? {}), ...extra }),
    })
    .eq("id", id);
  if (error) console.error("[owner-channel] log update failed:", error.message);
}

async function previousLog(admin: AdminClient, phone: string, currentId: string): Promise<LogRow | null> {
  const { data } = await admin
    .from("owner_command_log")
    .select("*")
    .eq("from_phone", phone)
    .neq("id", currentId)
    .order("created_at", { ascending: false })
    .limit(1);
  return ((data ?? []) as LogRow[])[0] ?? null;
}

async function recentCompanyId(admin: AdminClient, phone: string, currentId: string, nowMs: number): Promise<string | null> {
  const { data } = await admin
    .from("owner_command_log")
    .select("company_id, created_at")
    .eq("from_phone", phone)
    .neq("id", currentId)
    .not("company_id", "is", null)
    .gte("created_at", new Date(nowMs - RECENT_CONTEXT_MS).toISOString())
    .order("created_at", { ascending: false })
    .limit(1);
  return ((data ?? []) as Array<{ company_id: string | null }>)[0]?.company_id ?? null;
}

// ── Which business? ──────────────────────────────────────────────────────────

const GENERIC_WORDS = new Set([
  "the", "and", "inc", "ltd", "llc", "corp", "company", "services", "service", "group", "co",
  "landscaping", "plumbing", "heating", "cooling", "electric", "electrical", "marine", "roofing",
  "cleaning", "contracting", "construction", "lawn", "care", "pro", "pros",
]);

function mentionsCompany(body: string, company: OwnerCompany): boolean {
  const text = ` ${body.toLowerCase().replace(/[^a-z0-9\s]/g, " ")} `;
  const name = company.name.toLowerCase().replace(/[^a-z0-9\s]/g, " ").trim();
  if (name && text.includes(` ${name} `)) return true;
  return name
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !GENERIC_WORDS.has(w))
    .some((w) => text.includes(` ${w} `));
}

function companyNamedIn(body: string, companies: OwnerCompany[]): OwnerCompany | null {
  const hits = companies.filter((c) => mentionsCompany(body, c));
  return hits.length === 1 ? hits[0] : null;
}

function askWhichBusiness(companies: OwnerCompany[]): string {
  const list = companies.map((c, i) => `${i + 1}) ${c.name}`).join(" ");
  return `Which business — ${list}? Reply with the number.`;
}

/** Answer to an earlier "Which business?" — "2" or a name. */
function pickFromAsk(body: string, optionIds: string[], owned: OwnerCompany[]): OwnerCompany | null {
  const options = optionIds.map((id) => owned.find((c) => c.companyId === id)).filter((c): c is OwnerCompany => Boolean(c));
  const n = /^\s*(\d{1,2})\s*[.)]?\s*$/.exec(body);
  if (n) return options[Number.parseInt(n[1], 10) - 1] ?? null;
  return companyNamedIn(body, options);
}

// ── Approvals ─────────────────────────────────────────────────────────────────

async function handleApproval(
  admin: AdminClient,
  sms: InboundOwnerSms,
  parsed: ParsedApprovalReply,
  owned: OwnerCompany[],
  hint: OwnerCompany | null,
  originalBody: string,
  nowMs: number,
): Promise<Outcome | null> {
  const scope = hint ? [hint] : owned;
  for (const c of scope) await ensureShortCodes(admin, c.companyId);
  const pending = await listPendingApprovals(admin, scope.map((c) => c.companyId));
  const live = pending.filter((p) => !isExpired(p, nowMs));
  const names = new Map(owned.map((c) => [c.companyId, c.name]));
  const companyOf = (row: ApprovalDbRow) => owned.find((c) => c.companyId === row.company_id) ?? null;

  if (pending.length === 0) {
    // "No, move Jones to Friday" with nothing pending is a command, not an answer.
    if (parsed.note) return null;
    return { intent: "approval_none", reply: "Nothing waiting on you right now.", company: hint ?? (owned.length === 1 ? owned[0] : null) };
  }

  let target: ApprovalDbRow | null = null;
  if (parsed.code != null) {
    const matches = pending.filter((p) => p.short_code === parsed.code);
    if (matches.length === 0) {
      return {
        intent: "approval_unknown_code",
        reply: `No #${parsed.code} waiting. ${live.length > 0 ? `Waiting: ${listLine(live, names)}` : "Nothing else is waiting."}`,
        company: hint,
      };
    }
    if (matches.length > 1) {
      const named = parsed.note ? companyNamedIn(parsed.note, owned) : null;
      target = named ? matches.find((m) => m.company_id === named.companyId) ?? null : null;
      if (!target) {
        const options = matches.map((m) => companyOf(m)).filter((c): c is OwnerCompany => Boolean(c));
        return { intent: "ask_company", reply: askWhichBusiness(options), company: null, result: { originalBody, options: options.map((c) => c.companyId) } };
      }
    } else target = matches[0];
  } else if (live.length === 1) {
    target = live[0];
  } else if (live.length === 0) {
    // Only expired ones left: answer about the newest (decide reports "expired" and closes it).
    target = pending[pending.length - 1];
  } else {
    const newest = [...live].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
    if (newest.kind === OWNER_COMMAND_KIND && nowMs - Date.parse(newest.created_at) <= FRESH_CONFIRMATION_MS) target = newest;
    else {
      const first = live[0].short_code ?? 1;
      return {
        intent: "approval_which",
        reply: `${live.length} waiting — reply with the number: ${listLine(live, names)}. e.g. Y ${first} or N ${first}`,
        company: hint ?? (owned.length === 1 ? owned[0] : null),
      };
    }
  }

  const decided = await decideApproval(admin, target.id, {
    approved: parsed.approved,
    ownerNote: parsed.note,
    decidedVia: "sms",
    decidedBy: sms.from,
  }, { organizationId: target.organization_id, nowMs });
  return {
    intent: `approval_${decided.outcome}`,
    reply: decided.message,
    company: companyOf(target),
    result: { approvalId: target.id, approved: parsed.approved, note: parsed.note, ok: decided.result?.ok ?? null },
  };
}

// ── Entry ─────────────────────────────────────────────────────────────────────

/**
 * Handle a text from a business owner: approvals ("Y", "N 2", "Y but $700") and commands
 * ("move Jones to Thursday", "what's on tomorrow"). Returns handled=false if the sender isn't
 * an owner (so the router can fall back). Idempotent on provider_ref (owner_command_log).
 * Replies always go out from the platform number.
 */
export async function handleOwnerInboundSms(admin: AdminClient, sms: InboundOwnerSms): Promise<{ handled: boolean }> {
  const nowMs = Date.now();
  const logged = await insertLog(admin, sms);
  if (logged === "duplicate") return { handled: true };

  const owned = await findOwnerCompanies(admin, sms.from);
  if (owned.length === 0) {
    await updateLog(admin, logged.id, { intent: "not_owner", reply: null, company: null });
    return { handled: false };
  }

  const last10 = normalizePhoneLast10(sms.from) ?? sms.from;
  let outcome: Outcome;
  if (!(await consumeLimit(admin, `owner_sms:${last10}`, OWNER_SMS_PER_HOUR, 3600))) {
    outcome = { intent: "rate_limited", reply: null, company: null };
  } else {
    outcome = await route(admin, sms, owned, logged.id, last10, nowMs);
  }

  const replyCompany = outcome.company ?? (sms.companyId ? owned.find((c) => c.companyId === sms.companyId) ?? null : null) ?? owned[0];
  let sendStatus: string | null = null;
  if (outcome.reply) {
    const sent = await sendOwnerSms(admin, {
      to: sms.from,
      body: outcome.reply,
      organizationId: replyCompany.organizationId,
      companyId: replyCompany.companyId,
      platformBrand: replyCompany.platformBrand,
    });
    sendStatus = sent.status;
  }
  await updateLog(admin, logged.id, outcome, { sendStatus });
  return { handled: true };
}

async function route(admin: AdminClient, sms: InboundOwnerSms, owned: OwnerCompany[], logId: string, last10: string, nowMs: number): Promise<Outcome> {
  let body = sms.body.trim();
  let hint: OwnerCompany | null = sms.companyId ? owned.find((c) => c.companyId === sms.companyId) ?? null : null;

  // An answer to "Which business — 1) … 2) …?"
  const previous = await previousLog(admin, sms.from, logId);
  if (previous?.intent === "ask_company" && nowMs - Date.parse(previous.created_at) <= ASK_TTL_MS) {
    const result = (previous.result ?? {}) as Record<string, Json>;
    const options = Array.isArray(result.options) ? (result.options as string[]) : [];
    const pick = pickFromAsk(body, options, owned);
    if (pick && typeof result.originalBody === "string") {
      hint = pick;
      body = result.originalBody;
    }
  }

  if (!body && sms.media.length > 0) {
    return { intent: "media_only", reply: "Got the picture — I can't do anything with photos here yet. Text me what you need.", company: hint };
  }

  const parsed = parseApprovalReply(body);
  if (parsed) {
    const handled = await handleApproval(admin, sms, parsed, owned, hint, body, nowMs);
    if (handled) return handled;
  }

  // A command: pick the business, then let the agent work.
  let company = hint ?? (owned.length === 1 ? owned[0] : null) ?? companyNamedIn(body, owned);
  if (!company) {
    const recent = await recentCompanyId(admin, sms.from, logId, nowMs);
    company = owned.find((c) => c.companyId === recent) ?? null;
  }
  if (!company) {
    return { intent: "ask_company", reply: askWhichBusiness(owned), company: null, result: { originalBody: body, options: owned.map((c) => c.companyId) } };
  }

  if (!(await consumeLimit(admin, `owner_ai:${last10}`, OWNER_AI_PER_HOUR, 3600))) {
    return { intent: "command_rate_limited", reply: "That's a lot at once — give me a few minutes and try again.", company };
  }

  try {
    const agent = await runOwnerCommandAgent({
      admin,
      scope: { organizationId: company.organizationId, companyId: company.companyId, companyName: company.name, timeZone: company.timeZone },
      ownerPhone: sms.from,
      body,
      nowMs,
    });
    return {
      intent: agent.confirmationId ? "command_confirm" : "command",
      reply: agent.reply,
      company,
      result: { actions: agent.actions, confirmationId: agent.confirmationId, rounds: agent.rounds },
    };
  } catch (err) {
    console.error("[owner-channel] command failed:", err instanceof Error ? err.message : err);
    return { intent: "command_error", reply: "Sorry — I couldn't do that just now. Try again in a minute, or use the app.", company };
  }
}
