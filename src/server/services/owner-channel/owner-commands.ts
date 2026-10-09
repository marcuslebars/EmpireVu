/**
 * The owner's own commands that change things. Changes to bookings are never applied straight
 * from a text: the command agent creates an owner_approvals row of kind 'owner_command' with
 * the planned action in its payload and asks "…? Reply Y". executeOwnerCommand runs it once
 * the owner says yes (the same decide path as every other approval).
 *
 * Every action re-checks scope at execution time: the booking must still belong to the
 * approval's own organization + company, and a move must still land on an open time.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

import type { Json, Tables } from "@/server/db/database.types";
import { toJson } from "@/server/db/json";
import { rescheduleBooking, updateBookingStatus } from "@/server/services/bookings";
import { updateAiSettings } from "@/server/services/front-desk/ai-settings-write";
import type { AdminClient, ApprovalDecision, ExecuteResult, OwnerApprovalRow } from "@/server/services/front-desk/contracts";
import { markOwnerTakeover } from "@/server/services/sms-agent/takeover";
import { deliverMessage } from "@/server/services/workflow-engine/messaging";
import { ctxFor, DEFAULT_TIMEZONE, shortWhen } from "./common";
import { contactName, findScopedBooking, findScopedContact, openTimesForBooking, type CompanyScope } from "./schedule";

/** "…9:00 a.m." already ends the sentence — don't add a second period. */
function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

export const OWNER_COMMAND_KIND = "owner_command";

export type OwnerCommandPayload =
  | { action: "reschedule"; bookingId: string; startsAt: string; windowKey: string | null; previousStartsAt: string; who: string }
  | { action: "cancel"; bookingId: string; who: string }
  | { action: "text_customer"; contactId: string; message: string; who: string };

// ── Confirmation codes ────────────────────────────────────────────────────────
// Destructive owner commands (cancel, move, text a customer) are confirmed with a 4-digit code
// ("Reply 4821 to confirm"), not a bare "Y": someone spoofing the owner's number can't see our
// reply, so they can't confirm. The code is stored hashed (salted) in the payload.

export const CONFIRM_CODE_RE = /^\s*(\d{4})\s*\.?\s*$/;
/** Wrong codes allowed before every waiting confirmation for that phone is cancelled. */
export const MAX_CONFIRM_ATTEMPTS = 3;

export function newConfirmation(): { code: string; salt: string; hash: string } {
  const code = String(randomInt(1000, 10_000));
  const salt = randomBytes(8).toString("hex");
  return { code, salt, hash: hashConfirmation(code, salt) };
}

export function hashConfirmation(code: string, salt: string): string {
  return createHash("sha256").update(`${salt}:${code}`).digest("hex");
}

export function confirmationMatches(payload: Record<string, unknown>, code: string): boolean {
  const salt = typeof payload.confirmSalt === "string" ? payload.confirmSalt : null;
  const hash = typeof payload.confirmHash === "string" ? payload.confirmHash : null;
  if (!salt || !hash) return false;
  const given = hashConfirmation(code, salt);
  return given.length === hash.length && timingSafeEqual(Buffer.from(given), Buffer.from(hash));
}

async function scopeForApproval(admin: AdminClient, approval: OwnerApprovalRow): Promise<CompanyScope | null> {
  const { data } = await admin
    .from("companies")
    .select("id, organization_id, name, timezone")
    .eq("organization_id", approval.organization_id)
    .eq("id", approval.company_id)
    .maybeSingle();
  const row = data as Pick<Tables<"companies">, "id" | "organization_id" | "name" | "timezone"> | null;
  if (!row) return null;
  return { organizationId: row.organization_id, companyId: row.id, companyName: row.name, timeZone: row.timezone?.trim() || DEFAULT_TIMEZONE };
}

