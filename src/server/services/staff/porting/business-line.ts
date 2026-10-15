/**
 * SANCTIONED EXCEPTION #4c (voice by-number routing — ported business line, docs/ai-staff.md →
 * "Keep your number"). A ported main number's Voice URL is /api/twilio/voice/business-line. The
 * tenant is resolved ONLY from the number that was called (voice_numbers, provider twilio, mode
 * business_line); the request is X-Twilio-Signature-verified first; nothing in the payload picks
 * an organization or company.
 *
 *   1. The call comes in → ring the owner's cell (and, if set, team members' cells) for
 *      `ring.seconds` (default 20). The caller hears ringing; the owner sees the caller's number.
 *   2. With `ring.screen` (default on) whoever answers hears "Call for <business>. Press 1 to take
 *      it." — so a cell's own voicemail never swallows the call. Pressing 1 is recorded
 *      (business_line_calls.accepted_at, keyed by the parent CallSid in our own signed URL).
 *   3. The <Dial> ends → answered (completed, and accepted when screening) → hang up. Anything
 *      else → <Redirect> to /api/twilio/voice/inbound, the existing catcher path UNCHANGED
 *      (durable job, AI answering or the greeting + voicemail, missed-call text-back).
 * Any failure on our side → straight to step 3's redirect, so a caller is never lost.
 * SMS to the ported number needs nothing here: inbound SMS already routes any active Twilio
 * voice_numbers row (twilio/inbound-sms.ts), exactly like the catcher number.
 */
import { isDoneForYou } from "@/lib/product-line";
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { toE164 } from "@/server/services/retell/payload";
import { BUSINESS_LINE_MODE, type Db } from "@/server/services/staff/porting/db-types";
import { platformNumbers } from "@/server/services/staff/porting/guards";
import { readPortingSettings, type RingSettings } from "@/server/services/staff/porting/settings";
import { VOICE_BUSINESS_LINE_PATH as BUSINESS_LINE_PATH, VOICE_INBOUND_PATH as INBOUND_PATH } from "@/server/services/twilio/voice-config";
import { DEFAULT_SAY_VOICE, escapeXml } from "@/server/services/twilio/voice-twiml";

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>';
/** Twilio allows up to 10 <Number>s in one <Dial>; we ring at most this many. */
export const MAX_RING_TARGETS = 5;
const SCREEN_GATHER_SECONDS = 8;

export interface BusinessLineTenant {
  organizationId: string;
  companyId: string;
  companyName: string;
  businessLine: string;
  ring: RingSettings;
  /** E.164 cells to ring (owner first), never one of our own numbers. */
  targets: string[];
}

/** Every number we own or route (never ring one of them — that would loop back to us). */
async function ourNumbers(admin: AdminClient, organizationId: string): Promise<Set<string>> {
  const { data } = await (admin as Db).from("voice_numbers").select("phone_e164").eq("organization_id", organizationId);
  const set = new Set(((data ?? []) as Array<{ phone_e164: string }>).map((r) => r.phone_e164));
  for (const e of platformNumbers()) set.add(e);
  return set;
}

/** Who to ring, owner first, deduplicated, without our own numbers. PURE. */
export function ringTargets(input: { ownerPhone: string | null; crewPhones: Array<string | null>; crew: boolean; exclude: Set<string> }): string[] {
  const out: string[] = [];
  const add = (raw: string | null) => {
    const e = toE164(raw);
    if (!e || !/^\+\d{10,15}$/.test(e) || input.exclude.has(e) || out.includes(e)) return;
    out.push(e);
  };
  add(input.ownerPhone);
  if (input.crew) for (const p of input.crewPhones) add(p);
  return out.slice(0, MAX_RING_TARGETS);
}

