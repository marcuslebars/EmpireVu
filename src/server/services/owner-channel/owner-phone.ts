/**
 * The owner's cell (companies.owner_phone_e164) is the owner channel's identity: a text from it
 * can approve AI actions and run commands. So it can't be set by just any org member
 * (20261009160000_front_desk_hardening revokes the column grant) and the owner channel only
 * acts for a VERIFIED number (companies.owner_phone_verified_at):
 *
 *   • provisioning (CrankLeads checkout / done-for-you intake from the paying buyer, an
 *     operator in the concierge) sets the number already verified — setOwnerPhoneVerified;
 *   • any later change goes through an owner/admin server route and a 6-digit code texted to
 *     the new number — startOwnerPhoneVerification → confirmOwnerPhoneVerification;
 *   • a DB trigger clears owner_phone_verified_at whenever the number changes without the
 *     same update re-verifying it.
 */
import { createHash, randomInt, timingSafeEqual } from "node:crypto";

import { toE164 } from "@/server/services/retell/payload";
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { consumeLimit, sendOwnerSms } from "./common";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

export const OWNER_PHONE_CODE_TTL_MS = 10 * 60_000;
export const OWNER_PHONE_MAX_ATTEMPTS = 5;
const STARTS_PER_HOUR = 5;

export function normalizeOwnerPhone(raw: string | null | undefined): string | null {
  const e164 = toE164(raw ?? null);
  return e164 && /^\+\d{10,15}$/.test(e164) ? e164 : null;
}

function hashCode(id: string, code: string): string {
  return createHash("sha256").update(`${id}:${code}`).digest("hex");
}

export interface OwnerPhoneView {
  phone: string | null;
  verified: boolean;
  verifiedAt: string | null;
  /** A code was sent to this number and is waiting to be entered. */
  pendingPhone: string | null;
  pendingExpiresAt: string | null;
}

export async function getOwnerPhoneView(admin: AdminClient, organizationId: string, companyId: string, nowMs = Date.now()): Promise<OwnerPhoneView> {
  const db = admin as Db;
  const { data: company } = await db
    .from("companies")
    .select("owner_phone_e164, owner_phone_verified_at")
    .eq("organization_id", organizationId)
    .eq("id", companyId)
    .maybeSingle();
  const row = company as { owner_phone_e164: string | null; owner_phone_verified_at: string | null } | null;
  const { data: pending } = await db
    .from("owner_phone_verifications")
    .select("phone_e164, expires_at")
    .eq("organization_id", organizationId)
    .eq("company_id", companyId)
    .is("verified_at", null)
    .gt("expires_at", new Date(nowMs).toISOString())
    .order("created_at", { ascending: false })
    .limit(1);
  const p = ((pending ?? []) as Array<{ phone_e164: string; expires_at: string }>)[0] ?? null;
  return {
    phone: row?.owner_phone_e164 ?? null,
    verified: Boolean(row?.owner_phone_e164 && row?.owner_phone_verified_at),
    verifiedAt: row?.owner_phone_verified_at ?? null,
    pendingPhone: p?.phone_e164 ?? null,
    pendingExpiresAt: p?.expires_at ?? null,
  };
}

/**
 * Provisioning paths only: the number came from the paying buyer (checkout, their intake
 * form) or an operator who spoke to them. Sets the number AND marks it verified in one update.
 */
export async function setOwnerPhoneVerified(
  admin: AdminClient,
  input: { organizationId: string; companyId: string; phone: string | null; at?: Date },
): Promise<void> {
  const phone = input.phone ? normalizeOwnerPhone(input.phone) ?? input.phone : null;
  const { error } = await (admin as Db)
    .from("companies")
    .update({ owner_phone_e164: phone, owner_phone_verified_at: phone ? (input.at ?? new Date()).toISOString() : null })
    .eq("organization_id", input.organizationId)
    .eq("id", input.companyId);
  if (error) throw error;
}

/**
 * Save a number an owner/admin typed (onboarding): stored UNVERIFIED (the trigger clears the
 * flag when it changes) — the owner channel ignores it until the code is confirmed.
 */
export async function saveOwnerPhoneUnverified(admin: AdminClient, input: { organizationId: string; companyId: string; phone: string | null }): Promise<void> {
  const phone = input.phone ? normalizeOwnerPhone(input.phone) : null;
  if (input.phone && !phone) throw Object.assign(new Error("That doesn't look like a phone number."), { status: 400 });
  const db = admin as Db;
  const { data } = await db.from("companies").select("owner_phone_e164").eq("organization_id", input.organizationId).eq("id", input.companyId).maybeSingle();
  if ((data as { owner_phone_e164: string | null } | null)?.owner_phone_e164 === phone) return;
  const { error } = await db
    .from("companies")
    .update({ owner_phone_e164: phone, owner_phone_verified_at: null })
    .eq("organization_id", input.organizationId)
    .eq("id", input.companyId);
  if (error) throw error;
}

export type StartResult = { ok: true; phone: string; expiresAt: string } | { ok: false; reason: "invalid_phone" | "rate_limited" | "send_failed"; message: string };

