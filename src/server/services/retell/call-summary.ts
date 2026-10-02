/**
 * The owner's end-of-call text — "what Marina just did", in four lines.
 *
 * Ported from a1marinecare/src/lib/retell/webhook.ts (buildOwnerSms). What changed: the
 * outcome (quoted amount, booked window, deposit) is read from EmpireVu's own records for
 * that call — the quote Marina created, the booking made with the call's id, the deposit
 * event — rather than the Care site's database, so it works for every company.
 *
 * Surfaced to automations as `{{ call.owner_summary }}` (workflow-engine/context.ts), so the
 * "Text me after every call" recipe is an ordinary, editable notify_owner step.
 *
 *   📞 Marina call done · 705-555-1234 · 3m05s
 *   Dana Lee · 24 ft bowrider · shrink wrap, winterization
 *   Quoted $1,153.25 · Booked Tuesday, September 29th in the morning · deposit link sent
 *   The caller wanted…
 */
import { spokenWindowLabel, localDate, parseBookingPolicy, DEFAULT_BOOKING_POLICY } from "@/server/services/booking-windows";
import { boatFromSnapshot, formatDollars } from "./caller-lookup";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

export interface CallSummaryInput {
  agentName: string;
  direction: "inbound" | "outbound" | string | null;
  fromNumber: string | null;
  toNumber: string | null;
  durationMs: number | null;
  inVoicemail: boolean | null;
  callSuccessful: boolean | null;
  disconnectionReason: string | null;
  summary: string | null;
  urgent: boolean;
  analysis: Record<string, unknown>;
  contactName: string | null;
  quote: { subtotalCents: number; boat: string; depositPaid: boolean } | null;
  bookingLabel: string | null;
  depositLinkSent: boolean;
}

/** "705-555-1234" for a North American number (the A1 Care site's owner-text format); the raw value otherwise. */
export function prettyPhone(raw: string | null | undefined): string {
  const d = (raw ?? "").replace(/\D/g, "");
  const ten = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
  return ten.length === 10 ? `${ten.slice(0, 3)}-${ten.slice(3, 6)}-${ten.slice(6)}` : raw?.trim() || "unknown number";
}

/** "2:05p.m." — the clock time in the owner's call-started text (A1 Care site format). */
export function ownerClockTime(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, hour: "numeric", minute: "2-digit" })
    .format(at)
    .toLowerCase()
    .replace(/\s+/g, "");
}

export function formatDuration(ms: number | null): string {
  if (!ms) return "";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
}

function truncate(s: string, n = 220): string {
  return s.length > n ? `${s.slice(0, n - 3)}…` : s;
}

/** Did Marina promise a callback (failed transfer, or asked for the owner)? */
export function callbackPromised(analysis: Record<string, unknown>, summary: string, disconnectionReason: string | null): boolean {
  if (disconnectionReason?.includes("transfer")) return false;
  if (analysis.callback_requested === true) return true;
  return /call (him|her|them|you) back|call back within|will call (you|them) back|return (the|your) call/i.test(summary);
}

/** An outbound call nobody really answered. */
export function outboundMissed(input: Pick<CallSummaryInput, "inVoicemail" | "durationMs" | "disconnectionReason">): "voicemail" | "no_answer" | null {
  if (input.inVoicemail) return "voicemail";
  const reason = input.disconnectionReason ?? "";
  if (/no_answer|dial_no_answer|dial_busy|dial_failed|voicemail/.test(reason)) return reason.includes("voicemail") ? "voicemail" : "no_answer";
  if (input.durationMs != null && input.durationMs < 8000) return "no_answer";
  return null;
}