/** The tenant for a call to a ported business line, or null when the number isn't one. */
export async function resolveBusinessLineTenant(admin: AdminClient, calledNumber: string | null): Promise<BusinessLineTenant | null> {
  const phone = toE164(calledNumber);
  if (!phone) return null;
  const db = admin as Db;
  const { data: row, error } = await db
    .from("voice_numbers")
    .select("organization_id, company_id, phone_e164, brand_label")
    .eq("phone_e164", phone)
    .eq("provider", "twilio")
    .eq("mode", BUSINESS_LINE_MODE)
    .eq("active", true)
    .maybeSingle();
  if (error) throw error;
  const number = row as { organization_id: string; company_id: string; phone_e164: string; brand_label: string | null } | null;
  if (!number) return null;

  const { data: companyData } = await db
    .from("companies")
    .select("name, owner_phone_e164, owner_phone_verified_at, ai_settings")
    .eq("organization_id", number.organization_id)
    .eq("id", number.company_id)
    .maybeSingle();
  const company = companyData as { name: string | null; owner_phone_e164: string | null; owner_phone_verified_at: string | null; ai_settings: unknown } | null;
  // Only a VERIFIED owner cell is rung (an unverified one might not be the owner's at all).
  const ownerPhone = company?.owner_phone_e164 && company.owner_phone_verified_at ? company.owner_phone_e164 : null;
  const { data: org } = await db.from("organizations").select("platform_brand").eq("id", number.organization_id).maybeSingle();
  const ring = readPortingSettings(company?.ai_settings, { doneForYou: isDoneForYou((org as { platform_brand: string | null } | null)?.platform_brand) }).ring;

  let crewPhones: Array<string | null> = [];
  if (ring.crew) {
    // This company's people when company memberships exist for it, else the org's; oldest
    // members first (deterministic, and the 5-number cap keeps the longest-serving).
    const { data: companyMembers } = await db
      .from("company_memberships")
      .select("profile_id")
      .eq("organization_id", number.organization_id)
      .eq("company_id", number.company_id)
      .limit(100);
    const profileIds = ((companyMembers ?? []) as Array<{ profile_id: string }>).map((m) => m.profile_id);
    let query = db.from("organization_memberships").select("profile_id, phone_e164, joined_at").eq("organization_id", number.organization_id);
    if (profileIds.length > 0) query = query.in("profile_id", profileIds);
    const { data: members } = await query.order("joined_at", { ascending: true }).order("profile_id", { ascending: true }).limit(50);
    crewPhones = ((members ?? []) as Array<{ phone_e164: string | null }>).map((m) => m.phone_e164);
  }
  const exclude = await ourNumbers(admin, number.organization_id);
  exclude.add(number.phone_e164);
  return {
    organizationId: number.organization_id,
    companyId: number.company_id,
    companyName: company?.name?.trim() || number.brand_label || "your business",
    businessLine: number.phone_e164,
    ring,
    targets: ring.enabled ? ringTargets({ ownerPhone, crewPhones, crew: ring.crew, exclude }) : [],
  };
}

// ── TwiML (pure) ─────────────────────────────────────────────────────────────

export interface RingTwimlInput {
  targets: string[];
  seconds: number;
  /** <Dial> action: …/business-line?stage=after */
  actionUrl: string;
  /** <Number url> whisper (screening) or null. */
  screenUrl: string | null;
  /** The caller's number, shown on the owner's phone (omitted when withheld). */
  callerId: string | null;
}

export function buildRingOwnerTwiml(input: RingTwimlInput): string {
  const attrs = [`action="${escapeXml(input.actionUrl)}"`, `method="POST"`, `timeout="${Math.round(input.seconds)}"`, `answerOnBridge="true"`];
  if (input.callerId) attrs.push(`callerId="${escapeXml(input.callerId)}"`);
  const numbers = input.targets
    .map((t) => (input.screenUrl ? `<Number url="${escapeXml(input.screenUrl)}" method="POST">${escapeXml(t)}</Number>` : `<Number>${escapeXml(t)}</Number>`))
    .join("");
  return `${XML_HEADER}<Response><Dial ${attrs.join(" ")}>${numbers}</Dial></Response>`;
}

