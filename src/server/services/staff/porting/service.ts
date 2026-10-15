/**
 * SANCTIONED EXCEPTION (service role): Keep your number (docs/ai-staff.md → "Keep your number").
 *
 * Twilio takes Canadian local-number port-ins only through its web form, so everything around
 * that one operator step is automated here:
 *   • startPort           — the owner starts (Settings, or "keep my number" by text): one open
 *                           request per company, a /port/:token link texted to the owner;
 *   • the /port/:token page (getPortView / createBillUpload / submitPortForm) — the token is the
 *                           credential and reaches only its own request;
 *   • operator steps      — markSubmitted / setFocDate / markRejected / cancelPort / revealSecrets
 *                           (concierge actions, audited in operator_actions);
 *   • owner texts         — one per status change, from the platform number (deliverOwnerText).
 * Every write is filtered by organization_id + company_id (or the token's row). The account number
 * and PIN are only ever written encrypted (crypto.ts) and never logged, texted or summarised.
 */
import { isDoneForYou } from "@/lib/product-line";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

import { prettyPhone } from "@/lib/carrier-forwarding";
import { ValidationError } from "@/server/organizations/context";
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { isQuietHours, sendOwnerSms } from "@/server/services/owner-channel/common";
import { appBaseUrlFor } from "@/server/services/platform-brand";
import { toE164 } from "@/server/services/retell/payload";
import { decryptSecret, encryptSecret, lastFour, portingKey } from "@/server/services/staff/porting/crypto";
import type { Db, NumberPortRow, PinStatus, PortStatus, ServiceAddress } from "@/server/services/staff/porting/db-types";
import { checkPortable, portableMessage } from "@/server/services/staff/porting/guards";
import { buildLoaPdf } from "@/server/services/staff/porting/loa";
import { loadPortingCompany, type PortingCompany } from "@/server/services/staff/porting/settings";
import {
  canTransition,
  EDITABLE_STATUSES,
  IN_FLIGHT,
  OPEN_STATUSES,
  OWNER_CANCELLABLE,
  ownerStatusText,
  STATUS_LABELS,
} from "@/server/services/staff/porting/status";
import { BILL_TYPES, billPathFor, isPortPath, loaPathFor, supabasePortingStorage, type PortingStorage } from "@/server/services/staff/porting/storage";
import { createTwilioNumbersClient, getTwilioCredentials, type TwilioNumbersClient } from "@/server/services/twilio/provision";
import { readCallAnsweringSettings } from "@/server/services/voice/answering-settings";

export type Scope = { organizationId: string; companyId: string };

export interface PortingDeps {
  storage: (admin: AdminClient) => PortingStorage;
  sendOwner: typeof sendOwnerSms;
  /** The Twilio numbers client (snapshot at submit, completion sweep); null when not configured. */
  twilio: () => TwilioNumbersClient | null;
}

export function defaultTwilioClient(): TwilioNumbersClient | null {
  const creds = getTwilioCredentials();
  return creds ? createTwilioNumbersClient(creds) : null;
}

export function defaultPortingDeps(): PortingDeps {
  return { storage: supabasePortingStorage, sendOwner: sendOwnerSms, twilio: defaultTwilioClient };
}

function depsWith(over?: Partial<PortingDeps>): PortingDeps {
  return { ...defaultPortingDeps(), ...(over ?? {}) };
}

// ── Tokens + links ───────────────────────────────────────────────────────────

export function newPortToken(): string {
  return randomBytes(24).toString("base64url");
}

export function isPortToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{32,64}$/.test(value);
}

export function portLinkFor(platformBrand: string | null, token: string): string {
  return `${appBaseUrlFor(isDoneForYou(platformBrand) ? "crankleads" : "empirevu")}/port/${token}`;
}

/** NANP numbers only (Twilio's US/Canada port-in). */
export function normalizePortNumber(raw: string | null | undefined): string | null {
  const e164 = toE164(raw ?? null);
  return e164 && /^\+1[2-9]\d{2}[2-9]\d{6}$/.test(e164) ? e164 : null;
}

// ── Reads ────────────────────────────────────────────────────────────────────

