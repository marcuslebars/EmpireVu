/**
 * Compliance sweeps (through runStaffSweeps):
 *
 *   compliance:expiry  (15 min) keeps each document's status right (current → expiring at 30 days →
 *                      expired) and chases expiry: ONE owner text per document per stage — 30 days
 *                      before, 7 days before, and on the day (caught up for 2 days if a worker was
 *                      down) — claimed with a conditional update on reminded_<stage>_at before the
 *                      text, released if it fails. Several documents due together share one text.
 *                      A sub's document at 7 days / on the day becomes a `request_sub_docs`
 *                      approval instead (when the sub has a cell or email and isn't already asked).
 *                      Only 09:00–20:00 local, verified owner cell, reminders on.
 *   compliance:outbox  (2 min) sends queued sub links and shared links inside 09:00–20:00 local,
 *                      tells the owner about sub uploads that came in overnight (08:00–21:00), and
 *                      fails a send stuck in `sending` (never re-sent: one missed beats a double).
 *
 * Only companies with Compliance on are touched; documents only exist where it was on.
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { isQuietHours, sendOwnerSms } from "@/server/services/owner-channel/common";
import type { ComplianceDocumentRow, Db, ShareRow, SubcontractorRow, UploadRequestRow } from "./db-types";
import { expiryLine, holderLabelFor } from "./documents";
import { firstName, loadCrew, subLabel } from "./holders";
import { addDays, dueStage, statusFor, type ReminderStage } from "./kinds";
import { loadSub, notifyOwnerOfSubUpload, proposeSubDocsRequest, sendUploadRequest } from "./requests";
import { sendShare } from "./shares";
import { loadComplianceCompanies, type ComplianceCompany } from "./settings";
import { inSendWindow, localParts } from "./time";

const STAGE_COLUMN: Record<ReminderStage, "reminded_30_at" | "reminded_7_at" | "reminded_0_at"> = { 30: "reminded_30_at", 7: "reminded_7_at", 0: "reminded_0_at" };
const PAGE = 1000;
const STUCK_SENDING_MS = 10 * 60_000;

async function pagedDocs(admin: AdminClient, build: (q: Db) => Db): Promise<ComplianceDocumentRow[]> {
  const out: ComplianceDocumentRow[] = [];
  for (let page = 0; page < 50; page++) {
    const { data, error } = await build((admin as Db).from("compliance_documents").select("*"))
      .order("id", { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as ComplianceDocumentRow[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

/** Statuses that drifted with the calendar (current → expiring → expired), for docs of loaded companies. */
async function refreshStatuses(admin: AdminClient, docs: ComplianceDocumentRow[], today: string): Promise<void> {
  for (const doc of docs) {
    const want = statusFor(doc.expires_on, today);
    if (want === doc.status) continue;
    await (admin as Db).from("compliance_documents").update({ status: want }).eq("id", doc.id).eq("status", doc.status);
    doc.status = want;
  }
}

export async function sweepExpiry(admin: AdminClient, nowMs: number): Promise<{ texted: number; asked: number }> {
  const utcToday = new Date(nowMs).toISOString().slice(0, 10);
  // Wide enough for every time zone. Live documents within 31 days (or already past: their status
  // drifted), plus expired ones from the last 3 days (the on-the-day stage's catch-up).
  const live = await pagedDocs(admin, (q) => q.in("status", ["current", "expiring"]).lte("expires_on", addDays(utcToday, 31)));
  const lapsed = await pagedDocs(admin, (q) => q.eq("status", "expired").gte("expires_on", addDays(utcToday, -3)));
  const docs = [...live, ...lapsed];
  if (docs.length === 0) return { texted: 0, asked: 0 };
  const byCompany = new Map<string, ComplianceDocumentRow[]>();
  for (const d of docs) byCompany.set(d.company_id, [...(byCompany.get(d.company_id) ?? []), d]);
  const companies = await loadComplianceCompanies(admin, [...byCompany.keys()]);
  let texted = 0;
  let asked = 0;
  for (const company of companies) {
    if (!company.settings.enabled || !company.active) continue;
    try {
      const result = await chaseCompany(admin, company, byCompany.get(company.companyId) ?? [], nowMs);
      texted += result.texted;
      asked += result.asked;
    } catch (err) {
      console.error("[compliance] expiry chase failed for", company.companyId, err instanceof Error ? err.message : err);
    }
  }
  return { texted, asked };
}

