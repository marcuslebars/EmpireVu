/**
 * Filing a compliance document (one path for owner texts, Settings uploads and a sub's upload
 * link): the row, its status from the expiry date, reminder stages the save already covered, and
 * the older document of the same kind for the same holder marked `replaced`. Plus the one-line
 * owner texts that describe a document.
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import type { ComplianceDocumentRow, ComplianceKind, Db, HolderType, UploadedVia } from "./db-types";
import { type HolderPick, possessive } from "./holders";
import { capitalize, daysBetween, kindLabel, maskedNumber, prettyDate, stagesCoveredAtSave, statusFor } from "./kinds";

export interface NewDocument {
  organizationId: string;
  companyId: string;
  kind: ComplianceKind;
  title?: string | null;
  holder: HolderPick | null;
  holderName?: string | null;
  issuer?: string | null;
  number?: string | null;
  issuedOn?: string | null;
  expiresOn?: string | null;
  filePath?: string | null;
  fileContentType?: string | null;
  /** More pages of the same document (front + back), same bucket. */
  extraFilePaths?: string[];
  notes?: string | null;
  uploadedVia: UploadedVia;
  uploadedBy?: string | null;
  sourceKey?: string | null;
  uploadRequestId?: string | null;
  aiRead?: Record<string, unknown> | null;
  intakeReply?: string | null;
  /** Mark the reminder stages the save already told the owner about (false: a sub's upload). */
  coverStagesAtSave?: boolean;
  /** Pending with this sub as the likely holder (an unreadable sub upload, waiting for the owner). */
  pendingSubId?: string | null;
  today: string;
  nowMs: number;
}

export interface FiledDocument {
  doc: ComplianceDocumentRow;
  /** Older documents this one replaced. */
  replaced: ComplianceDocumentRow[];
  /** True when this intake (source key) was already filed — nothing new was written. */
  duplicate: boolean;
  /** Live older documents of the same kind + holder this one did NOT replace (not shown to be newer). */
  kept: ComplianceDocumentRow[];
}

const STAGE_COLUMN = { 30: "reminded_30_at", 7: "reminded_7_at", 0: "reminded_0_at" } as const;

export async function loadDocument(admin: AdminClient, scope: { organizationId: string; companyId: string }, id: string): Promise<ComplianceDocumentRow | null> {
  const { data, error } = await (admin as Db).from("compliance_documents").select("*").eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).eq("id", id).maybeSingle();
  if (error) throw error;
  return (data as ComplianceDocumentRow | null) ?? null;
}

export async function loadDocuments(admin: AdminClient, scope: { organizationId: string; companyId: string }, options: { includeReplaced?: boolean } = {}): Promise<ComplianceDocumentRow[]> {
  const { data, error } = await (admin as Db)
    .from("compliance_documents")
    .select("*")
    .eq("organization_id", scope.organizationId)
    .eq("company_id", scope.companyId)
    .order("created_at", { ascending: false })
    .limit(1000);
  if (error) throw error;
  const rows = (data ?? []) as ComplianceDocumentRow[];
  return options.includeReplaced ? rows : rows.filter((r) => r.status !== "replaced");
}

/** The status a document should have today (pending / replaced stay as they are). PURE. */
export function liveStatus(doc: Pick<ComplianceDocumentRow, "status" | "expires_on">, today: string): ComplianceDocumentRow["status"] {
  if (doc.status === "pending" || doc.status === "replaced") return doc.status;
  return statusFor(doc.expires_on, today);
}

export async function findBySourceKey(admin: AdminClient, companyId: string, sourceKey: string): Promise<ComplianceDocumentRow | null> {
  const { data, error } = await (admin as Db).from("compliance_documents").select("*").eq("company_id", companyId).eq("source_key", sourceKey).maybeSingle();
  if (error) throw error;
  return (data as ComplianceDocumentRow | null) ?? null;
}