export async function loadOpenPort(admin: AdminClient, scope: Scope): Promise<NumberPortRow | null> {
  const { data, error } = await (admin as Db)
    .from("number_port_requests")
    .select("*")
    .eq("organization_id", scope.organizationId)
    .eq("company_id", scope.companyId)
    .in("status", OPEN_STATUSES)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  return ((data ?? []) as NumberPortRow[])[0] ?? null;
}

/** The newest request of the company, open or not. */
export async function loadLatestPort(admin: AdminClient, scope: Scope): Promise<NumberPortRow | null> {
  const { data, error } = await (admin as Db)
    .from("number_port_requests")
    .select("*")
    .eq("organization_id", scope.organizationId)
    .eq("company_id", scope.companyId)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  return ((data ?? []) as NumberPortRow[])[0] ?? null;
}

export async function loadPortById(admin: AdminClient, scope: Scope, portId: string): Promise<NumberPortRow | null> {
  const { data, error } = await (admin as Db)
    .from("number_port_requests")
    .select("*")
    .eq("organization_id", scope.organizationId)
    .eq("company_id", scope.companyId)
    .eq("id", portId)
    .maybeSingle();
  if (error) throw error;
  return (data as NumberPortRow | null) ?? null;
}

async function loadPortByToken(admin: AdminClient, token: string): Promise<NumberPortRow | null> {
  if (!isPortToken(token)) return null;
  const { data, error } = await (admin as Db).from("number_port_requests").select("*").eq("token", token).maybeSingle();
  if (error) throw error;
  return (data as NumberPortRow | null) ?? null;
}

// ── Owner texts ──────────────────────────────────────────────────────────────

/** A new "status@time" key: every transition owes the owner exactly one text. */
export function notifyKey(status: PortStatus, nowMs: number): string {
  return `${status}@${new Date(nowMs).toISOString()}`;
}

function statusOfKey(key: string | null): PortStatus | null {
  const status = key?.split("@")[0] ?? null;
  return status && (STATUS_LABELS as Record<string, string>)[status] ? (status as PortStatus) : null;
}

/** Texts that can't wait for the morning: the carrier's approval text has a 90-minute window. */
const URGENT: PortStatus[] = ["submitted", "foc_scheduled"];

/**
 * Send the owner the text this port owes them (if any): claimed by a conditional update on
 * notified_status, so overlapping workers never double-text. Quiet hours (21:00–08:00 local)
 * hold everything but the carrier-approval warnings; the notify sweep sends the rest later.
 * Returns what happened. Never throws.
 */
export async function deliverOwnerText(
  admin: AdminClient,
  port: NumberPortRow,
  nowMs: number,
  over?: Partial<PortingDeps>,
): Promise<"sent" | "none" | "held" | "no_phone" | "lost_claim" | "failed"> {
  try {
    const key = port.notify_status;
    const status = statusOfKey(key);
    if (!key || !status) return "none";
    // Done with this text (sent, or it can never be sent): clear it so the notify sweep only ever
    // sees pending ones. Conditional on the key, so a newer status's text is never cleared.
    const clear = async () => {
      await (admin as Db).from("number_port_requests").update({ notify_status: null }).eq("id", port.id).eq("organization_id", port.organization_id).eq("notify_status", key);
    };
    if (key === port.notified_status) {
      await clear();
      return "none";
    }
    const company = await loadPortingCompany(admin, { organizationId: port.organization_id, companyId: port.company_id });
    if (!company?.ownerPhone || !company.ownerPhoneVerified) {
      await clear();
      return "no_phone";
    }
    if (!URGENT.includes(status) && isQuietHours(nowMs, company.timeZone)) return "held";
    const text = ownerStatusText(port, status, ownerTextContext(company, port));
    let claim = (admin as Db)
      .from("number_port_requests")
      .update({ notified_status: key })
      .eq("id", port.id)
      .eq("organization_id", port.organization_id)
      .eq("notify_status", key);
    claim = port.notified_status ? claim.eq("notified_status", port.notified_status) : claim.is("notified_status", null);
    const { data: claimed } = await claim.select("id");
    if (((claimed ?? []) as unknown[]).length === 0) return "lost_claim";
    if (!text) {
      await clear();
      return "none";
    }
    const deps = depsWith(over);
    const result = await deps.sendOwner(admin, {
      to: company.ownerPhone,
      body: text,
      organizationId: port.organization_id,
      companyId: port.company_id,
      platformBrand: company.platformBrand,
    });
    if (result.status === "failed") {
      // Give the claim back so the notify sweep tries again.
      await (admin as Db)
        .from("number_port_requests")
        .update({ notified_status: port.notified_status })
        .eq("id", port.id)
        .eq("organization_id", port.organization_id)
        .eq("notified_status", key);
      return "failed";
    }
    // Sent, or blocked (the owner opted out of platform texts - retrying won't help).
    await clear();
    return result.status === "sent" ? "sent" : "failed";
  } catch (err) {
    console.error("[porting] owner text failed:", err instanceof Error ? err.message : err);
    return "failed";
  }
}