export async function chaseCompany(admin: AdminClient, company: ComplianceCompany, docs: ComplianceDocumentRow[], nowMs: number): Promise<{ texted: number; asked: number }> {
  const local = localParts(nowMs, company.timeZone);
  const today = local.date;
  await refreshStatuses(admin, docs, today);
  if (!company.settings.reminders || !company.ownerPhone || !company.ownerPhoneVerified) return { texted: 0, asked: 0 };
  if (local.hour < 9 || local.hour >= 20) return { texted: 0, asked: 0 };

  const due = docs
    .filter((d) => d.holder_type && d.expires_on && d.status !== "replaced" && d.status !== "pending")
    .map((d) => ({ doc: d, stage: dueStage(d.expires_on as string, today) }))
    .filter((x): x is { doc: ComplianceDocumentRow; stage: ReminderStage } => x.stage !== null && !x.doc[STAGE_COLUMN[x.stage]]);
  if (due.length === 0) return { texted: 0, asked: 0 };

  const crew = await loadCrew(admin, company.organizationId);
  const crewNames = new Map(crew.map((m) => [m.profileId, firstName(m.name) || m.name]));
  const subs = new Map<string, SubcontractorRow | null>();
  for (const { doc } of due) {
    if (doc.subcontractor_id && !subs.has(doc.subcontractor_id)) subs.set(doc.subcontractor_id, await loadSub(admin, company, doc.subcontractor_id));
  }
  const subNames = new Map([...subs].flatMap(([id, s]) => (s ? [[id, subLabel(s)] as [string, string]] : [])));

  const lines: string[] = [];
  const claimed: Array<{ id: string; column: string }> = [];
  let asked = 0;
  let subHint: string | null = null;
  // Most urgent first.
  due.sort((a, b) => (a.doc.expires_on ?? "").localeCompare(b.doc.expires_on ?? ""));
  for (const { doc, stage } of due) {
    const sub = doc.subcontractor_id ? subs.get(doc.subcontractor_id) ?? null : null;
    if (doc.holder_type === "subcontractor" && (!sub || !sub.active)) continue;
    const column = STAGE_COLUMN[stage];
    const { data: hit, error } = await (admin as Db)
      .from("compliance_documents")
      .update({ [column]: new Date(nowMs).toISOString() })
      .eq("id", doc.id)
      .is(column, null)
      .select("id");
    if (error) throw error;
    if (((hit ?? []) as unknown[]).length === 0) continue;
    if (sub && stage !== 30) {
      const proposal = await proposeSubDocsRequest(admin, company, sub.id, { documentId: doc.id, nowMs });
      if (proposal.ok) {
        asked++;
        continue;
      }
      if (proposal.reason === "already_asked" || proposal.reason === "link_open") continue;
    }
    claimed.push({ id: doc.id, column });
    lines.push(expiryLine(doc, holderLabelFor(doc, crewNames, subNames), today));
    if (sub && !subHint) subHint = subLabel(sub);
  }
  if (lines.length === 0) return { texted: 0, asked };

  const shown = lines.slice(0, 6);
  const more = lines.length > shown.length ? ` (+${lines.length - shown.length} more - text "compliance" for the list)` : "";
  const ask = subHint ? ` Text me "ask ${subHint} for documents" and I'll send them an upload link.` : "";
  const body = `Heads up: ${shown.join("; ")}.${more} Text me a photo of the new one when you have it.${ask}`;
  const sent = await sendOwnerSms(admin, { to: company.ownerPhone, body, organizationId: company.organizationId, companyId: company.companyId, platformBrand: company.platformBrand });
  if (sent.status === "failed") {
    for (const c of claimed) await (admin as Db).from("compliance_documents").update({ [c.column]: null }).eq("id", c.id);
    return { texted: 0, asked };
  }
  return { texted: sent.status === "sent" ? 1 : 0, asked };
}