export async function executeOwnerCommand(admin: AdminClient, approval: OwnerApprovalRow, decision: ApprovalDecision): Promise<ExecuteResult> {
  if (!decision.approved) return { ok: true, message: "OK, left it as is." };
  const payload = approval.payload as Partial<OwnerCommandPayload>;
  const scope = await scopeForApproval(admin, approval);
  if (!scope) return { ok: false, message: "I couldn't find that business." };

  if (payload.action === "text_customer") {
    // Exactly the message the owner confirmed (it was echoed back to them word for word).
    const contact = await findScopedContact(admin, scope, payload.contactId);
    if (!contact) return { ok: false, message: "I couldn't find that customer any more." };
    if (!contact.phone) return { ok: false, message: `${payload.who ?? "They"} have no phone number on file.` };
    const message = typeof payload.message === "string" ? payload.message : "";
    if (!message) return { ok: false, message: "There was no message to send." };
    const result = await deliverMessage({
      context: ctxFor(admin, scope.organizationId),
      channel: "sms",
      to: contact.phone,
      body: message,
      companyId: scope.companyId,
      contactId: contact.id,
      consentContact: contact,
    });
    if (result.status !== "sent") {
      const why = result.reason === "opted_out" ? "they've opted out of texts" : result.reason ?? "the text didn't go through";
      return { ok: false, message: `Not sent to ${payload.who ?? "them"} - ${why}.` };
    }
    await markOwnerTakeover(admin, { companyId: scope.companyId, contactId: contact.id });
    return { ok: true, message: `Sent to ${payload.who ?? "them"}. The assistant will stay out of that conversation for now.`, detail: { contactId: contact.id } };
  }

  const booking = await findScopedBooking(admin, scope, (payload as { bookingId?: string }).bookingId);
  if (!booking) return { ok: false, message: "I couldn't find that booking any more." };
  const ctx = ctxFor(admin, scope.organizationId);

  if (payload.action === "cancel") {
    if (booking.status === "cancelled") return { ok: true, message: `${payload.who ?? "That booking"} was already cancelled.` };
    await updateBookingStatus(ctx, { bookingId: booking.id, status: "cancelled" });
    return { ok: true, message: `Cancelled ${payload.who ?? "the booking"} (${shortWhen(booking.scheduled_for, scope.timeZone)}).`, detail: { bookingId: booking.id } };
  }

  if (payload.action === "reschedule" && payload.startsAt) {
    if (booking.status === "cancelled") return { ok: false, message: "That booking was cancelled — nothing moved." };
    if (Date.parse(booking.scheduled_for) === Date.parse(payload.startsAt)) {
      return { ok: true, message: sentence(`${payload.who ?? "It"} is already at ${shortWhen(payload.startsAt, scope.timeZone)}`) };
    }
    const open = await openTimesForBooking(admin, scope, booking, Date.now());
    const slot = open.find((t) => Date.parse(t.startsAt) === Date.parse(payload.startsAt as string) && (t.windowKey ?? null) === (payload.windowKey ?? null));
    if (!slot) return { ok: false, message: `${shortWhen(payload.startsAt, scope.timeZone)} just got taken — nothing moved. Pick another time.` };
    await rescheduleBooking(ctx, {
      bookingId: booking.id,
      scheduledFor: slot.startsAt,
      ...(slot.windowKey ? { windowKey: slot.windowKey } : {}),
    });
    return {
      ok: true,
      message: `${sentence(`Moved ${payload.who ?? "the booking"} to ${shortWhen(slot.startsAt, scope.timeZone)}`)} Want me to text them? Say "tell ${(payload.who ?? "them").split(" ")[0]} …".`,
      detail: { bookingId: booking.id, from: booking.scheduled_for, to: slot.startsAt },
    };
  }

  return { ok: false, message: "I don't know how to do that one." };
}

// ── Business-wide switches (applied directly; reversible) ────────────────────

type Settings = Record<string, unknown>;

function asRecord(value: unknown): Settings {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Settings) } : {};
}

async function readAiSettings(admin: AdminClient, scope: CompanyScope): Promise<Settings> {
  const { data } = await admin
    .from("companies")
    .select("ai_settings")
    .eq("organization_id", scope.organizationId)
    .eq("id", scope.companyId)
    .maybeSingle();
  return asRecord((data as { ai_settings: Json } | null)?.ai_settings);
}

/** companies.ai_settings.sms_agent.enabled (only that key is touched; optimistic write). */
export async function setBusinessAi(admin: AdminClient, scope: CompanyScope, on: boolean): Promise<void> {
  await updateAiSettings(admin, scope, (settings) => ({ ...settings, sms_agent: { ...asRecord(settings.sms_agent), enabled: on } }));
}

function sendsCustomerTexts(definition: Json): boolean {
  const actions = asRecord(definition).actions;
  return Array.isArray(actions) && actions.some((a) => asRecord(a).type === "send_sms");
}