export async function fileDocument(admin: AdminClient, input: NewDocument): Promise<FiledDocument> {
  const db = admin as Db;
  if (input.sourceKey) {
    const existing = await findBySourceKey(admin, input.companyId, input.sourceKey);
    if (existing) return { doc: existing, replaced: [], duplicate: true, kept: [] };
  }
  const nowIso = new Date(input.nowMs).toISOString();
  const row: Record<string, unknown> = {
    organization_id: input.organizationId,
    company_id: input.companyId,
    kind: input.kind,
    title: input.title ?? null,
    holder_type: input.holder?.type ?? null,
    profile_id: input.holder?.profileId ?? null,
    subcontractor_id: input.holder?.subcontractorId ?? input.pendingSubId ?? null,
    holder_name: input.holderName ?? null,
    issuer: input.issuer ?? null,
    number: input.number ?? null,
    issued_on: input.issuedOn ?? null,
    expires_on: input.expiresOn ?? null,
    file_path: input.filePath ?? null,
    file_content_type: input.fileContentType ?? null,
    extra_file_paths: input.extraFilePaths ?? [],
    notes: input.notes ?? null,
    uploaded_via: input.uploadedVia,
    uploaded_by: input.uploadedBy ?? null,
    status: input.holder ? statusFor(input.expiresOn ?? null, input.today) : "pending",
    source_key: input.sourceKey ?? null,
    upload_request_id: input.uploadRequestId ?? null,
    ai_read: input.aiRead ?? null,
    intake_reply: input.intakeReply ?? null,
    created_at: nowIso,
    updated_at: nowIso,
  };
  if (input.coverStagesAtSave !== false) for (const stage of stagesCoveredAtSave(input.expiresOn ?? null, input.today)) row[STAGE_COLUMN[stage]] = nowIso;
  const { data, error } = await db.from("compliance_documents").insert(row).select("*").single();
  if (error) {
    if ((error as { code?: string }).code === "23505" && input.sourceKey) {
      const raced = await findBySourceKey(admin, input.companyId, input.sourceKey);
      if (raced) return { doc: raced, replaced: [], duplicate: true, kept: [] };
    }
    throw error;
  }
  const doc = data as ComplianceDocumentRow;
  await untrackUploads(admin, input.companyId, [input.filePath, ...(input.extraFilePaths ?? [])]);
  const { replaced, kept } = doc.holder_type ? await replaceOlderWithKept(admin, doc) : { replaced: [], kept: [] };
  return { doc, replaced, duplicate: false, kept };
}

/**
 * Same kind (and title, for licences / certifications), same holder → `replaced`, but ONLY when the
 * new one is shown to be newer: it has an expiry date that is later than the old one's (or the old
 * one has none). A new document with no readable date, an older-dated copy or the same copy again
 * never knocks out a live one — so the chase keeps running on it.
 */
export async function replaceOlder(admin: AdminClient, doc: ComplianceDocumentRow): Promise<ComplianceDocumentRow[]> {
  return (await replaceOlderWithKept(admin, doc)).replaced;
}

export async function replaceOlderWithKept(admin: AdminClient, doc: ComplianceDocumentRow): Promise<{ replaced: ComplianceDocumentRow[]; kept: ComplianceDocumentRow[] }> {
  const db = admin as Db;
  let query = db
    .from("compliance_documents")
    .select("*")
    .eq("organization_id", doc.organization_id)
    .eq("company_id", doc.company_id)
    .eq("kind", doc.kind)
    .eq("holder_type", doc.holder_type)
    .in("status", ["current", "expiring", "expired"]);
  if (doc.holder_type === "crew") query = query.eq("profile_id", doc.profile_id);
  if (doc.holder_type === "subcontractor") query = query.eq("subcontractor_id", doc.subcontractor_id);
  const { data, error } = await query.limit(50);
  if (error) throw error;
  const titled = doc.kind === "certification" || doc.kind === "trade_licence" || doc.kind === "other";
  const same = ((data ?? []) as ComplianceDocumentRow[]).filter((o) => {
    if (o.id === doc.id) return false;
    return !(titled && (o.title ?? "").trim().toLowerCase() !== (doc.title ?? "").trim().toLowerCase());
  });
  const newer = (o: ComplianceDocumentRow) => (o.expires_on ? Boolean(doc.expires_on && doc.expires_on > o.expires_on) : true);
  const out: ComplianceDocumentRow[] = [];
  const kept: ComplianceDocumentRow[] = [];
  for (const o of same) {
    if (!newer(o)) {
      if (o.status !== "expired") kept.push(o);
      continue;
    }
    const { data: hit, error: upErr } = await db
      .from("compliance_documents")
      .update({ status: "replaced", replaced_by: doc.id })
      .eq("id", o.id)
      .eq("company_id", doc.company_id)
      .in("status", ["current", "expiring", "expired"])
      .select("id");
    if (upErr) throw upErr;
    if (((hit ?? []) as unknown[]).length) out.push({ ...o, status: "replaced", replaced_by: doc.id });
  }
  // A dated copy that isn't newer than a live one (the same certificate again, an old copy) is
  // itself marked replaced by that live one, so nothing is chased twice. An undated one stays as
  // it is (no expiry → no reminders) until the owner gives its date.
  const live = kept.find((k) => k.expires_on);
  if (doc.expires_on && live && live.expires_on && live.expires_on >= doc.expires_on) {
    const { error: selfErr } = await db.from("compliance_documents").update({ status: "replaced", replaced_by: live.id }).eq("id", doc.id).eq("company_id", doc.company_id);
    if (selfErr) throw selfErr;
    doc.status = "replaced";
    doc.replaced_by = live.id;
  }
  return { replaced: out, kept };
}