export function ownerTextContext(company: PortingCompany, port: Pick<NumberPortRow, "token">) {
  return {
    link: portLinkFor(company.platformBrand, port.token),
    ringEnabled: company.settings.ring.enabled,
    ringSeconds: company.settings.ring.seconds,
    answering: readCallAnsweringSettings(company.aiSettings, { doneForYou: isDoneForYou(company.platformBrand) }).mode,
  };
}

// ── Start ────────────────────────────────────────────────────────────────────

export interface StartPortResult {
  port: NumberPortRow;
  url: string;
  created: boolean;
  /** The owner was texted the link (settings / operator starts). */
  texted: boolean;
}

/**
 * Start (or pick up) the company's port request. One open request per company: asking again
 * returns the same link. `createdVia: "owner_text"` doesn't text the link separately (the owner
 * agent's reply carries it).
 */
export async function startPort(
  admin: AdminClient,
  scope: Scope,
  input: { createdVia: NumberPortRow["created_via"]; number?: string | null; nowMs?: number },
  over?: Partial<PortingDeps>,
): Promise<StartPortResult> {
  const nowMs = input.nowMs ?? Date.now();
  const company = await loadPortingCompany(admin, scope);
  if (!company) throw new ValidationError("Company not found.");
  if (!company.settings.enabled && input.createdVia !== "operator") {
    throw new ValidationError("Keeping your number isn't switched on for this business (Settings → AI front desk → Keep your number).");
  }
  const existing = await loadOpenPort(admin, scope);
  if (existing) {
    const url = portLinkFor(company.platformBrand, existing.token);
    return { port: existing, url, created: false, texted: false };
  }

  // Never a number that's already ours (the platform line, a catcher, another company's line).
  const asked = normalizePortNumber(input.number ?? null);
  if (asked) {
    const verdict = await checkPortable(admin, scope, asked);
    if (verdict.reason) throw new ValidationError(portableMessage(verdict.reason));
  }
  const line = normalizePortNumber(company.businessLine);
  const wanted = asked ?? (line && (await checkPortable(admin, scope, line)).ok ? line : null);
  const sendText = input.createdVia !== "owner_text";
  const nowIso = new Date(nowMs).toISOString();
  const key = notifyKey("collecting", nowMs);
  const row = {
    organization_id: scope.organizationId,
    company_id: scope.companyId,
    token: newPortToken(),
    status: "collecting",
    numbers: wanted ? [wanted] : [],
    carrier: company.businessPhoneCarrier,
    business_name: company.name,
    pin_status: "none",
    attached_numbers: [],
    created_via: input.createdVia,
    // The owner agent's reply IS the text with the link (nothing owed then).
    notify_status: sendText ? key : null,
    notified_status: sendText ? null : key,
    created_at: nowIso,
    updated_at: nowIso,
  };
  const { data, error } = await (admin as Db).from("number_port_requests").insert(row).select("*").single();
  if (error) {
    // Two starts at once: the other one won (one open request per company).
    if ((error as { code?: string }).code === "23505") {
      const raced = await loadOpenPort(admin, scope);
      if (raced) return { port: raced, url: portLinkFor(company.platformBrand, raced.token), created: false, texted: false };
    }
    throw error;
  }
  const port = data as NumberPortRow;
  const texted = sendText ? (await deliverOwnerText(admin, port, nowMs, over)) === "sent" : false;
  return { port, url: portLinkFor(company.platformBrand, port.token), created: true, texted };
}

