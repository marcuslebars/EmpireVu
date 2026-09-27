// ─────────────────────────────────────────────────────────────────────────────
// SANCTIONED EXCEPTION #4 (Retell, continued): the inbound-call lookup runs while the
// phone is still ringing, with no user session. The company is resolved from the NUMBER
// the call came in on; the lookup is read-only and scoped to that company's contacts.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Who is calling? Answers Retell's inbound-call webhook with the dynamic variables
 * Marina's prompt reads, so a returning caller is greeted by name and boat and she picks
 * up where they left off (quote on file, date booked, deposit paid).
 *
 * Replaces a1marinecare/src/lib/retell/caller-lookup.ts and keeps its variable names
 * (greeting, caller_known, caller_first_name, caller_boat, caller_services, quote_id,
 * quote_total, quote_age, booked_window, deposit_paid, deposit_link_sent) so the agent's
 * prompt does not change at cutover.
 *
 * Strictly fail-open: every value is a string, unknown is "", and any failure answers as
 * a new caller. A slow lookup must degrade the greeting, never delay the call.
 */
import type { RetellAdminClient } from "./tenant";

export const DEFAULT_AGENT_NAME = "Marina";
/** Quotes older than this aren't "on file" for the greeting — the season has moved on. */
const QUOTE_LOOKBACK_DAYS = 120;

export interface CallerProfile {
  known: boolean;
  firstName: string;
  fullName: string;
  boat: string;
  services: string;
  quoteId: string;
  quoteTotal: string;
  quoteAgeLabel: string;
  bookedWindow: string;
  depositPaid: boolean;
  depositLinkSent: boolean;
}

export const UNKNOWN_CALLER: CallerProfile = {
  known: false,
  firstName: "",
  fullName: "",
  boat: "",
  services: "",
  quoteId: "",
  quoteTotal: "",
  quoteAgeLabel: "",
  bookedWindow: "",
  depositPaid: false,
  depositLinkSent: false,
};

export interface GreetingContext {
  companyName: string;
  agentName: string;
  /** Owner-set templates from company_voice_profiles.dynamic_variables, if any. */
  greetingNew?: string | null;
  greetingReturning?: string | null;
  /** The company's IANA zone, when set — used to say a booked day and half-day. */
  timeZone?: string | null;
}