// ── Uploaded files not (yet) filed ───────────────────────────────────────────────────

/** Remember a path we handed out / wrote, so an object nobody files is cleaned up after 24 h. */
export async function trackUpload(admin: AdminClient, scope: { organizationId: string; companyId: string }, path: string, nowMs: number): Promise<void> {
  const { error } = await (admin as Db)
    .from("compliance_uploads")
    .upsert({ path, organization_id: scope.organizationId, company_id: scope.companyId, created_at: new Date(nowMs).toISOString() }, { onConflict: "path", ignoreDuplicates: true });
  if (error) console.error("[compliance] could not track an upload:", error.message ?? error);
}

export async function untrackUploads(admin: AdminClient, companyId: string, paths: Array<string | null | undefined>): Promise<void> {
  const list = paths.filter((p): p is string => Boolean(p));
  if (list.length === 0) return;
  const { error } = await (admin as Db).from("compliance_uploads").delete().eq("company_id", companyId).in("path", list);
  if (error) console.error("[compliance] could not untrack uploads:", error.message ?? error);
}

/** Give a pending document its holder (and any corrected details); then replace older ones. */
export async function assignHolder(
  admin: AdminClient,
  doc: ComplianceDocumentRow,
  holder: HolderPick,
  patch: { kind?: ComplianceKind | null; title?: string | null; expiresOn?: string | null; issuer?: string | null; number?: string | null },
  today: string,
  nowMs: number,
): Promise<{ doc: ComplianceDocumentRow; replaced: ComplianceDocumentRow[] }> {
  const expiresOn = patch.expiresOn !== undefined && patch.expiresOn !== null ? patch.expiresOn : doc.expires_on;
  const update: Record<string, unknown> = {
    holder_type: holder.type,
    profile_id: holder.profileId,
    subcontractor_id: holder.subcontractorId,
    kind: patch.kind ?? doc.kind,
    title: patch.title !== undefined && patch.title !== null ? patch.title : doc.title,
    issuer: patch.issuer ?? doc.issuer,
    number: patch.number ?? doc.number,
    expires_on: expiresOn,
    status: statusFor(expiresOn, today),
    updated_at: new Date(nowMs).toISOString(),
  };
  const nowIso = new Date(nowMs).toISOString();
  // A changed expiry re-arms the stages it hasn't reached yet.
  if (expiresOn !== doc.expires_on) {
    update.reminded_30_at = null;
    update.reminded_7_at = null;
    update.reminded_0_at = null;
  }
  for (const stage of stagesCoveredAtSave(expiresOn, today)) {
    if (expiresOn !== doc.expires_on || !doc[STAGE_COLUMN[stage]]) update[STAGE_COLUMN[stage]] = nowIso;
  }
  const { data, error } = await (admin as Db)
    .from("compliance_documents")
    .update(update)
    .eq("id", doc.id)
    .eq("organization_id", doc.organization_id)
    .eq("company_id", doc.company_id)
    .select("*");
  if (error) throw error;
  const saved = ((data ?? []) as ComplianceDocumentRow[])[0] ?? ({ ...doc, ...update } as ComplianceDocumentRow);
  const replaced = await replaceOlder(admin, saved);
  return { doc: saved, replaced };
}

// ── Words ────────────────────────────────────────────────────────────────────────────

/** "liability insurance (Intact, policy ...4821)" — with the holder: "Mike's Electric's WSIB clearance (…)". PURE. */
export function describeDocument(doc: { kind: ComplianceKind; title?: string | null; issuer?: string | null; number?: string | null }, holderLabel?: string | null): string {
  const label = kindLabel(doc.kind, doc.title);
  const extras = [doc.issuer?.trim(), maskedNumber(doc.kind, doc.number)].filter(Boolean);
  const who = holderLabel && holderLabel !== "you" ? `${possessive(holderLabel)} ` : "";
  return `${who}${label}${extras.length ? ` (${extras.join(", ")})` : ""}`;
}

