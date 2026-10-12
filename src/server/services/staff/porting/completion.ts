/**
 * SANCTIONED EXCEPTION (service role): the porting sweeps (docs/ai-staff.md → "Keep your number").
 *
 *   • completion (hourly): for every submitted / FOC-scheduled port, look for each number in the
 *     Twilio account (`listIncoming`, the injected provision client). When it lands — and passes
 *     every guard below — point its Voice URL at /api/twilio/voice/business-line (ring the owner
 *     first) and its SMS URL at the usual inbound route, add a voice_numbers row (provider twilio,
 *     mode business_line) for the company, and once every number is in, mark the port completed
 *     and text the owner.
 *   • notify (5 min): owner status texts still pending (held for quiet hours, or a failed send).
 *   • purge (hourly): ports left in collecting / ready / rejected for ABANDON_AFTER_MS are
 *     cancelled; 14 days after a port completes or is cancelled, the encrypted account number and
 *     PIN and every bill file in the port's folder are deleted (the signed LOA is kept).
 *
 * Guards (guards.ts) — a number is NEVER touched when it is: the platform number
 * (PLATFORM_SMS_NUMBER / TWILIO_FROM_NUMBER), in voice_numbers as anything but this company's
 * business_line (a catcher row is never converted), FriendlyName-tagged as a catcher or another
 * company's line, webhooked anywhere but our business-line route, or already in the Twilio account
 * when the port was submitted (the markSubmitted snapshot). Each refusal is logged for an operator.
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { findVoiceNumberOwner } from "@/server/services/twilio/missed-call";
import type { TwilioIncomingNumber, TwilioNumbersClient } from "@/server/services/twilio/provision";
import { SMS_INBOUND_PATH, twilioWebhookBaseUrl, VOICE_BUSINESS_LINE_PATH } from "@/server/services/twilio/voice-config";
import { toE164 } from "@/server/services/retell/payload";
import { BUSINESS_LINE_MODE, type Db, type NumberPortRow } from "@/server/services/staff/porting/db-types";
import { checkPortable, LINE_TAG_PREFIX, twilioSideOk } from "@/server/services/staff/porting/guards";
import { defaultTwilioClient, deliverOwnerText, transitionPort, type PortingDeps } from "@/server/services/staff/porting/service";
import { EDITABLE_STATUSES, IN_FLIGHT } from "@/server/services/staff/porting/status";
import { portFolder, supabasePortingStorage } from "@/server/services/staff/porting/storage";

export const PURGE_AFTER_MS = 14 * 86_400_000;
/** A port nobody finished (collecting / ready / rejected, untouched this long) is cancelled. */
export const ABANDON_AFTER_MS = 60 * 86_400_000;
const PORTS_PER_PASS = 100;

/** FriendlyName on a ported line (distinct from the catcher tag, so it's never claimed as one). */
export function businessLineFriendlyName(companyId: string): string {
  return `${LINE_TAG_PREFIX}${companyId}`;
}

export interface CompletionDeps extends Partial<PortingDeps> {
  /** The Twilio numbers client; omitted → deps.twilio() / TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN. */
  client?: TwilioNumbersClient | null;
}

export type AttachOutcome = "attached" | "already" | "taken" | "failed";

/**
 * Wire a ported number to the company, after every guard. Webhooks first (so a call that lands
 * meanwhile still gets a valid route), then the voice_numbers row. Idempotent.
 */