/** Text a 6-digit code to the number the owner wants to use (owner/admin route). */
export async function startOwnerPhoneVerification(
  admin: AdminClient,
  input: { organizationId: string; companyId: string; phone: string; requestedBy: string | null; platformBrand: string | null; nowMs?: number },
): Promise<StartResult> {
  const nowMs = input.nowMs ?? Date.now();
  const phone = normalizeOwnerPhone(input.phone);
  if (!phone) return { ok: false, reason: "invalid_phone", message: "That doesn't look like a mobile number." };
  if (!(await consumeLimit(admin, `owner_phone_verify:${input.companyId}`, STARTS_PER_HOUR, 3600))) {
    return { ok: false, reason: "rate_limited", message: "Too many codes sent - try again in an hour." };
  }
  const db = admin as Db;
  // Any earlier unused code for this company stops working.
  await db
    .from("owner_phone_verifications")
    .update({ expires_at: new Date(nowMs).toISOString() })
    .eq("organization_id", input.organizationId)
    .eq("company_id", input.companyId)
    .is("verified_at", null);
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const expiresAt = new Date(nowMs + OWNER_PHONE_CODE_TTL_MS).toISOString();
  const { data, error } = await db
    .from("owner_phone_verifications")
    .insert({
      organization_id: input.organizationId,
      company_id: input.companyId,
      phone_e164: phone,
      code_hash: "pending",
      attempts: 0,
      expires_at: expiresAt,
      requested_by: input.requestedBy,
      created_at: new Date(nowMs).toISOString(),
    })
    .select("id")
    .single();
  if (error) throw error;
  const id = (data as { id: string }).id;
  await db.from("owner_phone_verifications").update({ code_hash: hashCode(id, code) }).eq("id", id);
  const sent = await sendOwnerSms(admin, {
    to: phone,
    body: `Your code to use this phone for owner texts is ${code}. It expires in 10 minutes. If you didn't ask for this, ignore it.`,
    organizationId: input.organizationId,
    companyId: input.companyId,
    platformBrand: input.platformBrand,
  });
  if (sent.status !== "sent") {
    await db.from("owner_phone_verifications").update({ expires_at: new Date(nowMs).toISOString() }).eq("id", id);
    return {
      ok: false,
      reason: "send_failed",
      message: sent.status === "blocked" ? "That phone has texted STOP to us - text START to the number first." : "Couldn't text that number.",
    };
  }
  return { ok: true, phone, expiresAt };
}

export type ConfirmResult = { ok: true; phone: string } | { ok: false; reason: "no_code" | "expired" | "wrong_code" | "too_many_attempts"; message: string };

/** The code from the text → that number becomes the verified owner phone. */
export async function confirmOwnerPhoneVerification(
  admin: AdminClient,
  input: { organizationId: string; companyId: string; code: string; nowMs?: number },
): Promise<ConfirmResult> {
  const nowMs = input.nowMs ?? Date.now();
  const db = admin as Db;
  const { data } = await db
    .from("owner_phone_verifications")
    .select("id, phone_e164, code_hash, attempts, expires_at")
    .eq("organization_id", input.organizationId)
    .eq("company_id", input.companyId)
    .is("verified_at", null)
    .order("created_at", { ascending: false })
    .limit(1);
  const row = ((data ?? []) as Array<{ id: string; phone_e164: string; code_hash: string; attempts: number; expires_at: string }>)[0];
  if (!row) return { ok: false, reason: "no_code", message: "Send a code first." };
  if (Date.parse(row.expires_at) <= nowMs) return { ok: false, reason: "expired", message: "That code expired - send a new one." };
  if ((row.attempts ?? 0) >= OWNER_PHONE_MAX_ATTEMPTS) return { ok: false, reason: "too_many_attempts", message: "Too many tries - send a new code." };
  const attempts = (row.attempts ?? 0) + 1;
  await db.from("owner_phone_verifications").update({ attempts }).eq("id", row.id);
  const given = hashCode(row.id, String(input.code ?? "").replace(/\D/g, ""));
  const ok = given.length === row.code_hash.length && timingSafeEqual(Buffer.from(given), Buffer.from(row.code_hash));
  if (!ok) {
    return attempts >= OWNER_PHONE_MAX_ATTEMPTS
      ? { ok: false, reason: "too_many_attempts", message: "Too many tries - send a new code." }
      : { ok: false, reason: "wrong_code", message: "That code doesn't match." };
  }
  const at = new Date(nowMs).toISOString();
  const { data: claimed } = await db.from("owner_phone_verifications").update({ verified_at: at }).eq("id", row.id).is("verified_at", null).select("id");
  if (((claimed ?? []) as unknown[]).length !== 1) return { ok: false, reason: "no_code", message: "Send a code first." };
  await setOwnerPhoneVerified(admin, { organizationId: input.organizationId, companyId: input.companyId, phone: row.phone_e164, at: new Date(nowMs) });
  return { ok: true, phone: row.phone_e164 };
}