// ── The owner's form (/port/:token) ──────────────────────────────────────────

export interface PortFormView {
  businessName: string;
  status: PortStatus;
  statusLabel: string;
  editable: boolean;
  /** PORTING_ENCRYPTION_KEY set → the account number and PIN are collected here; else we call. */
  collectsAccountDetails: boolean;
  numbers: string[];
  businessLine: string | null;
  businessLineIsCell: boolean;
  carrier: string | null;
  authorizedName: string | null;
  formBusinessName: string | null;
  serviceAddress: ServiceAddress | null;
  accountOnFile: string | null;
  pinStatus: PinStatus;
  billOnFile: boolean;
  billUploadedAt: string | null;
  loaSignedAt: string | null;
  loaSignedName: string | null;
  focDate: string | null;
  rejectionReason: string | null;
}

/**
 * The owner may change the form while it's collecting / ready / rejected — but not once an
 * operator has started on it (revealed, downloaded or copied the details for Twilio's form), so
 * what goes to the carrier is what was signed. A rejection reopens it (operator_opened_at reset).
 */
export function ownerCanEdit(port: Pick<NumberPortRow, "status" | "operator_opened_at">): boolean {
  return EDITABLE_STATUSES.includes(port.status) && !port.operator_opened_at;
}

const LOCKED_MESSAGE = "We've started sending this to your carrier, so it can't be changed here. Reply to our text if something's wrong.";

function formView(port: NumberPortRow, company: PortingCompany): PortFormView {
  const editable = ownerCanEdit(port);
  return {
    businessName: company.name,
    status: port.status,
    statusLabel: STATUS_LABELS[port.status],
    editable,
    collectsAccountDetails: portingKey() !== null,
    numbers: port.numbers,
    businessLine: normalizePortNumber(company.businessLine),
    businessLineIsCell: company.businessPhoneKind === "cell",
    carrier: port.carrier,
    // Once it's with the carrier the link shows only the status (nothing personal).
    authorizedName: editable ? port.authorized_name : null,
    formBusinessName: editable ? port.business_name : null,
    serviceAddress: editable ? port.service_address : null,
    accountOnFile: port.account_number_last4 && port.account_number_enc ? `ending ${port.account_number_last4}` : null,
    pinStatus: port.pin_status,
    billOnFile: Boolean(port.bill_path),
    billUploadedAt: port.bill_uploaded_at,
    loaSignedAt: port.loa_signed_at,
    loaSignedName: port.loa_signed_name,
    focDate: port.foc_date,
    rejectionReason: port.status === "rejected" ? port.rejection_reason : null,
  };
}

/** A finished request's link stops working this long after it ended. */
const LINK_AFTER_END_MS = 30 * 86_400_000;

export async function getPortView(admin: AdminClient, token: string, nowMs: number = Date.now()): Promise<PortFormView | null> {
  const port = await loadPortByToken(admin, token);
  if (!port) return null;
  const endedAt = port.completed_at ?? port.cancelled_at;
  if (endedAt && Date.parse(endedAt) < nowMs - LINK_AFTER_END_MS) return null;
  const company = await loadPortingCompany(admin, { organizationId: port.organization_id, companyId: port.company_id });
  if (!company) return null;
  return formView(port, company);
}

export async function createBillUpload(
  admin: AdminClient,
  token: string,
  contentType: string,
  over?: Partial<PortingDeps>,
): Promise<{ path: string; token: string; bucket: string } | null> {
  const port = await loadPortByToken(admin, token);
  if (!port) return null;
  if (!ownerCanEdit(port)) throw new ValidationError(LOCKED_MESSAGE);
  const path = billPathFor(port.organization_id, port.id, contentType);
  if (!path) throw new ValidationError("Upload a photo (JPG, PNG, HEIC) or a PDF of the bill.");
  const upload = await depsWith(over).storage(admin).createUploadUrl(path);
  return { path: upload.path, token: upload.token, bucket: "porting-docs" };
}