/** What the owner hears on picking up (screening): press 1 or it goes to the AI / voicemail. */
export function screenPrompt(companyName: string | null): string {
  const name = companyName?.trim();
  return `${name ? `Call for ${name}.` : "Business call."} Press 1 to take it.`;
}

export function buildScreenTwiml(input: { companyName: string | null; actionUrl: string; voice?: string }): string {
  const voice = escapeXml(input.voice?.trim() || DEFAULT_SAY_VOICE);
  return (
    `${XML_HEADER}<Response>` +
    `<Gather numDigits="1" timeout="${SCREEN_GATHER_SECONDS}" action="${escapeXml(input.actionUrl)}" method="POST">` +
    `<Say voice="${voice}">${escapeXml(screenPrompt(input.companyName))}</Say>` +
    `</Gather><Hangup/></Response>`
  );
}

/** Pressed 1 → an empty response bridges the call. Anything else → hang up this leg only. */
export function buildScreenedTwiml(accepted: boolean): string {
  return accepted ? `${XML_HEADER}<Response></Response>` : `${XML_HEADER}<Response><Hangup/></Response>`;
}

/** Nobody took it → the existing catcher path (AI answering or voicemail + text-back). */
export function buildFallThroughTwiml(inboundUrl: string): string {
  return `${XML_HEADER}<Response><Redirect method="POST">${escapeXml(inboundUrl)}</Redirect></Response>`;
}

export function buildAnsweredTwiml(): string {
  return `${XML_HEADER}<Response><Hangup/></Response>`;
}

// ── Call records ─────────────────────────────────────────────────────────────

export async function recordRing(admin: AdminClient, tenant: BusinessLineTenant, callSid: string, screen: boolean): Promise<void> {
  const { error } = await (admin as Db).from("business_line_calls").insert({
    organization_id: tenant.organizationId,
    company_id: tenant.companyId,
    call_sid: callSid,
    business_line: tenant.businessLine,
    rang: tenant.targets,
    screen,
  });
  // A redelivered webhook (same CallSid) keeps the first row.
  if (error && (error as { code?: string }).code !== "23505") throw error;
}

export async function loadCall(admin: AdminClient, callSid: string): Promise<{ organization_id: string; company_id: string; screen: boolean; accepted_at: string | null } | null> {
  const { data } = await (admin as Db).from("business_line_calls").select("organization_id, company_id, screen, accepted_at").eq("call_sid", callSid).maybeSingle();
  return (data as { organization_id: string; company_id: string; screen: boolean; accepted_at: string | null } | null) ?? null;
}

export async function companyNameForCall(admin: AdminClient, call: { organization_id: string; company_id: string }): Promise<string | null> {
  const { data } = await (admin as Db).from("companies").select("name").eq("organization_id", call.organization_id).eq("id", call.company_id).maybeSingle();
  return (data as { name: string | null } | null)?.name ?? null;
}

export async function markAccepted(admin: AdminClient, callSid: string, nowMs: number): Promise<void> {
  await (admin as Db).from("business_line_calls").update({ accepted_at: new Date(nowMs).toISOString() }).eq("call_sid", callSid).is("accepted_at", null);
}

export async function markOutcome(admin: AdminClient, callSid: string, outcome: "answered" | "missed"): Promise<void> {
  await (admin as Db).from("business_line_calls").update({ outcome }).eq("call_sid", callSid).is("outcome", null);
}

/**
 * The <Dial> ended: was the call really taken? Completed AND (no screening, or someone pressed 1).
 * Without a call record (it couldn't be written) a completed dial counts as answered only when
 * Twilio says it was bridged. PURE.
 */
export function wasAnswered(input: { dialCallStatus: string | null; dialBridged: string | null; call: { screen: boolean; accepted_at: string | null } | null }): boolean {
  if (input.dialCallStatus !== "completed") return false;
  if (input.dialBridged === "false") return false;
  // Twilio says the legs were bridged: someone took it (even if recording the press-1 failed).
  if (input.dialBridged === "true") return true;
  if (!input.call) return false;
  return input.call.screen ? Boolean(input.call.accepted_at) : true;
}

