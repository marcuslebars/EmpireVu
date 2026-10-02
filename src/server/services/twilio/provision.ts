// ─────────────────────────────────────────────────────────────────────────────
// Missed-call catcher number provisioning (docs/missed-call-catcher.md). Buys a Twilio
// number (by area code) or attaches one already in the Twilio account, points its Voice +
// SMS webhooks at EmpireVu, and records it in voice_numbers (provider='twilio',
// mode='missed_call_catcher') for the company. Idempotent:
//   • a company that already has a catcher number gets its webhooks re-checked, not a
//     second number;
//   • a number bought for the company is tagged with a FriendlyName, so if the DB write
//     failed after the purchase, the next run finds and reuses it instead of buying again.
// Twilio REST calls sit behind an injectable client so tests never touch the real API.
// Runs under the caller's RLS client (admin-only route; voice_numbers admins-manage policy).
// ─────────────────────────────────────────────────────────────────────────────
import type { Tables } from "@/server/db/database.types";
import { buildForwardingInstructions, prettyPhone, type ForwardingInstructions } from "@/lib/carrier-forwarding";
import { ValidationError } from "@/server/organizations/context";
import { toE164 } from "@/server/services/retell/payload";
import { assertCompanyInOrganization, type TenantServiceContext } from "@/server/services/shared";
import { CATCHER_MODE } from "@/server/services/twilio/missed-call";
import {
  numberCountry,
  SMS_INBOUND_PATH,
  twilioWebhookBaseUrl,
  VOICE_INBOUND_PATH,
} from "@/server/services/twilio/voice-config";
import { installRecipes } from "@/server/services/workflow-engine/recipes/install";

const TWILIO_API = "https://api.twilio.com/2010-04-01";

export interface TwilioIncomingNumber {
  sid: string;
  phone_number: string;
  friendly_name?: string | null;
  voice_url?: string | null;
  sms_url?: string | null;
}

export interface TwilioAvailableNumber {
  phone_number: string;
  friendly_name?: string | null;
}

export interface TwilioNumbersClient {
  searchAvailableLocal(country: string, areaCode: number | null): Promise<TwilioAvailableNumber[]>;
  listIncoming(filter: { phoneNumber?: string; friendlyName?: string }): Promise<TwilioIncomingNumber[]>;
  purchase(input: { phoneNumber: string; friendlyName: string; voiceUrl: string; smsUrl: string }): Promise<TwilioIncomingNumber>;
  updateWebhooks(sid: string, input: { voiceUrl: string; smsUrl: string }): Promise<TwilioIncomingNumber>;
}

export function getTwilioCredentials(): { accountSid: string; authToken: string } | null {
  const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
  return accountSid && authToken ? { accountSid, authToken } : null;
}