/** PO boxes can't be a service address (the carrier's records hold where the line is). */
export function isPoBox(value: string | null | undefined): boolean {
  if (!value) return false;
  return /\b(p\.?\s*o\.?\s*box|post\s*office\s*box|postal\s*box|p\.?\s*o\.?\s*b\b|case\s+postale|c\.?\s*p\.?\s+\d+|box\s+\d+|rr\s*\d+\s+box)\b/i.test(value) || /^\s*box\b/i.test(value);
}

const POSTAL_CA = /^[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d$/;
const ZIP_US = /^\d{5}(-\d{4})?$/;

const trimmed = (max: number, min = 1) => z.string().trim().min(min).max(max);

export const portFormSchema = z
  .object({
    numbers: z.array(z.string().max(40)).min(1).max(5),
    carrier: trimmed(80),
    businessName: trimmed(120),
    authorizedName: trimmed(120, 2),
    serviceAddress: z
      .object({
        line1: trimmed(120),
        line2: z.string().trim().max(120).nullable().optional(),
        city: trimmed(80),
        province: trimmed(40, 2),
        postalCode: trimmed(12),
        country: z.enum(["CA", "US"]).default("CA"),
      })
      .strict(),
    accountNumber: z.string().trim().max(40).optional().nullable(),
    pin: z.string().trim().max(20).optional().nullable(),
    noPin: z.boolean().optional(),
    billPath: z.string().max(300).optional().nullable(),
    billContentType: z.string().max(60).optional().nullable(),
    billIsRecent: z.literal(true, { errorMap: () => ({ message: "Confirm the bill is from the last 30 days." }) }),
    signature: z.object({ typedName: trimmed(120, 2), agree: z.literal(true, { errorMap: () => ({ message: "Tick the box to sign." }) }) }).strict(),
  })
  .strict();

export type PortFormInput = z.input<typeof portFormSchema>;

function sameName(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return norm(a) === norm(b);
}

/**
 * The owner's answers + typed signature → encrypted account details, the signed LOA PDF, and the
 * request moves to `ready` (from collecting, ready (re-signed) or rejected). Returns the new view,
 * or null for an unknown token.
 */
export async function submitPortForm(
  admin: AdminClient,
  token: string,
  body: unknown,
  meta: { ip: string | null; userAgent: string | null; nowMs?: number },
  over?: Partial<PortingDeps>,
): Promise<PortFormView | null> {
  const nowMs = meta.nowMs ?? Date.now();
  const deps = depsWith(over);
  const port = await loadPortByToken(admin, token);
  if (!port) return null;
  const company = await loadPortingCompany(admin, { organizationId: port.organization_id, companyId: port.company_id });
  if (!company) return null;
  if (!ownerCanEdit(port)) throw new ValidationError(LOCKED_MESSAGE);

  const parsed = portFormSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ValidationError(issue?.message && !/^(Required|Invalid)/.test(issue.message) ? issue.message : "Something in the form didn't look right - check it and try again.");
  }
  const input = parsed.data;

  const numbers = [...new Set(input.numbers.map((n) => normalizePortNumber(n)))];
  if (numbers.some((n) => !n)) throw new ValidationError("Enter each number as a 10-digit Canadian or US phone number.");
  for (const n of numbers as string[]) {
    const verdict = await checkPortable(admin, { organizationId: port.organization_id, companyId: port.company_id }, n);
    if (verdict.reason) throw new ValidationError(portableMessage(verdict.reason));
  }
  const address: ServiceAddress = {
    line1: input.serviceAddress.line1,
    line2: input.serviceAddress.line2?.trim() || null,
    city: input.serviceAddress.city,
    province: input.serviceAddress.province,
    postalCode: input.serviceAddress.postalCode.toUpperCase(),
    country: input.serviceAddress.country,
  };
  if (isPoBox(address.line1) || isPoBox(address.line2)) {
    throw new ValidationError("The service address must be where the phone line is, not a PO box. Use the street address on your bill.");
  }
  if (address.country === "CA" ? !POSTAL_CA.test(address.postalCode) : !ZIP_US.test(address.postalCode)) {
    throw new ValidationError(address.country === "CA" ? "Enter the postal code like L4R 1A1." : "Enter the ZIP code like 49503.");
  }
  if (!sameName(input.signature.typedName, input.authorizedName)) {
    throw new ValidationError("Type the authorized person's name exactly to sign.");
  }

  // Account number + PIN: encrypted, or not collected at all (no key → we call for them).
  const key = portingKey();
  const patch: Record<string, unknown> = {};
  if (key) {
    const account = input.accountNumber?.replace(/\s+/g, "") ?? "";
    if (account) {
      if (!/^[A-Za-z0-9-]{3,40}$/.test(account)) throw new ValidationError("The account number should be letters and numbers only - copy it from your bill.");
      patch.account_number_enc = encryptSecret(account, port.id, key);
      patch.account_number_last4 = lastFour(account);
    } else if (!port.account_number_enc) {
      throw new ValidationError("Enter the account number from your phone bill.");
    }
    const pin = input.pin?.trim() ?? "";
    if (pin) {
      if (!/^[A-Za-z0-9]{1,20}$/.test(pin)) throw new ValidationError("The PIN should be letters and numbers only.");
      patch.pin_enc = encryptSecret(pin, port.id, key);
      patch.pin_status = "stored";
    } else if (input.noPin || !port.pin_enc) {
      patch.pin_enc = null;
      patch.pin_status = "none";
    }
  } else {
    patch.account_number_enc = null;
    patch.account_number_last4 = null;
    patch.pin_enc = null;
    patch.pin_status = "call";
  }

  // The bill: a fresh upload into this request's folder, or the one already on file.
  const storage = deps.storage(admin);
  if (input.billPath) {
    if (!isPortPath(port.organization_id, port.id, input.billPath) || !/\/bill-[^/]+$/.test(input.billPath)) {
      throw new ValidationError("Upload the bill again.");
    }
    if (!(await storage.exists(input.billPath))) throw new ValidationError("The bill didn't finish uploading - try again.");
    const type = input.billContentType && BILL_TYPES[input.billContentType] ? input.billContentType : null;
    patch.bill_path = input.billPath;
    patch.bill_content_type = type;
    patch.bill_uploaded_at = new Date(nowMs).toISOString();
  } else if (!port.bill_path) {
    throw new ValidationError("Add a photo or PDF of a recent phone bill.");
  }

  // The signed LOA.
  const signedAtIso = new Date(nowMs).toISOString();
  const pdf = await buildLoaPdf({
    businessName: input.businessName,
    authorizedName: input.authorizedName,
    serviceAddress: address,
    carrier: input.carrier,
    numbers: numbers as string[],
    signedName: input.signature.typedName,
    signedAtIso,
    signedIp: meta.ip,
    signedUserAgent: meta.userAgent?.slice(0, 300) ?? null,
    timeZone: company.timeZone,
  });
  const loaPath = loaPathFor(port.organization_id, port.id, nowMs);
  await storage.upload(loaPath, pdf, "application/pdf");

  const next: PortStatus = "ready";
  const statusChanged = port.status !== next;
  const update = {
    ...patch,
    numbers,
    carrier: input.carrier,
    business_name: input.businessName,
    authorized_name: input.authorizedName,
    service_address: address,
    loa_path: loaPath,
    loa_sha256: createHash("sha256").update(pdf).digest("hex"),
    loa_signed_at: signedAtIso,
    loa_signed_name: input.signature.typedName,
    loa_signed_ip: meta.ip,
    loa_signed_user_agent: meta.userAgent?.slice(0, 300) ?? null,
    status: next,
    ready_at: signedAtIso,
    ...(statusChanged ? { notify_status: notifyKey(next, nowMs) } : {}),
    updated_at: signedAtIso,
  };
  const { data, error } = await (admin as Db)
    .from("number_port_requests")
    .update(update)
    .eq("id", port.id)
    .eq("organization_id", port.organization_id)
    .eq("company_id", port.company_id)
    .eq("status", port.status)
    .is("operator_opened_at", null)
    .select("*");
  if (error) throw error;
  const saved = ((data ?? []) as NumberPortRow[])[0];
  if (!saved) throw new ValidationError("This request just changed - reload the page.");
  // A replaced bill is deleted (best effort; the purge sweeps the folder anyway).
  if (input.billPath && port.bill_path && port.bill_path !== input.billPath) {
    try {
      await storage.remove([port.bill_path]);
    } catch (err) {
      console.error("[porting] could not delete the replaced bill:", err instanceof Error ? err.message : err);
    }
  }
  if (statusChanged) await deliverOwnerText(admin, saved, nowMs, over);
  return formView(saved, company);
}