/** What the owner is told when a document is saved. PURE. */
export function savedLine(input: {
  kind: ComplianceKind;
  title?: string | null;
  issuer?: string | null;
  number?: string | null;
  expiresOn: string | null;
  holderLabel: string | null;
  today: string;
  reminders: boolean;
  replacedCount?: number;
  /** A live one on file this didn't replace (not shown to be newer): its expiry, or "" when it has none. */
  keptExpiresOn?: string | null;
}): string {
  const what = describeDocument(input, input.holderLabel);
  const kept =
    input.keptExpiresOn === undefined || input.keptExpiresOn === null
      ? ""
      : ` The one already on file${input.keptExpiresOn ? ` (expires ${prettyDate(input.keptExpiresOn)})` : ""} stays the current one${input.expiresOn ? "" : " until I know this one's date"}.`;
  const replaced = input.replacedCount ? " It replaces the old one." : kept;
  if (!input.expiresOn) {
    return `Saved: ${what}.${replaced} I couldn't see an expiry date - text me "expires" and the date if it has one.`;
  }
  const days = daysBetween(input.today, input.expiresOn);
  const date = prettyDate(input.expiresOn);
  if (days < 0) return `Saved: ${what}, but it expired ${date}. Text me a photo of the new one when you have it.${replaced}`;
  const base = `Saved: ${what}, ${days === 0 ? "expires today" : `expires ${date}`}.${replaced}`;
  if (!input.reminders || days === 0) return base;
  if (days > 30) return `${base} I'll remind you 30 days before.`;
  if (days > 7) return `${base} I'll remind you a week before.`;
  return `${base} I'll remind you on the day.`;
}

/** "Liability insurance expires in 7 days" / "Mike's Electric WSIB clearance expired". PURE. */
export function expiryLine(doc: { kind: ComplianceKind; title?: string | null; expires_on: string | null; holder_type?: HolderType | null }, holderLabel: string | null, today: string): string {
  // "Mike's Working at Heights" (crew), "Mike's Electric WSIB clearance" (a sub's business name).
  const who = holderLabel && holderLabel !== "you" ? (doc.holder_type === "crew" ? `${possessive(holderLabel)} ` : `${holderLabel} `) : "";
  const what = capitalize(`${who}${kindLabel(doc.kind, doc.title)}`);
  if (!doc.expires_on) return what;
  const days = daysBetween(today, doc.expires_on);
  if (days < 0) return `${what} expired`;
  if (days === 0) return `${what} expires today`;
  if (days === 1) return `${what} expires tomorrow`;
  return `${what} expires in ${days} days`;
}

/** Holder labels for documents: the company "you", crew first names, sub names. */
export function holderLabelFor(
  doc: Pick<ComplianceDocumentRow, "holder_type" | "profile_id" | "subcontractor_id" | "holder_name">,
  crewNames: Map<string, string>,
  subNames: Map<string, string>,
): string | null {
  const type: HolderType | null = doc.holder_type;
  if (type === "company") return "you";
  if (type === "crew") return (doc.profile_id && crewNames.get(doc.profile_id)) || doc.holder_name || "crew";
  if (type === "subcontractor") return (doc.subcontractor_id && subNames.get(doc.subcontractor_id)) || doc.holder_name || "a sub";
  return null;
}

export async function logEvent(
  admin: AdminClient,
  event: { organizationId: string; companyId: string; event: string; documentId?: string | null; shareId?: string | null; requestId?: string | null; actor?: string | null; ip?: string | null; userAgent?: string | null; detail?: Record<string, unknown> | null },
): Promise<void> {
  try {
    const { error } = await (admin as Db).from("compliance_events").insert({
      organization_id: event.organizationId,
      company_id: event.companyId,
      event: event.event,
      document_id: event.documentId ?? null,
      share_id: event.shareId ?? null,
      request_id: event.requestId ?? null,
      actor: event.actor ?? null,
      ip: event.ip ?? null,
      user_agent: event.userAgent ? event.userAgent.slice(0, 300) : null,
      detail: event.detail ?? null,
    });
    if (error) throw error;
  } catch (err) {
    console.error("[compliance] audit write failed:", err instanceof Error ? err.message : err);
  }
}
