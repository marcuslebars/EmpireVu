/**
 * "On our way" texts: when the crew taps On my way (crew/service.ts markEnRoute → a
 * booking.en_route activity event, with the optional etaMinutes), the customer gets one text
 * from the business number — if the setting is on, inside the on-our-way hours (default
 * 07:00–20:00 local), and only if the company's own "On my way" automation (the
 * crew-on-the-way recipe, or any active booking.en_route automation that texts) isn't on —
 * that one already texts, so we never double up.
 *
 * One text per booking (dispatch_messages unique key = booking id).
 */
import { isDoneForYou } from "@/lib/product-line";
import type { Json, Tables } from "@/server/db/database.types";
import type { AdminClient } from "@/server/services/front-desk/contracts";
import type { DispatchCompany } from "./company";
import type { Db } from "./db-types";
import { claimDispatchMessage, firstName, greeting, jobPhrase, sendClaimedMessage, type SendOutcome } from "./messages";
import { readDispatchSettings } from "./settings";
import { withinLocalHours } from "./time";

/** Events older than this are never acted on (a worker that was down doesn't send stale texts). */
export const ON_OUR_WAY_LOOKBACK_MS = 20 * 60_000;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** PURE: "about 20 minutes" / "about an hour" / "about 1 hour 30 minutes". */
export function etaPhrase(minutes: number): string {
  const m = Math.round(minutes);
  if (m < 60) return `about ${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (rest === 0) return h === 1 ? "about an hour" : `about ${h} hours`;
  return `about ${h} hour${h === 1 ? "" : "s"} ${rest} minutes`;
}

/** PURE: the customer's text. */
export function onOurWayText(input: { businessName: string; customerFirstName: string; crewFirstName: string | null; job: string; etaMinutes: number | null }): string {
  const who = input.crewFirstName ? `${input.crewFirstName} from our crew is` : "Our crew is";
  const when = input.etaMinutes ? ` and should be there in ${etaPhrase(input.etaMinutes)}` : " now";
  return `${greeting(input.customerFirstName)}, it's ${input.businessName}. ${who} on the way for your ${input.job}${when}. See you soon!`;
}

/** PURE: does this workflow definition send a text? */
function sendsSms(definition: Json | unknown): boolean {
  const actions = asRecord(definition).actions;
  return Array.isArray(actions) && actions.some((a) => asRecord(a).type === "send_sms");
}

/**
 * Is the company's own "On my way" automation on (the crew-on-the-way recipe, or any active
 * booking.en_route automation that texts)? Then it texts the customer and we don't.
 */
/**
 * Will "On my way" on this company's jobs send the Dispatcher's heads-up text (setting on, no
 * "On my way" automation texting instead)? The job sheet asks for an ETA only then. Works with
 * the caller's RLS client (members read companies / organizations / workflows). Never throws.
 */
export async function dispatcherOnOurWayActive(db: AdminClient, scope: { organizationId: string; companyId: string }): Promise<boolean> {
  try {
    const { data: company } = await (db as Db)
      .from("companies")
      .select("name, ai_settings, industry_pack")
      .eq("organization_id", scope.organizationId)
      .eq("id", scope.companyId)
      .maybeSingle();
    if (!company) return false;
    const { data: org } = await (db as Db).from("organizations").select("platform_brand").eq("id", scope.organizationId).maybeSingle();
    const c = company as { name: string; ai_settings: unknown; industry_pack: unknown };
    const settings = readDispatchSettings(c.ai_settings, { crankleads: isDoneForYou((org as { platform_brand?: string | null } | null)?.platform_brand), industryPack: c.industry_pack, hints: [c.name] });
    return settings.onOurWay.enabled && !(await enRouteAutomationActive(db, scope));
  } catch {
    return false;
  }
}

export async function enRouteAutomationActive(admin: AdminClient, company: Pick<DispatchCompany, "organizationId" | "companyId">): Promise<boolean> {
  const { data } = await (admin as Db)
    .from("workflows")
    .select("id, company_id, slug, status, trigger_event, definition")
    .eq("organization_id", company.organizationId)
    .eq("trigger_event", "booking.en_route")
    .eq("status", "active")
    .limit(50);
  return ((data ?? []) as Array<Pick<Tables<"workflows">, "company_id" | "slug" | "definition" | "status">>).some(
    (w) => w.status === "active" && (w.company_id === company.companyId || w.company_id === null) && (w.slug === "crew-on-the-way" || sendsSms(w.definition)),
  );
}

interface EnRouteEvent {
  id: string;
  organization_id: string;
  company_id: string | null;
  entity_id: string | null;
  metadata_json: unknown;
  occurred_at?: string;
}

/** PURE: a sane ETA from the event (1–240 minutes) or null. */
export function etaFromMetadata(metadata: unknown): number | null {
  const v = asRecord(metadata).etaMinutes;
  return typeof v === "number" && Number.isFinite(v) && v >= 1 && v <= 240 ? Math.round(v) : null;
}

