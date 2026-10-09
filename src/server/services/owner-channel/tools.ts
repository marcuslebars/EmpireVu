/**
 * The owner command agent's tools. Each one runs against ONE company — the scope resolved from
 * the owner's phone before the model is called. The model never chooses a company; booking and
 * contact ids it passes are re-checked against that scope (wrong company → "not found").
 * Changes to bookings only PROPOSE (an owner_command approval the owner confirms with "Y").
 */
import type Anthropic from "@anthropic-ai/sdk";

import type { Tables } from "@/server/db/database.types";
import { addDays, localDate, zonedInstant } from "@/server/services/booking-windows";
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { markOwnerTakeover, setConversationAi } from "@/server/services/sms-agent/takeover";
import { deliverMessage } from "@/server/services/workflow-engine/messaging";
import { createApproval, ensureShortCodes, listPendingApprovals } from "./approvals";
import { ctxFor, shortWhen } from "./common";
import {
  cancelProposal,
  OWNER_COMMAND_KIND,
  pauseAllTexts,
  rescheduleProposal,
  resumeAllTexts,
  setBusinessAi,
} from "./owner-commands";
import { contactName, findScopedBooking, findScopedContact, openTimesForBooking, type CompanyScope } from "./schedule";

export interface ToolRunState {
  admin: AdminClient;
  scope: CompanyScope;
  ownerPhone: string;
  nowMs: number;
  /** Set when a tool created a confirmation the owner must answer with Y/N. */
  confirmation: Tables<"owner_approvals"> | null;
  actions: Array<{ tool: string; ok: boolean; detail?: Record<string, unknown> }>;
}

const CONFIRM_MINUTES = 30;

export const OWNER_TOOLS: Anthropic.Messages.Tool[] = [
  {
    name: "list_bookings",
    description: "List this business's bookings (not cancelled) for a day or range, with customer names and times.",
    input_schema: {
      type: "object",
      properties: {
        when: { type: "string", enum: ["today", "tomorrow", "this_week", "next_week", "date"] },
        date: { type: "string", description: "YYYY-MM-DD when `when` is 'date'." },
      },
      required: ["when"],
    },
  },
  {
    name: "waiting_on_me",
    description: "What's waiting on the owner: open approvals (with their reply codes), conversations the AI handed over, and customer texts with no reply yet.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "find_customer",
    description: "Look up customers by name or phone. Returns ids, phone, and their next booking.",
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "find_open_times",
    description: "Open times on the calendar (for moving a booking). Optionally for one booking (its length) and/or one date.",
    input_schema: {
      type: "object",
      properties: { booking_id: { type: "string" }, date: { type: "string", description: "YYYY-MM-DD" } },
    },
  },
  {
    name: "propose_reschedule",
    description:
      "Ask the owner to confirm moving a booking to an open time. Nothing changes until they reply Y. Give the local date and either the local time (HH:MM, 24h) or the booking window key.",
    input_schema: {
      type: "object",
      properties: {
        booking_id: { type: "string" },
        date: { type: "string", description: "YYYY-MM-DD (local)" },
        time: { type: "string", description: "HH:MM 24h local" },
        window_key: { type: "string" },
      },
      required: ["booking_id", "date"],
    },
  },
  {
    name: "propose_cancel",
    description: "Ask the owner to confirm cancelling a booking. Nothing changes until they reply Y.",
    input_schema: { type: "object", properties: { booking_id: { type: "string" } }, required: ["booking_id"] },
  },
  {
    name: "text_customer",
    description:
      "Send a text to a customer from the business's number, on the owner's behalf, with the owner's message (lightly tidied, same meaning). The AI then stays out of that conversation.",
    input_schema: {
      type: "object",
      properties: { contact_id: { type: "string" }, message: { type: "string" } },
      required: ["contact_id", "message"],
    },
  },
  {
    name: "set_ai_for_customer",
    description: "Turn the AI texting assistant on or off for one customer.",
    input_schema: { type: "object", properties: { contact_id: { type: "string" }, on: { type: "boolean" } }, required: ["contact_id", "on"] },
  },
  {
    name: "set_ai_for_business",
    description: "Turn the AI texting assistant on or off for the whole business.",
    input_schema: { type: "object", properties: { on: { type: "boolean" } }, required: ["on"] },
  },
  {
    name: "pause_all_texts",
    description: "Pause everything that texts customers: the AI assistant and automations that send texts.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "resume_all_texts",
    description: "Undo pause_all_texts.",
    input_schema: { type: "object", properties: {} },
  },
];