// ── Status changes (operator, owner cancel, completion) ──────────────────────

/**
 * Move a port to `to` (conditional on its current status, so two operators can't both win),
 * owe the owner a text, and try to send it now. Returns the saved row.
 */
export async function transitionPort(
  admin: AdminClient,
  port: NumberPortRow,
  to: PortStatus,
  patch: Record<string, unknown>,
  nowMs: number,
  over?: Partial<PortingDeps>,
): Promise<NumberPortRow> {
  if (!canTransition(port.status, to)) {
    throw new ValidationError(`Can't go from "${STATUS_LABELS[port.status]}" to "${STATUS_LABELS[to]}".`);
  }
  const nowIso = new Date(nowMs).toISOString();
  const { data, error } = await (admin as Db)
    .from("number_port_requests")
    .update({ ...patch, status: to, notify_status: notifyKey(to, nowMs), updated_at: nowIso })
    .eq("id", port.id)
    .eq("organization_id", port.organization_id)
    .eq("company_id", port.company_id)
    .eq("status", port.status)
    .select("*");
  if (error) throw error;
  const saved = ((data ?? []) as NumberPortRow[])[0];
  if (!saved) throw new ValidationError("This port just changed - refresh and try again.");
  await deliverOwnerText(admin, saved, nowMs, over);
  return saved;
}

