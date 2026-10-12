/**
 * The daily email digest (sweep `email_clerk:digest`, every 5 minutes): one owner text at the set
 * time (default 16:00 local, until 20:00) summing up the mail nobody was texted about — suppliers,
 * bills, other mail — plus how much junk was ignored:
 *
 *   Email today: 2 suppliers (PO-3 confirmed; …), 1 bill (Rona $412 due Oct 30), 5 newsletters ignored.
 *
 * Covers what came in since the last digest (at most 48 h back). One per company per local day:
 * `email_clerk_digests` (unique company + date) is claimed before anything is sent; a failed text
 * is retried after 10 minutes (3 tries). Customer emails and bid invites were already texted (or
 * are waiting as approvals), so they aren't repeated. Nothing worth saying → no text.
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { sendOwnerSms } from "@/server/services/owner-channel/common";
import type { Db, EmailDigestRow, InboundEmailRow } from "./db-types";
import { digestText } from "./format";
import { loadEmailClerkCompanies, inboundConfigured, type EmailClerkCompany } from "./settings";
import { localDateOf, localMinutes, minutesOf } from "./time";

const DIGEST_CATEGORIES = ["supplier", "bill", "other", "newsletter", "auto_reply", "bounce", "no_reply", "spam"];
const LAST_MINUTE = 20 * 60;
const RETRY_MS = 10 * 60_000;
const MAX_TRIES = 3;
const WINDOW_MS = 48 * 3_600_000;

let cached: { atMs: number; companies: EmailClerkCompany[] } | null = null;

export function resetEmailClerkCompanyCache(): void {
  cached = null;
}

async function companies(admin: AdminClient, nowMs: number): Promise<EmailClerkCompany[]> {
  if (cached && Math.abs(nowMs - cached.atMs) < 30_000) return cached.companies;
  const list = await loadEmailClerkCompanies(admin);
  cached = { atMs: nowMs, companies: list };
  return list;
}

/** Is it digest time for this company? PURE. */
export function digestDue(company: Pick<EmailClerkCompany, "timeZone" | "settings">, nowMs: number): boolean {
  if (!company.settings.digest) return false;
  const m = localMinutes(nowMs, company.timeZone);
  return m >= minutesOf(company.settings.digestTime) && m < LAST_MINUTE;
}

async function claimDigest(admin: AdminClient, company: EmailClerkCompany, localDate: string, nowMs: number): Promise<EmailDigestRow | null> {
  const db = admin as Db;
  const nowIso = new Date(nowMs).toISOString();
  const { data, error } = await db
    .from("email_clerk_digests")
    .insert({ organization_id: company.organizationId, company_id: company.companyId, local_date: localDate, status: "claimed", attempts: 1, email_ids: [], created_at: nowIso, updated_at: nowIso })
    .select("*")
    .single();
  if (!error) return data as EmailDigestRow;
  if ((error as { code?: string }).code !== "23505") throw error;
  const { data: existing } = await db.from("email_clerk_digests").select("*").eq("company_id", company.companyId).eq("local_date", localDate).maybeSingle();
  const row = existing as EmailDigestRow | null;
  if (!row || row.status !== "failed" || row.attempts >= MAX_TRIES || nowMs - Date.parse(row.updated_at) < RETRY_MS) return null;
  const { data: hit } = await db
    .from("email_clerk_digests")
    .update({ status: "claimed", attempts: row.attempts + 1, updated_at: nowIso })
    .eq("id", row.id)
    .eq("status", "failed")
    .eq("attempts", row.attempts)
    .select("*");
  return ((hit ?? []) as EmailDigestRow[])[0] ?? null;
}

/** One company's digest, if it's due. Returns the text sent (or null). */
export async function runCompanyDigest(admin: AdminClient, company: EmailClerkCompany, nowMs: number): Promise<string | null> {
  if (!company.ownerPhone || !digestDue(company, nowMs)) return null;
  const today = localDateOf(nowMs, company.timeZone);
  const db = admin as Db;
  // Cheap check first: today's row already final → nothing to do.
  const { data: todays } = await db.from("email_clerk_digests").select("status, attempts, updated_at").eq("company_id", company.companyId).eq("local_date", today).maybeSingle();
  const t = todays as Pick<EmailDigestRow, "status" | "attempts" | "updated_at"> | null;
  if (t && (t.status !== "failed" || t.attempts >= MAX_TRIES)) return null;

  const { data, error } = await db
    .from("inbound_emails")
    .select("*")
    .eq("organization_id", company.organizationId)
    .eq("company_id", company.companyId)
    .eq("status", "done")
    .is("digest_date", null)
    .in("category", DIGEST_CATEGORIES)
    .gte("received_at", new Date(nowMs - WINDOW_MS).toISOString())
    .order("received_at", { ascending: true })
    .limit(200);
  if (error) throw error;
  // Already texted on its own (a supplier about our PO) → not repeated.
  const rows = ((data ?? []) as InboundEmailRow[]).filter((r) => r.owner_alert_status !== "sent" && r.owner_alert_status !== "held");
  const body = digestText({ today, rows });
  if (!body) return null;

  const claim = await claimDigest(admin, company, today, nowMs);
  if (!claim) return null;
  const sent = await sendOwnerSms(admin, { to: company.ownerPhone, body, organizationId: company.organizationId, companyId: company.companyId, platformBrand: company.platformBrand });
  const nowIso = new Date(nowMs).toISOString();
  if (sent.status !== "sent") {
    await db
      .from("email_clerk_digests")
      .update({ status: sent.status === "blocked" ? "skipped" : "failed", last_error: sent.reason ?? sent.status, updated_at: nowIso })
      .eq("id", claim.id);
    return null;
  }
  const ids = rows.map((r) => r.id);
  await db.from("email_clerk_digests").update({ status: "sent", body, email_ids: ids, updated_at: nowIso }).eq("id", claim.id);
  for (let i = 0; i < ids.length; i += 100) {
    await db.from("inbound_emails").update({ digest_date: today }).in("id", ids.slice(i, i + 100)).is("digest_date", null);
  }
  return body;
}

export async function sweepDigests(admin: AdminClient, nowMs: number): Promise<number> {
  if (!inboundConfigured()) return 0;
  let sent = 0;
  for (const company of await companies(admin, nowMs)) {
    try {
      if (await runCompanyDigest(admin, company, nowMs)) sent += 1;
    } catch (err) {
      console.error("[email-clerk] digest failed", company.companyId, err instanceof Error ? err.message : err);
    }
  }
  return sent;
}