type Input = Record<string, unknown>;

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function rangeFor(when: string, date: string | null, scope: CompanyScope, nowMs: number): { from: string; to: string } | null {
  const today = localDate(new Date(nowMs), scope.timeZone);
  let start = today;
  let days = 1;
  if (when === "tomorrow") start = addDays(today, 1);
  else if (when === "this_week") days = 7;
  else if (when === "next_week") {
    start = addDays(today, 7);
    days = 7;
  } else if (when === "date") {
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    start = date;
  }
  return {
    from: zonedInstant(start, "00:00", scope.timeZone).toISOString(),
    to: zonedInstant(addDays(start, days), "00:00", scope.timeZone).toISOString(),
  };
}

async function namesFor(state: ToolRunState, ids: Array<string | null>): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  if (unique.length === 0) return new Map();
  const { data } = await state.admin
    .from("contacts")
    .select("id, first_name, last_name")
    .eq("organization_id", state.scope.organizationId)
    .eq("company_id", state.scope.companyId)
    .in("id", unique);
  return new Map(((data ?? []) as Array<Pick<Tables<"contacts">, "id" | "first_name" | "last_name">>).map((c) => [c.id, contactName(c)]));
}

async function listBookingsTool(state: ToolRunState, input: Input) {
  const range = rangeFor(str(input.when) ?? "today", str(input.date), state.scope, state.nowMs);
  if (!range) return { error: "Give a date as YYYY-MM-DD." };
  const { data, error } = await state.admin
    .from("bookings")
    .select("id, contact_id, title, scheduled_for, duration_minutes, status, location")
    .eq("organization_id", state.scope.organizationId)
    .eq("company_id", state.scope.companyId)
    .neq("status", "cancelled")
    .gte("scheduled_for", range.from)
    .lt("scheduled_for", range.to)
    .order("scheduled_for", { ascending: true })
    .limit(50);
  if (error) throw error;
  const rows = (data ?? []) as Array<Pick<Tables<"bookings">, "id" | "contact_id" | "title" | "scheduled_for" | "duration_minutes" | "status" | "location">>;
  const names = await namesFor(state, rows.map((r) => r.contact_id));
  return {
    bookings: rows.map((r) => ({
      booking_id: r.id,
      when: shortWhen(r.scheduled_for, state.scope.timeZone),
      customer: r.contact_id ? names.get(r.contact_id) ?? "Unknown" : null,
      job: r.title,
      status: r.status,
      location: r.location,
    })),
  };
}

async function waitingOnMeTool(state: ToolRunState) {
  const { scope, admin } = state;
  await ensureShortCodes(admin, scope.companyId);
  const approvals = (await listPendingApprovals(admin, [scope.companyId])).filter((a) => a.organization_id === scope.organizationId);
  const { data: handoffs } = await admin
    .from("sms_conversations")
    .select("contact_id, summary, last_inbound_at, state")
    .eq("organization_id", scope.organizationId)
    .eq("company_id", scope.companyId)
    .eq("state", "owner")
    .order("last_inbound_at", { ascending: false })
    .limit(10);
  const { data: unanswered } = await admin
    .from("ui_inbox_v")
    .select("contact_id, contact_name, snippet, last_inbound_at")
    .eq("organization_id", scope.organizationId)
    .eq("company_id", scope.companyId)
    .eq("needs_reply", true)
    .order("last_inbound_at", { ascending: false })
    .limit(10);
  const handoffRows = (handoffs ?? []) as Array<{ contact_id: string; summary: string | null; last_inbound_at: string | null }>;
  const names = await namesFor(state, handoffRows.map((h) => h.contact_id));
  return {
    approvals: approvals.map((a) => ({ reply_code: a.short_code, summary: a.summary, expires: a.expires_at ? shortWhen(a.expires_at, scope.timeZone) : null })),
    handed_to_you: handoffRows.map((h) => ({ contact_id: h.contact_id, customer: names.get(h.contact_id) ?? "Unknown", summary: h.summary })),
    unanswered_texts: ((unanswered ?? []) as Array<{ contact_id: string | null; contact_name: string | null; snippet: string | null; last_inbound_at: string | null }>).map((u) => ({
      contact_id: u.contact_id,
      customer: u.contact_name,
      last_message: u.snippet,
      at: u.last_inbound_at ? shortWhen(u.last_inbound_at, scope.timeZone) : null,
    })),
  };
}