/** Real fetch-backed client (Basic auth, form-encoded — same as outbound/sms.ts). */
export function createTwilioNumbersClient(creds: { accountSid: string; authToken: string }): TwilioNumbersClient {
  const auth = `Basic ${Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString("base64")}`;
  const account = `${TWILIO_API}/Accounts/${encodeURIComponent(creds.accountSid)}`;

  const call = async (method: "GET" | "POST", url: string, form?: Record<string, string>): Promise<unknown> => {
    const response = await fetch(url, {
      method,
      headers: { Authorization: auth, ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
      ...(form ? { body: new URLSearchParams(form).toString() } : {}),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Twilio ${method} ${url.replace(account, "")} failed (${response.status})${detail ? `: ${detail.slice(0, 300)}` : ""}`);
    }
    return response.json().catch(() => ({}));
  };

  const listOf = <T>(payload: unknown, key: string): T[] => {
    if (!payload || typeof payload !== "object") return [];
    const value = (payload as Record<string, unknown>)[key];
    return Array.isArray(value) ? (value as T[]) : [];
  };

  return {
    async searchAvailableLocal(country, areaCode) {
      const query = new URLSearchParams({ VoiceEnabled: "true", SmsEnabled: "true", PageSize: "5" });
      if (areaCode) query.set("AreaCode", String(areaCode));
      const payload = await call("GET", `${account}/AvailablePhoneNumbers/${encodeURIComponent(country)}/Local.json?${query}`);
      return listOf<TwilioAvailableNumber>(payload, "available_phone_numbers");
    },
    async listIncoming(filter) {
      const query = new URLSearchParams();
      if (filter.phoneNumber) query.set("PhoneNumber", filter.phoneNumber);
      if (filter.friendlyName) query.set("FriendlyName", filter.friendlyName);
      const payload = await call("GET", `${account}/IncomingPhoneNumbers.json?${query}`);
      return listOf<TwilioIncomingNumber>(payload, "incoming_phone_numbers");
    },
    async purchase(input) {
      return (await call("POST", `${account}/IncomingPhoneNumbers.json`, {
        PhoneNumber: input.phoneNumber,
        FriendlyName: input.friendlyName,
        VoiceUrl: input.voiceUrl,
        VoiceMethod: "POST",
        SmsUrl: input.smsUrl,
        SmsMethod: "POST",
      })) as TwilioIncomingNumber;
    },
    async updateWebhooks(sid, input) {
      return (await call("POST", `${account}/IncomingPhoneNumbers/${encodeURIComponent(sid)}.json`, {
        VoiceUrl: input.voiceUrl,
        VoiceMethod: "POST",
        SmsUrl: input.smsUrl,
        SmsMethod: "POST",
      })) as TwilioIncomingNumber;
    },
  };
}

/** FriendlyName tag on numbers we buy — the crash-safe idempotency key. */
export function catcherFriendlyName(companyId: string): string {
  return `EmpireVu catcher ${companyId}`;
}

export interface ProvisionCatcherInput {
  companyId: string;
  areaCode?: number | null;
  attachNumber?: string | null;
}

export interface ProvisionCatcherResult {
  phoneNumber: string;
  phoneNumberPretty: string;
  numberSid: string;
  purchased: boolean;
  webhooksUpdated: boolean;
  instructions: ForwardingInstructions;
}

type VoiceNumberRow = Tables<"voice_numbers">;

async function currentCatcherRow(context: TenantServiceContext, companyId: string): Promise<VoiceNumberRow | null> {
  const { data, error } = await context.supabase
    .from("voice_numbers")
    .select("*")
    .eq("organization_id", context.organizationId)
    .eq("company_id", companyId)
    .eq("provider", "twilio")
    .eq("mode", CATCHER_MODE)
    .eq("active", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as VoiceNumberRow | null) ?? null;
}

async function companyName(context: TenantServiceContext, companyId: string): Promise<string | null> {
  const { data } = await context.supabase
    .from("companies")
    .select("name")
    .eq("organization_id", context.organizationId)
    .eq("id", companyId)
    .maybeSingle();
  return (data as { name: string } | null)?.name ?? null;
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "23505");
}

async function saveCatcherRow(
  context: TenantServiceContext,
  companyId: string,
  number: TwilioIncomingNumber,
  brandLabel: string | null,
  previous: VoiceNumberRow | null,
): Promise<void> {
  const phone = toE164(number.phone_number) ?? number.phone_number;

  // A different number was the catcher before (re-provisioned) → retire the old row.
  if (previous && previous.phone_e164 !== phone) {
    const { error } = await context.supabase
      .from("voice_numbers")
      .update({ active: false })
      .eq("organization_id", context.organizationId)
      .eq("id", previous.id);
    if (error) throw error;
  }

  const { data: existing, error: readError } = await context.supabase
    .from("voice_numbers")
    .select("id")
    .eq("organization_id", context.organizationId)
    .eq("phone_e164", phone)
    .maybeSingle();
  if (readError) throw readError;

  const fields = {
    company_id: companyId,
    provider: "twilio",
    mode: CATCHER_MODE,
    provider_number_sid: number.sid,
    provider_agent_id: null,
    brand_label: brandLabel,
    active: true,
  };

  const existingId = (existing as { id: string } | null)?.id;
  if (existingId) {
    const { error } = await context.supabase
      .from("voice_numbers")
      .update(fields)
      .eq("organization_id", context.organizationId)
      .eq("id", existingId);
    if (error) throw error;
    return;
  }

  const { error } = await context.supabase
    .from("voice_numbers")
    .insert({ ...fields, organization_id: context.organizationId, phone_e164: phone });
  if (error) {
    if (isUniqueViolation(error)) {
      throw new ValidationError("That number is already connected to another EmpireVu account.");
    }
    throw error;
  }
}

/**
 * Buy or attach the company's catcher number and wire it up. Safe to call repeatedly.
 * Never touches the AI-receptionist (Retell) number — the two can coexist.
 */
export async function provisionMissedCallCatcher(
  context: TenantServiceContext,
  input: ProvisionCatcherInput,
  client?: TwilioNumbersClient,
): Promise<ProvisionCatcherResult> {
  await assertCompanyInOrganization(context, input.companyId);

  const creds = getTwilioCredentials();
  const twilio = client ?? (creds ? createTwilioNumbersClient(creds) : null);
  if (!twilio) {
    throw new ValidationError("Twilio is not configured. Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN on the server.");
  }
  const base = twilioWebhookBaseUrl();
  if (!base) {
    throw new ValidationError("Set APP_BASE_URL (or TWILIO_WEBHOOK_BASE_URL) so Twilio knows where to send calls.");
  }
  const voiceUrl = `${base}${VOICE_INBOUND_PATH}`;
  const smsUrl = `${base}${SMS_INBOUND_PATH}`;

  const previous = await currentCatcherRow(context, input.companyId);
  let number: TwilioIncomingNumber | null = null;
  let purchased = false;

  if (input.attachNumber?.trim()) {
    const wanted = toE164(input.attachNumber);
    if (!wanted) throw new ValidationError("Enter a valid phone number to attach.");
    [number = null] = await twilio.listIncoming({ phoneNumber: wanted });
    if (!number) throw new ValidationError(`${prettyPhone(wanted)} isn't in the Twilio account. Buy one instead, or check the number.`);
  } else if (previous) {
    [number = null] = await twilio.listIncoming({ phoneNumber: previous.phone_e164 });
  }

  if (!number) {
    // A number we bought for this company on an earlier run whose DB write never landed.
    [number = null] = await twilio.listIncoming({ friendlyName: catcherFriendlyName(input.companyId) });
  }

  if (!number) {
    const available = await twilio.searchAvailableLocal(numberCountry(), input.areaCode ?? null);
    const pick = available[0];
    if (!pick) {
      throw new ValidationError(
        input.areaCode
          ? `No numbers available in area code ${input.areaCode} right now. Try a nearby area code.`
          : "No numbers available right now. Try again with an area code.",
      );
    }
    number = await twilio.purchase({
      phoneNumber: pick.phone_number,
      friendlyName: catcherFriendlyName(input.companyId),
      voiceUrl,
      smsUrl,
    });
    purchased = true;
  }

  let webhooksUpdated = false;
  if (number.voice_url !== voiceUrl || number.sms_url !== smsUrl) {
    number = { ...number, ...(await twilio.updateWebhooks(number.sid, { voiceUrl, smsUrl })) };
    webhooksUpdated = true;
  }

  await saveCatcherRow(context, input.companyId, number, await companyName(context, input.companyId), previous);

  // The Catch plan's whole point: make sure the text-back automation exists (idempotent —
  // skipped when already installed; installs as draft if SMS isn't configured).
  try {
    await installRecipes(context, input.companyId, { only: ["missed-call-text-back"] });
  } catch (err) {
    console.error("[missed-call] recipe install failed:", err instanceof Error ? err.message : err);
  }

  const phoneNumber = toE164(number.phone_number) ?? number.phone_number;
  return {
    phoneNumber,
    phoneNumberPretty: prettyPhone(phoneNumber),
    numberSid: number.sid,
    purchased,
    webhooksUpdated,
    instructions: buildForwardingInstructions(phoneNumber),
  };
}

export interface CatcherStatus {
  configured: boolean;
  number: { id: string; phoneNumber: string; phoneNumberPretty: string; createdAt: string } | null;
  instructions: ForwardingInstructions | null;
}

export async function getMissedCallCatcherStatus(context: TenantServiceContext, companyId: string): Promise<CatcherStatus> {
  const row = await currentCatcherRow(context, companyId);
  return {
    configured: Boolean(getTwilioCredentials() && twilioWebhookBaseUrl()),
    number: row
      ? { id: row.id, phoneNumber: row.phone_e164, phoneNumberPretty: prettyPhone(row.phone_e164), createdAt: row.created_at }
      : null,
    instructions: row ? buildForwardingInstructions(row.phone_e164) : null,
  };
}