async function requirePort(admin: AdminClient, scope: Scope, portId: string): Promise<NumberPortRow> {
  const port = await loadPortById(admin, scope, portId);
  if (!port) throw new ValidationError("That port request isn't on this account.");
  return port;
}

export async function markSubmitted(admin: AdminClient, scope: Scope, portId: string, input: { twilioRequestId: string; nowMs?: number }, over?: Partial<PortingDeps>): Promise<NumberPortRow> {
  const nowMs = input.nowMs ?? Date.now();
  const port = await requirePort(admin, scope, portId);
  if (port.status !== "ready") throw new ValidationError(`Only a ready port can be submitted (this one is "${STATUS_LABELS[port.status]}").`);
  // Snapshot the Twilio account: a number already there now is never auto-attached later (only a
  // number that ARRIVES is the ported one — never the platform line or another tenant's number).
  const client = depsWith(over).twilio();
  if (!client) throw new ValidationError("Twilio isn't configured on the server (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN), so the port can't be tracked.");
  const preexisting: string[] = [];
  try {
    for (const phone of port.numbers) {
      const found = await client.listIncoming({ phoneNumber: phone });
      if (found.length > 0) preexisting.push(phone);
    }
  } catch {
    throw new ValidationError("Couldn't check the Twilio account - try again.");
  }
  const nowIso = new Date(nowMs).toISOString();
  return transitionPort(
    admin,
    port,
    "submitted",
    { twilio_port_request_id: input.twilioRequestId, submitted_at: nowIso, rejection_reason: null, twilio_snapshot_at: nowIso, preexisting_numbers: preexisting, operator_opened_at: port.operator_opened_at ?? nowIso },
    nowMs,
    over,
  );
}

export async function setFocDate(admin: AdminClient, scope: Scope, portId: string, input: { focDate: string; nowMs?: number }, over?: Partial<PortingDeps>): Promise<NumberPortRow> {
  const nowMs = input.nowMs ?? Date.now();
  const port = await requirePort(admin, scope, portId);
  if (!IN_FLIGHT.includes(port.status)) throw new ValidationError("Set the move date after the port is submitted.");
  if (port.status === "foc_scheduled" && port.foc_date === input.focDate) return port;
  return transitionPort(admin, port, "foc_scheduled", { foc_date: input.focDate, foc_set_at: new Date(nowMs).toISOString() }, nowMs, over);
}