async function findCustomerTool(state: ToolRunState, input: Input) {
  const q = str(input.query);
  if (!q) return { error: "Who should I look up?" };
  const { scope, admin } = state;
  const digits = q.replace(/\D/g, "");
  let query = admin
    .from("contacts")
    .select("id, first_name, last_name, phone")
    .eq("organization_id", scope.organizationId)
    .eq("company_id", scope.companyId);
  query = digits.length >= 7 ? query.like("phone_last10", `%${digits.slice(-10)}%`) : query.ilike("search_text", `%${q.toLowerCase().replace(/[%_,()]/g, " ").trim()}%`);
  const { data, error } = await query.limit(5);
  if (error) throw error;
  const contacts = (data ?? []) as Array<Pick<Tables<"contacts">, "id" | "first_name" | "last_name" | "phone">>;
  const ids = contacts.map((c) => c.id);
  const next = new Map<string, { booking_id: string; when: string; job: string }>();
  if (ids.length > 0) {
    const { data: bookings } = await admin
      .from("bookings")
      .select("id, contact_id, title, scheduled_for")
      .eq("organization_id", scope.organizationId)
      .eq("company_id", scope.companyId)
      .in("contact_id", ids)
      .neq("status", "cancelled")
      .gte("scheduled_for", new Date(state.nowMs - 12 * 3_600_000).toISOString())
      .order("scheduled_for", { ascending: true })
      .limit(20);
    for (const b of (bookings ?? []) as Array<Pick<Tables<"bookings">, "id" | "contact_id" | "title" | "scheduled_for">>) {
      if (b.contact_id && !next.has(b.contact_id)) next.set(b.contact_id, { booking_id: b.id, when: shortWhen(b.scheduled_for, scope.timeZone), job: b.title });
    }
  }
  return { customers: contacts.map((c) => ({ contact_id: c.id, name: contactName(c), phone: c.phone, next_booking: next.get(c.id) ?? null })) };
}

async function findOpenTimesTool(state: ToolRunState, input: Input) {
  const bookingId = str(input.booking_id);
  const booking = bookingId ? await findScopedBooking(state.admin, state.scope, bookingId) : null;
  if (bookingId && !booking) return { error: "No such booking for this business." };
  const date = str(input.date);
  const open = await openTimesForBooking(state.admin, state.scope, booking, state.nowMs);
  const picked = (date ? open.filter((t) => t.day === date) : open).slice(0, 8);
  return { open_times: picked.map((t) => ({ date: t.day, time: localHhmm(t.startsAt, state.scope.timeZone), window_key: t.windowKey, label: `${t.dayLabel}, ${t.label}` })) };
}

function localHhmm(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
}

async function proposeRescheduleTool(state: ToolRunState, input: Input) {
  const booking = await findScopedBooking(state.admin, state.scope, input.booking_id);
  if (!booking || booking.status === "cancelled") return { error: "No such booking for this business." };
  const date = str(input.date);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: "Give the new date as YYYY-MM-DD." };
  const time = str(input.time);
  const windowKey = str(input.window_key);
  const open = await openTimesForBooking(state.admin, state.scope, booking, state.nowMs);
  const onDay = open.filter((t) => t.day === date);
  const slot = onDay.find((t) => (windowKey ? t.windowKey === windowKey : time ? localHhmm(t.startsAt, state.scope.timeZone) === time.padStart(5, "0") : onDay.length === 1));
  if (!slot) {
    const alternatives = (onDay.length > 0 ? onDay : open).slice(0, 4).map((t) => `${t.dayLabel}, ${t.label}`);
    return { ok: false, reason: "That time isn't open.", open_alternatives: alternatives };
  }
  const contact = booking.contact_id ? await findScopedContact(state.admin, state.scope, booking.contact_id) : null;
  const proposal = rescheduleProposal(booking, contactName(contact), { startsAt: slot.startsAt, windowKey: slot.windowKey }, state.scope.timeZone);
  state.confirmation = await createApproval(state.admin, {
    organizationId: state.scope.organizationId,
    companyId: state.scope.companyId,
    contactId: booking.contact_id,
    kind: OWNER_COMMAND_KIND,
    summary: proposal.summary,
    payload: proposal.payload,
    requestedBy: "owner_command",
    expiresInMinutes: CONFIRM_MINUTES,
    notified: true,
  });
  return { ok: true, asked_owner: proposal.summary };
}