export async function attachBusinessLine(
  admin: AdminClient,
  port: Pick<NumberPortRow, "organization_id" | "company_id" | "business_name">,
  number: TwilioIncomingNumber,
  client: TwilioNumbersClient,
  base: string,
): Promise<AttachOutcome> {
  const phone = toE164(number.phone_number) ?? number.phone_number;
  const scope = { organizationId: port.organization_id, companyId: port.company_id };
  const voiceUrl = `${base}${VOICE_BUSINESS_LINE_PATH}`;
  const smsUrl = `${base}${SMS_INBOUND_PATH}`;

  const verdict = await checkPortable(admin, scope, phone);
  if (verdict.reason) {
    console.error(`[porting] ${phone} is ${verdict.reason === "platform" ? "the platform number" : "already connected (catcher or another company)"} - not attached.`);
    return "taken";
  }
  if (!twilioSideOk(number, port.company_id, voiceUrl)) {
    console.error(`[porting] ${phone} is tagged or webhooked for something else in Twilio - not attached (check it in the concierge).`);
    return "taken";
  }
  const owner = await findVoiceNumberOwner(admin, phone);
  // checkPortable passed: any row is already this company's business_line.
  if (owner && owner.active && number.voice_url === voiceUrl && number.sms_url === smsUrl) return "already";

  const friendlyName = businessLineFriendlyName(port.company_id);
  if (number.voice_url !== voiceUrl || number.sms_url !== smsUrl || number.friendly_name !== friendlyName) {
    await client.updateWebhooks(number.sid, { voiceUrl, smsUrl, friendlyName });
  }
  const db = admin as Db;
  const fields = { provider: "twilio", mode: BUSINESS_LINE_MODE, provider_number_sid: number.sid, provider_agent_id: null, brand_label: port.business_name, active: true };
  if (owner) {
    const { error } = await db
      .from("voice_numbers")
      .update(fields)
      .eq("organization_id", port.organization_id)
      .eq("company_id", port.company_id)
      .eq("phone_e164", phone)
      .eq("mode", BUSINESS_LINE_MODE);
    if (error) throw error;
    return "attached";
  }
  const { error } = await db.from("voice_numbers").insert({ ...fields, organization_id: port.organization_id, company_id: port.company_id, phone_e164: phone });
  if (error) {
    if ((error as { code?: string }).code === "23505") {
      const again = await findVoiceNumberOwner(admin, phone);
      return again && again.company_id === port.company_id && again.organization_id === port.organization_id && again.mode === BUSINESS_LINE_MODE ? "already" : "taken";
    }
    throw error;
  }
  return "attached";
}

/** One completion pass. Returns the ids of ports completed in it. */
export async function sweepPortCompletions(admin: AdminClient, nowMs: number, deps: CompletionDeps = {}): Promise<string[]> {
  const db = admin as Db;
  const { data, error } = await db
    .from("number_port_requests")
    .select("*")
    .in("status", IN_FLIGHT)
    .order("updated_at", { ascending: true })
    .limit(PORTS_PER_PASS);
  if (error) throw error;
  const ports = (data ?? []) as NumberPortRow[];
  if (ports.length === 0) return [];
  const client = deps.client !== undefined ? deps.client : (deps.twilio ?? defaultTwilioClient)();
  const base = twilioWebhookBaseUrl();
  if (!client || !base) {
    console.error("[porting] completion check skipped: Twilio credentials or APP_BASE_URL missing.");
    return [];
  }

  const completed: string[] = [];
  for (const port of ports) {
    try {
      // No snapshot (submitted before snapshots existed) → we can't tell an arrival from a number
      // that was always ours: an operator attaches it by hand.
      if (!port.twilio_snapshot_at) {
        console.error(`[porting] port ${port.id} has no Twilio snapshot - not auto-attached.`);
        continue;
      }
      const preexisting = new Set(port.preexisting_numbers ?? []);
      const attached = new Set(port.attached_numbers ?? []);
      for (const phone of port.numbers) {
        if (attached.has(phone) || preexisting.has(phone)) continue;
        const [incoming] = await client.listIncoming({ phoneNumber: phone });
        if (!incoming) continue;
        const outcome = await attachBusinessLine(admin, port, incoming, client, base);
        if (outcome === "attached" || outcome === "already") attached.add(phone);
      }
      const nowIso = new Date(nowMs).toISOString();
      const allIn = port.numbers.length > 0 && port.numbers.every((n) => attached.has(n));
      const { error: saveError } = await db
        .from("number_port_requests")
        .update({ attached_numbers: [...attached], last_checked_at: nowIso })
        .eq("id", port.id)
        .eq("organization_id", port.organization_id)
        .eq("company_id", port.company_id);
      if (saveError) throw saveError;
      if (allIn) {
        await transitionPort(admin, { ...port, attached_numbers: [...attached] }, "completed", { completed_at: nowIso }, nowMs, deps);
        completed.push(port.id);
      }
    } catch (err) {
      console.error(`[porting] completion check for port ${port.id} failed:`, err instanceof Error ? err.message : err);
    }
  }
  return completed;
}