// ── Outbox ───────────────────────────────────────────────────────────────────────────

export async function sweepOutbox(admin: AdminClient, nowMs: number): Promise<void> {
  const db = admin as Db;
  const nowIso = new Date(nowMs).toISOString();
  const stuck = new Date(nowMs - STUCK_SENDING_MS).toISOString();
  // A crashed worker's send: never retried (it may have gone out).
  await db.from("compliance_upload_requests").update({ status: "failed", last_error: "stuck_sending" }).eq("status", "sending").lt("updated_at", stuck);
  await db.from("compliance_shares").update({ status: "failed", last_error: "stuck_sending" }).eq("status", "sending").lt("updated_at", stuck);

  const { data: reqData, error: reqErr } = await db.from("compliance_upload_requests").select("*").eq("status", "queued").lte("send_after", nowIso).limit(200);
  if (reqErr) throw reqErr;
  const { data: shareData, error: shareErr } = await db.from("compliance_shares").select("*").eq("status", "queued").lte("send_after", nowIso).limit(200);
  if (shareErr) throw shareErr;
  const { data: noticeData, error: noticeErr } = await db
    .from("compliance_documents")
    .select("*")
    .eq("uploaded_via", "sub_link")
    .is("owner_notified_at", null)
    .gte("created_at", new Date(nowMs - 3 * 86_400_000).toISOString())
    .limit(200);
  if (noticeErr) throw noticeErr;
  const requests = (reqData ?? []) as UploadRequestRow[];
  const shares = (shareData ?? []) as ShareRow[];
  const notices = (noticeData ?? []) as ComplianceDocumentRow[];
  if (requests.length + shares.length + notices.length === 0) return;

  const companyIds = [...new Set([...requests, ...shares, ...notices].map((r) => r.company_id))];
  const companies = new Map((await loadComplianceCompanies(admin, companyIds)).map((c) => [c.companyId, c]));

  for (const row of requests) {
    const company = companies.get(row.company_id);
    try {
      if (!company || !company.settings.enabled || Date.parse(row.expires_at) <= nowMs) {
        await db.from("compliance_upload_requests").update({ status: "cancelled", last_error: !company?.settings.enabled ? "compliance_off" : "expired" }).eq("id", row.id).eq("status", "queued");
        continue;
      }
      if (!inSendWindow(nowMs, company.timeZone)) continue;
      const sub = await loadSub(admin, company, row.subcontractor_id);
      if (!sub || !sub.active) {
        await db.from("compliance_upload_requests").update({ status: "cancelled", last_error: "sub_inactive" }).eq("id", row.id).eq("status", "queued");
        continue;
      }
      await sendUploadRequest(admin, company, sub, row, nowMs);
    } catch (err) {
      console.error("[compliance] queued upload link failed", row.id, err instanceof Error ? err.message : err);
    }
  }
  for (const row of shares) {
    const company = companies.get(row.company_id);
    try {
      if (!company || !company.settings.enabled || !company.settings.sharing || Date.parse(row.expires_at) <= nowMs) {
        await db.from("compliance_shares").update({ status: "revoked", revoked_at: nowIso, revoked_by: "system" }).eq("id", row.id).eq("status", "queued");
        continue;
      }
      if (!inSendWindow(nowMs, company.timeZone)) continue;
      await sendShare(admin, company, row, nowMs);
    } catch (err) {
      console.error("[compliance] queued share failed", row.id, err instanceof Error ? err.message : err);
    }
  }
  for (const doc of notices) {
    const company = companies.get(doc.company_id);
    if (!company || !company.settings.enabled || isQuietHours(nowMs, company.timeZone) || !doc.subcontractor_id) continue;
    try {
      const sub = await loadSub(admin, company, doc.subcontractor_id);
      if (sub) await notifyOwnerOfSubUpload(admin, company, doc, sub, nowMs);
    } catch (err) {
      console.error("[compliance] sub upload notice failed", doc.id, err instanceof Error ? err.message : err);
    }
  }
}