async function proposeCancelTool(state: ToolRunState, input: Input) {
  const booking = await findScopedBooking(state.admin, state.scope, input.booking_id);
  if (!booking || booking.status === "cancelled") return { error: "No such booking for this business." };
  const contact = booking.contact_id ? await findScopedContact(state.admin, state.scope, booking.contact_id) : null;
  const proposal = cancelProposal(booking, contactName(contact), state.scope.timeZone);
  state.confirmation = await createApproval(state.admin, {
    organizationId: state.scope.organizationId,
    companyId: state.scope.companyId,
    contactId: booking.contact_id,
    kind: OWNER_COMMAND_KIND,
    summary: proposal.summary,
    payload: proposal.payload,
    requestedBy: "owner_command",
    expiresInMinutes: CONFIRM_MINUTES,
    notified: true,
  });
  return { ok: true, asked_owner: proposal.summary };
}

async function textCustomerTool(state: ToolRunState, input: Input) {
  const contact = await findScopedContact(state.admin, state.scope, input.contact_id);
  if (!contact) return { error: "No such customer for this business." };
  const message = str(input.message);
  if (!message) return { error: "What should I say?" };
  if (!contact.phone) return { ok: false, reason: `${contactName(contact)} has no phone number on file.` };
  const result = await deliverMessage({
    context: ctxFor(state.admin, state.scope.organizationId),
    channel: "sms",
    to: contact.phone,
    body: message.slice(0, 600),
    companyId: state.scope.companyId,
    contactId: contact.id,
    consentContact: contact,
  });
  if (result.status !== "sent") {
    const why = result.reason === "opted_out" ? "they've opted out of texts" : result.reason ?? "the text didn't go through";
    return { ok: false, reason: `Not sent — ${why}.` };
  }
  try {
    await markOwnerTakeover(state.admin, { companyId: state.scope.companyId, contactId: contact.id });
  } catch (err) {
    console.error("[owner-channel] takeover mark failed:", err instanceof Error ? err.message : err);
  }
  return { ok: true, sent_to: contactName(contact), text: result.body, note: "The AI will stay out of this conversation for now." };
}

async function setAiForCustomerTool(state: ToolRunState, input: Input) {
  const contact = await findScopedContact(state.admin, state.scope, input.contact_id);
  if (!contact) return { error: "No such customer for this business." };
  const on = input.on === true;
  await setConversationAi(state.admin, { companyId: state.scope.companyId, contactId: contact.id, on });
  return { ok: true, customer: contactName(contact), ai: on ? "on" : "off" };
}

/** Run one tool call. Returns a JSON-able result for the model (never throws). */
export async function runOwnerTool(state: ToolRunState, name: string, input: Input): Promise<Record<string, unknown>> {
  try {
    let result: Record<string, unknown>;
    switch (name) {
      case "list_bookings":
        result = await listBookingsTool(state, input);
        break;
      case "waiting_on_me":
        result = await waitingOnMeTool(state);
        break;
      case "find_customer":
        result = await findCustomerTool(state, input);
        break;
      case "find_open_times":
        result = await findOpenTimesTool(state, input);
        break;
      case "propose_reschedule":
        result = await proposeRescheduleTool(state, input);
        break;
      case "propose_cancel":
        result = await proposeCancelTool(state, input);
        break;
      case "text_customer":
        result = await textCustomerTool(state, input);
        break;
      case "set_ai_for_customer":
        result = await setAiForCustomerTool(state, input);
        break;
      case "set_ai_for_business":
        await setBusinessAi(state.admin, state.scope, input.on === true);
        result = { ok: true, ai: input.on === true ? "on" : "off" };
        break;
      case "pause_all_texts":
        result = { ok: true, ...(await pauseAllTexts(state.admin, state.scope)) };
        break;
      case "resume_all_texts":
        result = { ok: true, ...(await resumeAllTexts(state.admin, state.scope)) };
        break;
      default:
        result = { error: `Unknown tool ${name}.` };
    }
    state.actions.push({ tool: name, ok: !("error" in result) && result.ok !== false });
    return result;
  } catch (err) {
    console.error(`[owner-channel] tool ${name} failed:`, err instanceof Error ? err.message : err);
    state.actions.push({ tool: name, ok: false });
    return { error: "That didn't work on our side." };
  }
}