/** Owner texts still pending (held for quiet hours, or a failed send), oldest first. */
export async function sweepPortNotifications(admin: AdminClient, nowMs: number, deps: Partial<PortingDeps> = {}): Promise<void> {
  const { data, error } = await (admin as Db)
    .from("number_port_requests")
    .select("*")
    .not("notify_status", "is", null)
    .gte("updated_at", new Date(nowMs - 7 * 86_400_000).toISOString())
    .order("updated_at", { ascending: true })
    .limit(200);
  if (error) throw error;
  for (const port of (data ?? []) as NumberPortRow[]) {
    if (port.notify_status) await deliverOwnerText(admin, port, nowMs, deps);
  }
}

/** Cancel ports nobody finished, so their account details and bill get purged. */
export async function cancelAbandonedPorts(admin: AdminClient, nowMs: number, deps: Partial<PortingDeps> = {}): Promise<number> {
  const { data, error } = await (admin as Db)
    .from("number_port_requests")
    .select("*")
    .in("status", EDITABLE_STATUSES)
    .lte("updated_at", new Date(nowMs - ABANDON_AFTER_MS).toISOString())
    .limit(200);
  if (error) throw error;
  let cancelled = 0;
  for (const port of (data ?? []) as NumberPortRow[]) {
    try {
      await transitionPort(admin, port, "cancelled", { cancelled_at: new Date(nowMs).toISOString() }, nowMs, deps);
      cancelled += 1;
    } catch (err) {
      console.error(`[porting] auto-cancel of port ${port.id} failed:`, err instanceof Error ? err.message : err);
    }
  }
  return cancelled;
}

/**
 * Abandoned ports are cancelled; 14 days after a port completes or is cancelled the account
 * number, PIN and every bill file in its folder (replaced or abandoned uploads too) are deleted.
 */
export async function sweepPortPurge(admin: AdminClient, nowMs: number, deps: Partial<PortingDeps> = {}): Promise<number> {
  await cancelAbandonedPorts(admin, nowMs, deps);
  const db = admin as Db;
  const cutoff = new Date(nowMs - PURGE_AFTER_MS).toISOString();
  const { data, error } = await db
    .from("number_port_requests")
    .select("*")
    .in("status", ["completed", "cancelled"])
    .is("secrets_purged_at", null)
    .lte("updated_at", cutoff)
    .limit(200);
  if (error) throw error;
  const storage = (deps.storage ?? supabasePortingStorage)(admin);
  let purged = 0;
  for (const port of (data ?? []) as NumberPortRow[]) {
    const endedAt = port.completed_at ?? port.cancelled_at ?? port.updated_at ?? null;
    if (!endedAt || Date.parse(endedAt) > nowMs - PURGE_AFTER_MS) continue;
    try {
      const folder = portFolder(port.organization_id, port.id).replace(/\/$/, "");
      const bills = (await storage.listFolder(folder)).filter((p) => /\/bill-[^/]+$/.test(p));
      const all = [...new Set([...bills, ...(port.bill_path ? [port.bill_path] : [])])];
      if (all.length > 0) await storage.remove(all);
      const { error: updateError } = await db
        .from("number_port_requests")
        .update({ account_number_enc: null, pin_enc: null, bill_path: null, secrets_purged_at: new Date(nowMs).toISOString() })
        .eq("id", port.id)
        .eq("organization_id", port.organization_id)
        .eq("company_id", port.company_id)
        .is("secrets_purged_at", null);
      if (updateError) throw updateError;
      purged += 1;
    } catch (err) {
      console.error(`[porting] purge of port ${port.id} failed:`, err instanceof Error ? err.message : err);
    }
  }
  return purged;
}
