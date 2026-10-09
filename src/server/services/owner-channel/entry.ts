import type { Json, Tables } from "@/server/db/database.types";
import { toJson } from "@/server/db/json";
import type { AdminClient, InboundOwnerSms } from "@/server/services/front-desk/contracts";
import { PRICE_NOTE_KINDS } from "@/server/services/front-desk/approval-text";
import { SHORT_CODE_REUSE_MS } from "@/server/services/front-desk/approvals";
import { normalizePhoneLast10 } from "@/server/services/lead-intake/matching";
import { runOwnerCommandAgent } from "./agent";
import { decideApproval, isExpired, listLine, looksLikeApprovalAttempt, parseApprovalReply, type ParsedApprovalReply } from "./approvals";
import { consumeLimit, findOwnerCompanies, sameOwnerPhone, sendOwnerSms, type OwnerCompany } from "./common";
import { CONFIRM_CODE_RE, confirmationMatches, MAX_CONFIRM_ATTEMPTS, OWNER_COMMAND_KIND } from "./owner-commands";

/** Texts per phone per hour we'll act on at all, and model-backed commands per hour. */
const OWNER_SMS_PER_HOUR = 60;
const OWNER_AI_PER_HOUR = 20;
/** A "Which business?" question stays answerable this long. */
const ASK_TTL_MS = 30 * 60_000;
/** "The business we were just talking about" for commands that don't name one. */
const RECENT_CONTEXT_MS = 12 * 3_600_000;

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
    .insert({ from_phone: sms.from, to_phone: sms.to, provider_ref: sms.providerRef, body: sms.body.slice(0, 2000), intent: "received", company_id: sms.companyId, created_at: new Date().toISOString() })
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

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 3).trimEnd()}...` : t;
}

/**
 * Approvals this phone was actually asked about (notified_to), in the last 7 days, any status,
 * newest first. A text can only decide one of these: an approval still held for quiet hours, or
 * one sent to a different phone, can't be approved by a "Y" it never saw.
 */
async function approvalsAskedOf(admin: AdminClient, companyIds: string[], phone: string, nowMs: number): Promise<ApprovalDbRow[]> {
  if (companyIds.length === 0) return [];
  const { data, error } = await admin
    .from("owner_approvals")
    .select("*")
    .in("company_id", companyIds)
    .not("notified_at", "is", null)
    .gte("created_at", new Date(nowMs - SHORT_CODE_REUSE_MS).toISOString())
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw error;
  return ((data ?? []) as ApprovalDbRow[]).filter((r) => sameOwnerPhone(r.notified_to, phone) && Date.parse(r.notified_at as string) <= nowMs);
}

async function handleApproval(
  admin: AdminClient,
  sms: InboundOwnerSms,
  parsed: ParsedApprovalReply,
  owned: OwnerCompany[],
  hint: OwnerCompany | null,
  originalBody: string,
  nowMs: number,
): Promise<Outcome> {
  const scope = hint ? [hint] : owned;
  const asked = await approvalsAskedOf(admin, scope.map((c) => c.companyId), sms.from, nowMs);
  // Owner-command confirmations take their 4-digit code, never a Y (a blind spoofer can't see it).
  const liveAll = asked.filter((p) => p.status === "pending" && !isExpired(p, nowMs)).reverse(); // oldest first for lists
  const live = parsed.approved ? liveAll.filter((p) => p.kind !== OWNER_COMMAND_KIND) : liveAll;
  const names = new Map(owned.map((c) => [c.companyId, c.name]));
  const companyOf = (row: ApprovalDbRow) => owned.find((c) => c.companyId === row.company_id) ?? null;
  const fallbackCompany = hint ?? (owned.length === 1 ? owned[0] : null);

  let target: ApprovalDbRow | null = null;
  if (parsed.code != null) {
    let matches = asked.filter((p) => p.short_code === parsed.code);
    if (matches.length === 0) {
      return {
        intent: "approval_unknown_code",
        reply: `No #${parsed.code} waiting on you. ${live.length > 0 ? `Waiting: ${listLine(live, names)}` : "Nothing else is waiting."}`,
        company: fallbackCompany,
      };
    }
    // The newest row per company holds the code (codes aren't reused within the lookback).
    const perCompany = new Map<string, ApprovalDbRow>();
    for (const m of matches) if (!perCompany.has(m.company_id)) perCompany.set(m.company_id, m);
    matches = [...perCompany.values()];
    if (matches.length > 1) {
      const pendingOnes = matches.filter((m) => m.status === "pending");
      if (pendingOnes.length === 1) matches = pendingOnes;
    }
    if (matches.length > 1) {
      const options = matches.map((m) => companyOf(m)).filter((c): c is OwnerCompany => Boolean(c));
      return { intent: "ask_company", reply: askWhichBusiness(options), company: null, result: { originalBody, options: options.map((c) => c.companyId) } };
    }
    target = matches[0];
  } else if (live.length === 1) {
    target = live[0];
  } else if (live.length === 0) {
    if (parsed.approved && liveAll.some((p) => p.kind === OWNER_COMMAND_KIND)) {
      return { intent: "confirm_needs_code", reply: "To confirm that, reply with the 4-digit code from my last text (or N to leave it).", company: fallbackCompany };
    }
    // Only expired ones left: answer about the newest (decide reports "expired" and closes it).
    const stale = asked.find((p) => p.status === "pending" && (parsed.approved ? p.kind !== OWNER_COMMAND_KIND : true));
    if (!stale) return { intent: "approval_none", reply: "Nothing waiting on you right now.", company: fallbackCompany };
    target = stale;
  } else {
    const first = live[0].short_code ?? 1;
    return {
      intent: "approval_which",
      reply: `${live.length} waiting - reply with the number: ${listLine(live, names)}. e.g. Y ${first} or N ${first}`,
      company: fallbackCompany,
    };
  }

  if (parsed.approved && target.kind === OWNER_COMMAND_KIND && target.status === "pending") {
    return { intent: "confirm_needs_code", reply: "To confirm that, reply with the 4-digit code from my last text (or N to leave it).", company: companyOf(target) };
  }

  // A note is only ever a price; on a kind that can't take one, ask rather than drop it.
  if (parsed.note && target.status === "pending" && !PRICE_NOTE_KINDS.has(target.kind)) {
    const code = target.short_code ?? "?";
    return {
      intent: "approval_note_not_allowed",
      reply: `#${code} (${clip(target.summary, 80)}) doesn't take a price. Reply Y ${code} to approve it as it is, or N ${code}.`,
      company: companyOf(target),
    };
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

/**
 * "4821" — the confirmation code for a destructive owner command ("Cancel Dana…? Reply 4821").
 * Only pending confirmations texted to this phone count; three wrong codes cancel them all.
 * Returns null when nothing is waiting for a code (the digits are then just a command).
 */
async function handleConfirmationCode(admin: AdminClient, sms: InboundOwnerSms, code: string, owned: OwnerCompany[], nowMs: number): Promise<Outcome | null> {
  const asked = await approvalsAskedOf(admin, owned.map((c) => c.companyId), sms.from, nowMs);
  const waiting = asked.filter((p) => p.kind === OWNER_COMMAND_KIND && p.status === "pending" && !isExpired(p, nowMs));
  if (waiting.length === 0) return null;
  const payloadOf = (row: ApprovalDbRow) => (row.payload && typeof row.payload === "object" && !Array.isArray(row.payload) ? (row.payload as Record<string, unknown>) : {});
  const target = waiting.find((p) => confirmationMatches(payloadOf(p), code));
  if (!target) {
    let cancelled = 0;
    for (const row of waiting) {
      const payload = payloadOf(row);
      const attempts = (typeof payload.confirmAttempts === "number" ? payload.confirmAttempts : 0) + 1;
      if (attempts >= MAX_CONFIRM_ATTEMPTS) {
        const { data } = await admin
          .from("owner_approvals")
          .update({ status: "rejected", decided_at: new Date(nowMs).toISOString(), decided_via: "sms", decided_by: sms.from, result: toJson({ ok: true, message: "Cancelled after too many wrong codes." }) })
          .eq("id", row.id)
          .eq("status", "pending")
          .select("id");
        cancelled += (data ?? []).length;
      } else {
        await admin.from("owner_approvals").update({ payload: toJson({ ...payload, confirmAttempts: attempts }) }).eq("id", row.id).eq("status", "pending");
      }
    }
    return {
      intent: "confirm_wrong_code",
      reply: cancelled ? "That code doesn't match, and that was the last try - nothing was changed. Ask again if you still want it." : "That code doesn't match anything waiting - nothing was changed.",
      company: owned.find((c) => c.companyId === waiting[0].company_id) ?? null,
    };
  }
  const decided = await decideApproval(admin, target.id, { approved: true, ownerNote: null, decidedVia: "sms", decidedBy: sms.from }, { organizationId: target.organization_id, nowMs });
  return {
    intent: `confirm_${decided.outcome}`,
    reply: decided.message,
    company: owned.find((c) => c.companyId === target.company_id) ?? null,
    result: { approvalId: target.id, ok: decided.result?.ok ?? null },
  };
}

/** "Did you mean Y to #12 (…)?" — for "ok actually no, keep it" while something is waiting. */
async function askDidYouMean(admin: AdminClient, sms: InboundOwnerSms, owned: OwnerCompany[], hint: OwnerCompany | null, nowMs: number): Promise<Outcome | null> {
  const scope = hint ? [hint] : owned;
  const asked = await approvalsAskedOf(admin, scope.map((c) => c.companyId), sms.from, nowMs);
  const live = asked.filter((p) => p.status === "pending" && !isExpired(p, nowMs)).reverse();
  if (live.length === 0) return null;
  const names = new Map(owned.map((c) => [c.companyId, c.name]));
  if (live.length === 1) {
    const code = live[0].short_code ?? "?";
    return {
      intent: "approval_did_you_mean",
      reply: `Did you mean Y or N to #${code} (${clip(live[0].summary, 90)})? Reply Y ${code} or N ${code}. Nothing's been done yet.`,
      company: owned.find((c) => c.companyId === live[0].company_id) ?? null,
    };
  }
  return {
    intent: "approval_did_you_mean",
    reply: `Not sure which you meant - nothing's been done yet. Waiting: ${listLine(live, names)}. Reply like Y ${live[0].short_code ?? 1} or N ${live[0].short_code ?? 1}.`,
    company: hint ?? (owned.length === 1 ? owned[0] : null),
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
    // Not an owner: keep only the first 200 characters of a stranger's text (pruned after 30 days).
    await admin.from("owner_command_log").update({ body: sms.body.slice(0, 200) }).eq("id", logged.id);
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

  const codeMatch = CONFIRM_CODE_RE.exec(body);
  if (codeMatch) {
    const confirmed = await handleConfirmationCode(admin, sms, codeMatch[1], owned, nowMs);
    if (confirmed) return confirmed;
  }

  const parsed = parseApprovalReply(body);
  if (parsed) return handleApproval(admin, sms, parsed, owned, hint, body, nowMs);
  if (looksLikeApprovalAttempt(body)) {
    const ask = await askDidYouMean(admin, sms, owned, hint, nowMs);
    if (ask) return ask;
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