/**
 * "Pause all texts": the AI stops replying (sms_agent.enabled=false) and this company's active
 * automations that text customers are paused. What we paused is remembered in
 * ai_settings.owner_pause so "resume texts" restores exactly that.
 */
export async function pauseAllTexts(admin: AdminClient, scope: CompanyScope): Promise<{ workflowsPaused: number }> {
  const { data } = await admin
    .from("workflows")
    .select("id, definition, status")
    .eq("organization_id", scope.organizationId)
    .eq("company_id", scope.companyId)
    .eq("status", "active");
  const ids = ((data ?? []) as Array<Pick<Tables<"workflows">, "id" | "definition">>).filter((w) => sendsCustomerTexts(w.definition)).map((w) => w.id);
  if (ids.length > 0) {
    const { error } = await admin.from("workflows").update({ status: "paused" }).eq("organization_id", scope.organizationId).in("id", ids);
    if (error) throw error;
  }
  await updateAiSettings(admin, scope, (current) => {
    const pause = asRecord(current.owner_pause);
    const smsAgent = asRecord(current.sms_agent);
    const previous = Array.isArray(pause.workflow_ids) ? (pause.workflow_ids as string[]) : [];
    return {
      ...current,
      owner_pause: {
        at: new Date().toISOString(),
        workflow_ids: [...new Set([...previous, ...ids])],
        sms_agent_enabled_before: "sms_agent_enabled_before" in pause ? pause.sms_agent_enabled_before : (smsAgent.enabled ?? null),
      },
      sms_agent: { ...smsAgent, enabled: false },
    };
  });
  return { workflowsPaused: ids.length };
}

export async function resumeAllTexts(admin: AdminClient, scope: CompanyScope): Promise<{ workflowsResumed: number; wasPaused: boolean }> {
  const settings = await readAiSettings(admin, scope);
  const pause = asRecord(settings.owner_pause);
  const ids = Array.isArray(pause.workflow_ids) ? (pause.workflow_ids as string[]).filter((x) => typeof x === "string") : [];
  if (ids.length > 0) {
    const { error } = await admin
      .from("workflows")
      .update({ status: "active" })
      .eq("organization_id", scope.organizationId)
      .eq("company_id", scope.companyId)
      .eq("status", "paused")
      .in("id", ids);
    if (error) throw error;
  }
  const wasPaused = Object.keys(pause).length > 0;
  await updateAiSettings(admin, scope, (current) => {
    const next = { ...current };
    const smsAgent = asRecord(next.sms_agent);
    const before = asRecord(next.owner_pause).sms_agent_enabled_before;
    if (typeof before === "boolean") smsAgent.enabled = before;
    else delete smsAgent.enabled; // back to the default for this plan
    next.sms_agent = smsAgent;
    delete next.owner_pause;
    return next;
  });
  return { workflowsResumed: ids.length, wasPaused };
}

/** Build the confirmation line + payload for a move. */
export function rescheduleProposal(
  booking: Pick<Tables<"bookings">, "id" | "scheduled_for">,
  who: string,
  slot: { startsAt: string; windowKey: string | null; label?: string },
  timeZone: string,
): { summary: string; payload: OwnerCommandPayload } {
  return {
    summary: `Move ${who} (${shortWhen(booking.scheduled_for, timeZone)}) to ${shortWhen(slot.startsAt, timeZone)}?`,
    payload: { action: "reschedule", bookingId: booking.id, startsAt: slot.startsAt, windowKey: slot.windowKey, previousStartsAt: booking.scheduled_for, who },
  };
}

/** Build the confirmation line + payload for a text to a customer (the exact message, echoed). */
export function textCustomerProposal(contactId: string, who: string, message: string): { summary: string; payload: OwnerCommandPayload } {
  return { summary: `Send to ${who}: "${message}"?`, payload: { action: "text_customer", contactId, message, who } };
}

export function cancelProposal(booking: Pick<Tables<"bookings">, "id" | "scheduled_for" | "title">, who: string, timeZone: string): { summary: string; payload: OwnerCommandPayload } {
  return {
    summary: `Cancel ${who} — ${shortWhen(booking.scheduled_for, timeZone)} (${booking.title})?`,
    payload: { action: "cancel", bookingId: booking.id, who },
  };
}

export { contactName };