/** PURE — the text itself. */
export function buildCallSummary(input: CallSummaryInput): string {
  const a = input.analysis;
  const summary = str(input.summary);
  const services = Array.isArray(a.services_requested) ? a.services_requested.map(String).join(", ") : str(a.services_requested);
  const name = input.contactName || str(a.caller_name);
  const boat =
    input.quote?.boat ||
    [str(a.boat_length_ft) && `${str(a.boat_length_ft)} ft`, str(a.boat_type)].filter(Boolean).join(" ");

  const status: string[] = [];
  if (input.quote) status.push(`Quoted ${formatDollars(input.quote.subtotalCents)}`);
  if (input.bookingLabel) status.push(`Booked ${input.bookingLabel}`);
  else if (a.booked === true) status.push("Booked");
  if (input.quote?.depositPaid) status.push("deposit PAID");
  else if (input.depositLinkSent || a.deposit_link_sent === true) status.push("deposit link sent");
  if (input.disconnectionReason?.includes("transfer")) status.push("transferred to you");

  if (input.direction === "outbound") {
    const missed = outboundMissed(input);
    if (missed) status.unshift(missed === "voicemail" ? "voicemail left" : "no answer");
    const who = [name || "lead", boat].filter(Boolean).join(" · ");
    return [
      `📤 ${input.agentName} called ${prettyPhone(input.toNumber)} · ${who}${input.durationMs ? ` · ${formatDuration(input.durationMs)}` : ""}`,
      status.join(" · "),
      !missed && summary ? truncate(summary) : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (input.urgent) status.push("URGENT");
  const from = prettyPhone(input.fromNumber);
  const lines = [
    `📞 ${input.agentName} call done · ${from}${input.durationMs ? ` · ${formatDuration(input.durationMs)}` : ""}${input.inVoicemail ? " · voicemail" : ""}`,
    [name || "Unknown caller", boat, services].filter(Boolean).join(" · "),
    status.join(" · "),
    callbackPromised(a, summary, input.disconnectionReason)
      ? `☎️ CALL BACK ${from} — ${input.agentName} told them you'd call within the hour.`
      : "",
    summary ? truncate(summary) : "",
  ];
  return lines.filter(Boolean).join("\n");
}

// ── Loading the outcome of a call ───────────────────────────────────────────────

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export interface LoadedCall {
  call_id: string;
  summary: string | null;
  from_number: string | null;
  to_number: string | null;
  direction: string | null;
  duration: string;
  owner_summary: string;
}

/**
 * Everything a message template may say about a call, scoped to the tenant. Null when the
 * call isn't this organization's. Best-effort reads.
 */
export async function loadCallForTemplate(
  db: Db,
  organizationId: string,
  callId: string,
  opts: { agentName: string; timeZone: string },
): Promise<LoadedCall | null> {
  const { data: call } = await db
    .from("retell_calls")
    .select(
      "call_id, company_id, contact_id, lead_id, direction, from_number, to_number, duration_ms, in_voicemail, call_successful, call_summary, custom_analysis_data, raw_payload, is_urgent",
    )
    .eq("organization_id", organizationId)
    .eq("call_id", callId)
    .maybeSingle();
  if (!call) return null;

  const [contactRes, quoteRes, bookingRes, companyRes] = await Promise.all([
    call.contact_id
      ? db.from("contacts").select("first_name, last_name").eq("organization_id", organizationId).eq("id", call.contact_id).maybeSingle()
      : Promise.resolve({ data: null }),
    call.lead_id
      ? db
          .from("quotes")
          .select("id, subtotal_cents, deposit_paid_at, input_snapshot")
          .eq("organization_id", organizationId)
          .eq("source_lead_id", call.lead_id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    db
      .from("bookings")
      .select("scheduled_for, window_key")
      .eq("organization_id", organizationId)
      .eq("source_call_id", callId)
      .neq("status", "cancelled")
      .limit(1)
      .maybeSingle(),
    call.company_id
      ? db.from("companies").select("booking_policy").eq("id", call.company_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const quote = quoteRes?.data ?? null;
  let depositLinkSent = false;
  if (quote && !quote.deposit_paid_at) {
    const { data: sent } = await db
      .from("quote_events")
      .select("id")
      .eq("quote_id", quote.id)
      .eq("event_type", "deposit_link_sent")
      .limit(1)
      .maybeSingle();
    depositLinkSent = Boolean(sent);
  }

  let bookingLabel: string | null = null;
  const booking = bookingRes?.data ?? null;
  if (booking) {
    const policy = parseBookingPolicy(companyRes?.data?.booking_policy ?? null) ?? DEFAULT_BOOKING_POLICY;
    const w = policy.windows.find((x) => x.key === booking.window_key);
    const date = localDate(new Date(booking.scheduled_for), opts.timeZone);
    bookingLabel = w ? spokenWindowLabel(date, w) : date;
  }

  const raw = obj(call.raw_payload);
  const rawCall = obj(raw.call);
  const contact = contactRes?.data ?? null;
  const input: CallSummaryInput = {
    agentName: opts.agentName,
    direction: call.direction,
    fromNumber: call.from_number,
    toNumber: call.to_number,
    durationMs: call.duration_ms,
    inVoicemail: call.in_voicemail,
    callSuccessful: call.call_successful,
    disconnectionReason: str(rawCall.disconnection_reason) || null,
    summary: call.call_summary,
    urgent: call.is_urgent === true,
    analysis: obj(call.custom_analysis_data),
    contactName: contact ? [contact.first_name, contact.last_name].filter(Boolean).join(" ") || null : null,
    quote: quote
      ? { subtotalCents: Number(quote.subtotal_cents ?? 0), boat: boatFromSnapshot(quote.input_snapshot), depositPaid: Boolean(quote.deposit_paid_at) }
      : null,
    bookingLabel,
    depositLinkSent,
  };

  return {
    call_id: call.call_id,
    summary: call.call_summary,
    from_number: prettyPhone(call.from_number),
    to_number: prettyPhone(call.to_number),
    direction: call.direction,
    duration: formatDuration(call.duration_ms),
    owner_summary: buildCallSummary(input),
  };
}