async function crewFirstName(admin: AdminClient, profileId: unknown): Promise<string | null> {
  if (typeof profileId !== "string" || !profileId) return null;
  const { data } = await (admin as Db).from("profiles").select("full_name").eq("id", profileId).maybeSingle();
  const name = ((data as { full_name: string | null } | null)?.full_name ?? "").trim();
  return name && !name.includes("@") ? name.split(/\s+/)[0] : null;
}

/** Handle one booking.en_route event. */
export async function handleEnRoute(admin: AdminClient, company: DispatchCompany, event: EnRouteEvent, nowMs: number): Promise<SendOutcome | "off" | "automation" | "not_open"> {
  if (!company.settings.onOurWay.enabled) return "off";
  const bookingId = event.entity_id;
  if (!bookingId) return "not_open";
  const db = admin as Db;
  // Already handled (sent / skipped) — the cheap check before anything else.
  const { data: existing } = await db.from("dispatch_messages").select("id").eq("company_id", company.companyId).eq("kind", "on_our_way").eq("dedupe_key", bookingId).limit(1);
  if (((existing ?? []) as unknown[]).length > 0) return "duplicate";
  if (await enRouteAutomationActive(admin, company)) return "automation";

  const { data: bookingData } = await db
    .from("bookings")
    .select("id, contact_id, title, status, en_route_at, started_at, completed_at")
    .eq("organization_id", company.organizationId)
    .eq("company_id", company.companyId)
    .eq("id", bookingId)
    .maybeSingle();
  const booking = bookingData as Pick<Tables<"bookings">, "id" | "contact_id" | "title" | "status" | "en_route_at" | "started_at" | "completed_at"> | null;
  if (!booking || !booking.en_route_at || booking.started_at || booking.completed_at || (booking.status !== "pending" && booking.status !== "confirmed")) return "not_open";

  const { data: contactData } = booking.contact_id
    ? await db
        .from("contacts")
        .select("id, first_name, phone, sms_opt_out_at")
        .eq("organization_id", company.organizationId)
        .eq("company_id", company.companyId)
        .eq("id", booking.contact_id)
        .maybeSingle()
    : { data: null };
  const contact = contactData as Pick<Tables<"contacts">, "id" | "first_name" | "phone" | "sms_opt_out_at"> | null;
  const metadata = asRecord(event.metadata_json);
  const body = onOurWayText({
    businessName: company.businessName,
    customerFirstName: firstName(contact),
    crewFirstName: await crewFirstName(admin, metadata.by),
    job: jobPhrase(booking.title),
    etaMinutes: etaFromMetadata(metadata),
  });
  const input = {
    kind: "on_our_way" as const,
    dedupeKey: booking.id,
    to: contact?.phone ?? null,
    body,
    audience: "customer" as const,
    consent: false,
    bookingId: booking.id,
    contactId: contact?.id ?? null,
    payload: { eventId: event.id, etaMinutes: etaFromMetadata(metadata) },
  };
  if (!contact?.phone) return (await claimDispatchMessage(admin, company, input, "skipped", { reason: "no_phone" })) ? "skipped" : "duplicate";
  if (contact.sms_opt_out_at) return (await claimDispatchMessage(admin, company, input, "skipped", { reason: "opted_out" })) ? "blocked" : "duplicate";
  const hours = company.settings.onOurWay;
  if (!withinLocalHours(nowMs, company.timeZone, hours.from, hours.until)) {
    return (await claimDispatchMessage(admin, company, input, "skipped", { reason: "outside_hours" })) ? "skipped" : "duplicate";
  }
  const row = await claimDispatchMessage(admin, company, input, "sending");
  if (!row) return "duplicate";
  return sendClaimedMessage(admin, company, row, nowMs);
}

/** Scheduler pass (every minute): recent booking.en_route events of companies with the setting on. */
export async function sweepOnOurWay(admin: AdminClient, nowMs: number, companies: Map<string, DispatchCompany>): Promise<void> {
  const enabled = [...companies.values()].filter((c) => c.settings.onOurWay.enabled);
  if (enabled.length === 0) return;
  const orgIds = [...new Set(enabled.map((c) => c.organizationId))];
  const events: EnRouteEvent[] = [];
  for (let i = 0; i < orgIds.length; i += 150) {
    const { data, error } = await (admin as Db)
      .from("activity_events")
      .select("id, organization_id, company_id, entity_id, metadata_json, occurred_at")
      .in("organization_id", orgIds.slice(i, i + 150))
      .eq("event_type", "booking.en_route")
      .gte("occurred_at", new Date(nowMs - ON_OUR_WAY_LOOKBACK_MS).toISOString())
      .order("occurred_at", { ascending: false })
      .limit(200);
    if (error) throw error;
    events.push(...((data ?? []) as EnRouteEvent[]));
  }
  for (const event of events) {
    const company = event.company_id ? companies.get(event.company_id) : undefined;
    if (!company || company.organizationId !== event.organization_id || !company.settings.onOurWay.enabled) continue;
    try {
      await handleEnRoute(admin, company, event, nowMs);
    } catch (err) {
      console.error("[dispatcher] on-our-way failed", event.entity_id, err instanceof Error ? err.message : err);
    }
  }
}