export function last10(phone: string | null | undefined): string | null {
  const d = (phone ?? "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : null;
}

/** Calendar days between two instants in a zone — "yesterday" means the date, not 24 h. */
function calendarDaysBetween(at: Date, now: Date, timeZone: string): number {
  const ymd = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  return Math.round((Date.parse(ymd(now)) - Date.parse(ymd(at))) / 86_400_000);
}

export function ageLabel(at: Date, now = new Date(), timeZone = "America/Toronto"): string {
  const days = calendarDaysBetween(at, now, timeZone);
  if (days <= 0) return "earlier today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 14) return "last week";
  return `${Math.round(days / 7)} weeks ago`;
}

/** "$672" / "$1,153.25" — the way it's written on the quote. */
export function formatDollars(cents: number): string {
  const dollars = cents / 100;
  return Number.isInteger(dollars)
    ? `$${dollars.toLocaleString("en-CA")}`
    : `$${dollars.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** "Tuesday, September 29 in the morning" — how Marina says a booked slot. */
export function spokenBooking(scheduledFor: string, timeZone: string): string {
  const at = new Date(scheduledFor);
  if (!Number.isFinite(at.getTime())) return "";
  const day = new Intl.DateTimeFormat("en-CA", { timeZone, weekday: "long", month: "long", day: "numeric" }).format(at);
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).format(at));
  return `${day} ${hour < 12 ? "in the morning" : "in the afternoon"}`;
}

function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => vars[k] ?? "").replace(/\s{2,}/g, " ").trim();
}

/** "Thanks for calling A1 Marine Care, this is Marina." — or just "Hi, this is Marina." when the brand is unknown. */
function opener(g: GreetingContext): string {
  return g.companyName ? `Thanks for calling ${g.companyName}, this is ${g.agentName}.` : `Hi, this is ${g.agentName}.`;
}

export function greetingFor(p: CallerProfile, g: GreetingContext): string {
  const vars = {
    company_name: g.companyName,
    agent_name: g.agentName,
    caller_first_name: p.firstName,
    caller_boat: p.boat,
  };
  if (p.known) {
    if (g.greetingReturning?.trim()) return fill(g.greetingReturning, vars);
    const about = p.boat ? `are you calling about the ${p.boat}?` : "how can I help today?";
    return `${opener(g)} Hi ${p.firstName || "there"} — ${about}`;
  }
  if (g.greetingNew?.trim()) return fill(g.greetingNew, vars);
  return `${opener(g)} How can I help you today?`;
}

/** The dynamic variables Marina's prompt reads. Every value is a string. */
export function toDynamicVariables(p: CallerProfile, g: GreetingContext): Record<string, string> {
  return {
    greeting: greetingFor(p, g),
    caller_known: p.known ? "true" : "false",
    caller_first_name: p.firstName,
    caller_boat: p.boat,
    caller_services: p.services,
    quote_id: p.quoteId,
    quote_total: p.quoteTotal,
    quote_age: p.quoteAgeLabel,
    booked_window: p.bookedWindow,
    deposit_paid: p.depositPaid ? "true" : "false",
    deposit_link_sent: p.depositLinkSent ? "true" : "false",
  };
}

/** "24 ft bowrider" from the quote's own pricing inputs. */
export function boatFromSnapshot(snapshot: unknown): string {
  const snap = (snapshot && typeof snapshot === "object" ? snapshot : {}) as {
    services?: Array<{ lengthFt?: number }>;
    hullType?: string | null;
  };
  const length = snap.services?.find((s) => typeof s.lengthFt === "number")?.lengthFt;
  const hull = snap.hullType && snap.hullType !== "other" ? snap.hullType : "boat";
  return length ? `${length} ft ${hull}` : snap.hullType && snap.hullType !== "other" ? snap.hullType : "";
}

function servicesFromLines(lines: unknown): string {
  if (!Array.isArray(lines)) return "";
  return lines
    .filter((l) => l && l.selected !== false)
    .map((l) => String(l.label ?? "").replace(/^Mobile\s+/i, "").split(" — ")[0])
    .filter(Boolean)
    .join(", ");
}

interface LookupInput {
  organizationId: string;
  companyId: string;
  phone: string | null;
  timeZone: string;
  now?: Date;
}

/** Read-only, best-effort. Any error → UNKNOWN_CALLER. */
export async function lookupCaller(admin: RetellAdminClient, input: LookupInput): Promise<CallerProfile> {
  const digits = last10(input.phone);
  if (!digits) return UNKNOWN_CALLER;
  const now = input.now ?? new Date();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = admin as any;

  try {
    const { data: contact } = await db
      .from("contacts")
      .select("id, first_name, last_name")
      .eq("organization_id", input.organizationId)
      .eq("company_id", input.companyId)
      .eq("phone_last10", digits)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!contact) return UNKNOWN_CALLER;

    const since = new Date(now.getTime() - QUOTE_LOOKBACK_DAYS * 86_400_000).toISOString();
    const [{ data: quote }, { data: booking }] = await Promise.all([
      db
        .from("quotes")
        .select("id, subtotal_cents, deposit_paid_at, created_at, input_snapshot, line_items, status")
        .eq("organization_id", input.organizationId)
        .eq("company_id", input.companyId)
        .eq("contact_id", contact.id)
        .is("superseded_by", null)
        .not("status", "in", "(cancelled,expired,draft)")
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      db
        .from("bookings")
        .select("scheduled_for")
        .eq("organization_id", input.organizationId)
        .eq("company_id", input.companyId)
        .eq("contact_id", contact.id)
        .neq("status", "cancelled")
        .gte("scheduled_for", now.toISOString())
        .order("scheduled_for", { ascending: true })
        .limit(1)
        .maybeSingle(),
    ]);

    let depositLinkSent = false;
    if (quote && !quote.deposit_paid_at) {
      const { data: sent } = await db
        .from("quote_events")
        .select("id")
        .eq("quote_id", quote.id)
        .in("event_type", ["deposit_link_sent", "checkout_session_created"])
        .limit(1)
        .maybeSingle();
      depositLinkSent = Boolean(sent);
    }

    const fullName = [contact.first_name, contact.last_name].filter(Boolean).join(" ");
    return {
      known: true,
      firstName: contact.first_name ?? "",
      fullName,
      boat: quote ? boatFromSnapshot(quote.input_snapshot) : "",
      services: quote ? servicesFromLines(quote.line_items) : "",
      quoteId: quote?.id ?? "",
      quoteTotal: quote ? formatDollars(Number(quote.subtotal_cents ?? 0)) : "",
      quoteAgeLabel: quote ? ageLabel(new Date(quote.created_at), now, input.timeZone) : "",
      bookedWindow: booking ? spokenBooking(booking.scheduled_for, input.timeZone) : "",
      depositPaid: Boolean(quote?.deposit_paid_at),
      depositLinkSent,
    };
  } catch (err) {
    console.error("[retell:inbound] caller lookup failed:", err instanceof Error ? err.message : err);
    return UNKNOWN_CALLER;
  }
}

/** Company name + the owner's greeting templates, for the greeting line. */
export async function loadGreetingContext(
  admin: RetellAdminClient,
  companyId: string | null,
): Promise<GreetingContext> {
  const fallback: GreetingContext = { companyName: "", agentName: DEFAULT_AGENT_NAME };
  if (!companyId) return fallback;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = admin as any;
  try {
    const [{ data: company }, { data: profile }] = await Promise.all([
      db.from("companies").select("name, timezone").eq("id", companyId).maybeSingle(),
      db
        .from("company_voice_profiles")
        .select("brand_label, dynamic_variables")
        .eq("company_id", companyId)
        .eq("active", true)
        .limit(1)
        .maybeSingle(),
    ]);
    const dyn = (profile?.dynamic_variables && typeof profile.dynamic_variables === "object"
      ? profile.dynamic_variables
      : {}) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
    return {
      companyName: str(profile?.brand_label) ?? str(company?.name) ?? fallback.companyName,
      agentName: str(dyn.agent_name) ?? DEFAULT_AGENT_NAME,
      greetingNew: str(dyn.greeting_new),
      greetingReturning: str(dyn.greeting_returning),
      timeZone: str(company?.timezone),
    };
  } catch {
    return fallback;
  }
}