export async function markRejected(admin: AdminClient, scope: Scope, portId: string, input: { reason: string; nowMs?: number }, over?: Partial<PortingDeps>): Promise<NumberPortRow> {
  const nowMs = input.nowMs ?? Date.now();
  const port = await requirePort(admin, scope, portId);
  // The owner can fix the form again (operator_opened_at reset).
  return transitionPort(admin, port, "rejected", { rejection_reason: input.reason.trim().slice(0, 300), rejected_at: new Date(nowMs).toISOString(), operator_opened_at: null }, nowMs, over);
}

/**
 * An operator started working the port (revealed, downloaded or copied the details): the owner's
 * form locks, so what goes into Twilio's form is what was signed. Idempotent.
 */
export async function markOperatorOpened(admin: AdminClient, scope: Scope, portId: string, nowMs: number = Date.now()): Promise<void> {
  const { error } = await (admin as Db)
    .from("number_port_requests")
    .update({ operator_opened_at: new Date(nowMs).toISOString() })
    .eq("id", portId)
    .eq("organization_id", scope.organizationId)
    .eq("company_id", scope.companyId)
    .is("operator_opened_at", null)
    .in("status", ["collecting", "ready"]);
  if (error) throw error;
}

export async function cancelPort(
  admin: AdminClient,
  scope: Scope,
  portId: string,
  input: { by: "owner" | "operator"; nowMs?: number },
  over?: Partial<PortingDeps>,
): Promise<NumberPortRow> {
  const nowMs = input.nowMs ?? Date.now();
  const port = await requirePort(admin, scope, portId);
  if (input.by === "owner" && !OWNER_CANCELLABLE.includes(port.status)) {
    throw new ValidationError("It's already with the carrier - reply to our text or contact support to stop it.");
  }
  return transitionPort(admin, port, "cancelled", { cancelled_at: new Date(nowMs).toISOString() }, nowMs, over);
}

/**
 * The operator's PIN reveal (concierge action, audited by the caller): the decrypted account
 * number and PIN. Never logged here; the audit row records only THAT it was revealed.
 */
export async function revealSecrets(admin: AdminClient, scope: Scope, portId: string): Promise<{ accountNumber: string | null; pin: string | null; pinStatus: PinStatus }> {
  const port = await requirePort(admin, scope, portId);
  if (port.secrets_purged_at) throw new ValidationError("The account number and PIN were purged (14 days after the port finished).");
  if (port.pin_status === "call" && !port.account_number_enc) {
    return { accountNumber: null, pin: null, pinStatus: "call" };
  }
  const key = portingKey();
  if (!key) throw new ValidationError("PORTING_ENCRYPTION_KEY isn't set on the server, so the stored details can't be read.");
  const accountNumber = decryptSecret(port.account_number_enc, port.id, key);
  const pin = port.pin_status === "stored" ? decryptSecret(port.pin_enc, port.id, key) : null;
  if (port.account_number_enc && accountNumber === null) throw new ValidationError("The stored details couldn't be decrypted (was the key changed?). Call the owner for them.");
  return { accountNumber, pin, pinStatus: port.pin_status };
}

// ── Owner-facing summary (owner tool, Settings) ──────────────────────────────

export interface PortSummary {
  id: string;
  status: PortStatus;
  statusLabel: string;
  numbers: string[];
  numbersPretty: string[];
  carrier: string | null;
  focDate: string | null;
  rejectionReason: string | null;
  url: string | null;
  createdAt: string;
  completedAt: string | null;
  cancelledAt: string | null;
}

export function portSummary(port: NumberPortRow, platformBrand: string | null): PortSummary {
  const open = OPEN_STATUSES.includes(port.status);
  return {
    id: port.id,
    status: port.status,
    statusLabel: STATUS_LABELS[port.status],
    numbers: port.numbers,
    numbersPretty: port.numbers.map((n) => prettyPhone(n)),
    carrier: port.carrier,
    focDate: port.foc_date,
    rejectionReason: port.status === "rejected" ? port.rejection_reason : null,
    url: open ? portLinkFor(platformBrand, port.token) : null,
    createdAt: port.created_at,
    completedAt: port.completed_at,
    cancelledAt: port.cancelled_at,
  };
}