// ── The webhook, stage by stage ──────────────────────────────────────────────

export type BusinessLineStage = "incoming" | "screen" | "screened" | "after";

export function readStage(url: URL): BusinessLineStage {
  const stage = url.searchParams.get("stage");
  return stage === "screen" || stage === "screened" || stage === "after" ? stage : "incoming";
}

/** CallSid-shaped (only ever from our own signed URL or Twilio, but checked anyway). */
function callSidOrNull(value: string | null | undefined): string | null {
  return value && /^CA[0-9A-Za-z]{2,64}$/.test(value) ? value : null;
}

/**
 * The TwiML for one (signature-verified) request to /api/twilio/voice/business-line.
 * `base` is the public origin; `parent` comes from our own signed URL on the screen stages.
 */
export async function businessLineResponse(
  admin: AdminClient,
  input: { stage: BusinessLineStage; params: Record<string, string>; base: string; parent: string | null; nowMs?: number; voice?: string },
): Promise<string> {
  const nowMs = input.nowMs ?? Date.now();
  const self = `${input.base}${BUSINESS_LINE_PATH}`;
  const fallThrough = buildFallThroughTwiml(`${input.base}${INBOUND_PATH}`);
  const { params } = input;

  if (input.stage === "screen" || input.stage === "screened") {
    // The owner's leg (a child call). Its own CallSid isn't the caller's; the parent is in our URL.
    const parent = callSidOrNull(input.parent);
    if (!parent) return buildScreenedTwiml(false);
    if (input.stage === "screen") {
      let name: string | null = null;
      try {
        const call = await loadCall(admin, parent);
        name = call ? await companyNameForCall(admin, call) : null;
      } catch {
        name = null;
      }
      return buildScreenTwiml({ companyName: name, actionUrl: `${self}?stage=screened&parent=${encodeURIComponent(parent)}`, voice: input.voice });
    }
    const accepted = (params.Digits ?? "").trim() === "1";
    if (accepted) {
      try {
        await markAccepted(admin, parent, nowMs);
      } catch (err) {
        console.error("[business-line] could not record the pickup:", err instanceof Error ? err.message : err);
      }
    }
    return buildScreenedTwiml(accepted);
  }

  const callSid = callSidOrNull(params.CallSid);
  if (input.stage === "after") {
    if (!callSid) return fallThrough;
    let call: Awaited<ReturnType<typeof loadCall>> = null;
    try {
      call = await loadCall(admin, callSid);
    } catch {
      call = null;
    }
    const answered = wasAnswered({ dialCallStatus: (params.DialCallStatus ?? "").toLowerCase() || null, dialBridged: params.DialBridged ?? null, call });
    try {
      await markOutcome(admin, callSid, answered ? "answered" : "missed");
    } catch {
      /* the record is a nicety; the caller isn't */
    }
    return answered ? buildAnsweredTwiml() : fallThrough;
  }

  // A new call to the business line.
  if (!callSid) return fallThrough;
  try {
    const tenant = await resolveBusinessLineTenant(admin, params.To ?? params.Called ?? null);
    if (!tenant || tenant.targets.length === 0) return fallThrough;
    await recordRing(admin, tenant, callSid, tenant.ring.screen);
    const caller = toE164(params.From ?? null);
    return buildRingOwnerTwiml({
      targets: tenant.targets,
      seconds: tenant.ring.seconds,
      actionUrl: `${self}?stage=after`,
      screenUrl: tenant.ring.screen ? `${self}?stage=screen&parent=${encodeURIComponent(callSid)}` : null,
      callerId: caller && /^\+\d{10,15}$/.test(caller) ? caller : null,
    });
  } catch (err) {
    console.error("[business-line] ring setup failed (catcher path instead):", err instanceof Error ? err.message : err);
    return fallThrough;
  }
}
