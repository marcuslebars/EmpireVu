/**
 * Settings → AI front desk → Compliance: the switches, every document (expired ones flagged),
 * subs, the links sent to customers and subs, and the owner/admin actions (upload, edit, delete,
 * subs, turn a link off). The route checks the caller; everything here is pinned to the scope.
 */
import { ValidationError } from "@/server/organizations/context";
import { updateAiSettings } from "@/server/services/front-desk/ai-settings-write";
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { UserFacingError } from "@/server/errors";
import type { ComplianceDocumentRow, ComplianceKind, Db, ShareRow, SubcontractorRow, UploadRequestRow } from "./db-types";
import { complianceDeps } from "./deps";
import { assignHolder, fileDocument, holderLabelFor, liveStatus, loadDocument, loadDocuments, logEvent, savedLine } from "./documents";
import { COMPANY_HOLDER, firstName, forCrew, forSub, loadCrew, loadSubs, pickHolder, subLabel, type HolderPick } from "./holders";
import { holderContext } from "./intake";
import { capitalize, daysBetween, isComplianceKind, isDateKey, kindLabel } from "./kinds";
import { revokeShares, shareLabel } from "./shares";
import { loadComplianceCompany, mergeComplianceSettings, type ComplianceCompany, type ComplianceSettings, type ComplianceSettingsPatch } from "./settings";
import { DOC_TYPES, docPathFor, isCompanyDocPath } from "./storage";
import { createSub, updateSub, type SubInput } from "./subs";
import { localDate } from "./time";

type Scope = { organizationId: string; companyId: string };

export interface DocumentView {
  id: string;
  kind: ComplianceKind;
  label: string;
  title: string | null;
  holderType: "company" | "crew" | "subcontractor" | null;
  holderLabel: string | null;
  profileId: string | null;
  subcontractorId: string | null;
  holderName: string | null;
  issuer: string | null;
  number: string | null;
  issuedOn: string | null;
  expiresOn: string | null;
  daysLeft: number | null;
  status: ComplianceDocumentRow["status"];
  uploadedVia: ComplianceDocumentRow["uploaded_via"];
  hasFile: boolean;
  notes: string | null;
  createdAt: string;
}

export interface ComplianceView {
  companyId: string;
  settings: ComplianceSettings;
  ownerPhoneVerified: boolean;
  /** Owners/admins only (null for members). */
  documents: DocumentView[] | null;
  crew: Array<{ profileId: string; name: string }> | null;
  subs: Array<{ id: string; name: string; businessName: string | null; contactName: string | null; trade: string | null; phone: string | null; email: string | null; notes: string | null; active: boolean; clearance: "current" | "expiring" | "expired" | "missing" }> | null;
  shares: Array<{ id: string; customer: string; document: string; status: string; sentAt: string | null; expiresAt: string; opens: number; lastOpenedAt: string | null; live: boolean }> | null;
  requests: Array<{ id: string; sub: string; status: string; sentAt: string | null; expiresAt: string; uploads: number; live: boolean }> | null;
  counts: { documents: number; expiring: number; expired: number; pending: number };
}

export async function getComplianceView(admin: AdminClient, scope: Scope, options: { full: boolean; nowMs?: number }): Promise<ComplianceView | null> {
  const company = await loadComplianceCompany(admin, scope);
  if (!company) return null;
  const nowMs = options.nowMs ?? Date.now();
  const today = localDate(nowMs, company.timeZone);
  const docs = await loadDocuments(admin, scope);
  const counts = {
    documents: docs.filter((d) => d.status !== "pending").length,
    expiring: docs.filter((d) => liveStatus(d, today) === "expiring").length,
    expired: docs.filter((d) => liveStatus(d, today) === "expired").length,
    pending: docs.filter((d) => d.status === "pending").length,
  };
  const base = { companyId: scope.companyId, settings: company.settings, ownerPhoneVerified: company.ownerPhoneVerified, counts };
  if (!options.full) return { ...base, documents: null, crew: null, subs: null, shares: null, requests: null };

  const [crew, subs] = await Promise.all([loadCrew(admin, scope.organizationId), loadSubs(admin, scope)]);
  const crewNames = new Map(crew.map((m) => [m.profileId, firstName(m.name) || m.name]));
  const subNames = new Map(subs.map((s) => [s.id, subLabel(s)]));
  const documents = docs.map((d) => toDocView(d, holderLabelFor(d, crewNames, subNames), today));

  const db = admin as Db;
  const [{ data: shareData }, { data: reqData }] = await Promise.all([
    db.from("compliance_shares").select("*").eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).order("created_at", { ascending: false }).limit(30),
    db.from("compliance_upload_requests").select("*").eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).order("created_at", { ascending: false }).limit(30),
  ]);
  const shareRows = (shareData ?? []) as ShareRow[];
  const contactIds = [...new Set(shareRows.map((s) => s.contact_id).filter((x): x is string => Boolean(x)))];
  const { data: contacts } = contactIds.length ? await db.from("contacts").select("id, first_name, last_name, phone").eq("organization_id", scope.organizationId).in("id", contactIds) : { data: [] };
  const contactName = new Map(((contacts ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null; phone: string | null }>).map((c) => [c.id, [c.first_name, c.last_name].filter(Boolean).join(" ") || c.phone || "Customer"]));
  const docById = new Map(docs.map((d) => [d.id, d]));
  const live = (status: string, expiresAt: string) => ["queued", "sending", "sent"].includes(status) && Date.parse(expiresAt) > nowMs;

  return {
    ...base,
    documents,
    crew: crew.map((m) => ({ profileId: m.profileId, name: m.name })),
    subs: subs.map((s) => ({
      id: s.id,
      name: subLabel(s),
      businessName: s.business_name,
      contactName: s.name,
      trade: s.trade,
      phone: s.phone_e164,
      email: s.email,
      notes: s.notes,
      active: s.active,
      clearance: clearanceOf(s, docs, today),
    })),
    shares: shareRows.map((s) => {
      const d = docById.get(s.document_id);
      return {
        id: s.id,
        customer: (s.contact_id && contactName.get(s.contact_id)) || "Customer",
        document: d ? capitalize(shareLabel(d)) : "Document",
        status: s.status,
        sentAt: s.sent_at,
        expiresAt: s.expires_at,
        opens: s.open_count ?? 0,
        lastOpenedAt: s.last_opened_at,
        live: live(s.status, s.expires_at),
      };
    }),
    requests: ((reqData ?? []) as UploadRequestRow[]).map((r) => ({
      id: r.id,
      sub: subNames.get(r.subcontractor_id) ?? "Sub",
      status: r.status,
      sentAt: r.sent_at,
      expiresAt: r.expires_at,
      uploads: r.uploads,
      live: live(r.status, r.expires_at),
    })),
  };
}

function clearanceOf(sub: SubcontractorRow, docs: ComplianceDocumentRow[], today: string): "current" | "expiring" | "expired" | "missing" {
  const mine = docs.filter((d) => d.subcontractor_id === sub.id && d.kind === "wsib_clearance" && d.status !== "pending");
  if (mine.length === 0) return "missing";
  const statuses = mine.map((d) => liveStatus(d, today));
  if (statuses.includes("current")) return "current";
  if (statuses.includes("expiring")) return "expiring";
  return "expired";
}

function toDocView(d: ComplianceDocumentRow, holderLabel: string | null, today: string): DocumentView {
  return {
    id: d.id,
    kind: d.kind,
    label: capitalize(kindLabel(d.kind, d.title)),
    title: d.title,
    holderType: d.holder_type,
    holderLabel: holderLabel === "you" ? "Your business" : holderLabel,
    profileId: d.profile_id,
    subcontractorId: d.subcontractor_id,
    holderName: d.holder_name,
    issuer: d.issuer,
    number: d.number,
    issuedOn: d.issued_on,
    expiresOn: d.expires_on,
    daysLeft: d.expires_on ? daysBetween(today, d.expires_on) : null,
    status: liveStatus(d, today),
    uploadedVia: d.uploaded_via,
    hasFile: Boolean(d.file_path),
    notes: d.notes,
    createdAt: d.created_at,
  };
}

export async function updateComplianceSettings(admin: AdminClient, scope: Scope, patch: ComplianceSettingsPatch): Promise<ComplianceView | null> {
  const written = await updateAiSettings(admin, scope, (current) => mergeComplianceSettings(current, patch));
  if (!written) return null;
  return getComplianceView(admin, scope, { full: true });
}

// ── Actions (owner/admin) ────────────────────────────────────────────────────────────

export type HolderChoice = { type: "company" } | { type: "crew"; profileId: string } | { type: "subcontractor"; subcontractorId: string };

async function holderFrom(admin: AdminClient, company: ComplianceCompany, choice: HolderChoice): Promise<HolderPick> {
  if (choice.type === "company") return COMPANY_HOLDER;
  if (choice.type === "crew") {
    const member = (await loadCrew(admin, company.organizationId)).find((m) => m.profileId === choice.profileId);
    if (!member) throw new ValidationError("That person isn't on your team.");
    return forCrew(member);
  }
  const sub = (await loadSubs(admin, company)).find((s) => s.id === choice.subcontractorId);
  if (!sub) throw new ValidationError("That sub isn't on your list.");
  return forSub(sub);
}

async function enabledCompany(admin: AdminClient, scope: Scope): Promise<ComplianceCompany> {
  const company = await loadComplianceCompany(admin, scope);
  if (!company) throw new UserFacingError("Company not found.", { status: 404 });
  if (!company.settings.enabled) throw new ValidationError("Turn Compliance on first.");
  return company;
}

export async function createSettingsUpload(admin: AdminClient, scope: Scope, contentType: string): Promise<{ path: string; token: string; bucket: string }> {
  const company = await enabledCompany(admin, scope);
  const path = docPathFor(company.organizationId, company.companyId, contentType);
  if (!path) throw new ValidationError("Upload a photo (JPG, PNG, HEIC) or a PDF.");
  const upload = await complianceDeps().storage(admin).createUploadUrl(path);
  return { ...upload, bucket: "compliance-docs" };
}

export async function fileSettingsUpload(
  admin: AdminClient,
  scope: Scope,
  input: { path: string; contentType: string; holder?: HolderChoice | null; kind?: string | null },
  actor: string,
  nowMs: number = Date.now(),
): Promise<{ message: string; documentId: string }> {
  const company = await enabledCompany(admin, scope);
  if (!isCompanyDocPath(company.organizationId, company.companyId, input.path)) throw new ValidationError("Upload the file again.");
  if (!DOC_TYPES[input.contentType]) throw new ValidationError("Upload a photo (JPG, PNG, HEIC) or a PDF.");
  const deps = complianceDeps();
  const storage = deps.storage(admin);
  if (!(await storage.exists(input.path))) throw new ValidationError("The file didn't finish uploading - try again.");
  const today = localDate(nowMs, company.timeZone);
  const bytes = await storage.download(input.path);
  const reading = bytes ? await deps.read({ bytes, contentType: input.contentType, today, scope: company }) : null;
  const chosenKind = isComplianceKind(input.kind) ? input.kind : null;
  const kind: ComplianceKind = chosenKind ?? (reading?.isComplianceDocument ? reading.kind ?? "other" : "other");
  let holder: HolderPick | null = input.holder ? await holderFrom(admin, company, input.holder) : null;
  if (!holder) {
    const picked = pickHolder({ words: "", holderName: reading?.holderName ?? null, kind }, await holderContext(admin, company));
    holder = picked.holder;
  }
  const filed = await fileDocument(admin, {
    organizationId: company.organizationId,
    companyId: company.companyId,
    kind,
    title: reading?.title ?? null,
    holder,
    holderName: reading?.holderName ?? null,
    issuer: reading?.issuer ?? null,
    number: reading?.number ?? null,
    issuedOn: reading?.issuedOn ?? null,
    expiresOn: reading?.expiresOn ?? null,
    filePath: input.path,
    fileContentType: input.contentType,
    uploadedVia: "settings",
    uploadedBy: actor,
    sourceKey: `upload:${input.path}`,
    aiRead: reading ? { ...reading } : null,
    today,
    nowMs,
  });
  const message = holder
    ? savedLine({ kind, title: filed.doc.title, issuer: filed.doc.issuer, number: filed.doc.number, expiresOn: filed.doc.expires_on, holderLabel: holder.label, today, reminders: company.settings.reminders, replacedCount: filed.replaced.length })
    : "Saved. Pick whose it is below so I know who to remind.";
  return { message: reading ? message : `${message} I couldn't read the file, so fill in the details.`, documentId: filed.doc.id };
}

export interface DocumentPatch {
  kind?: string;
  title?: string | null;
  holder?: HolderChoice;
  issuer?: string | null;
  number?: string | null;
  issuedOn?: string | null;
  expiresOn?: string | null;
  notes?: string | null;
}

export async function updateDocument(admin: AdminClient, scope: Scope, id: string, patch: DocumentPatch, nowMs: number = Date.now()): Promise<void> {
  const company = await enabledCompany(admin, scope);
  const doc = await loadDocument(admin, scope, id);
  if (!doc) throw new UserFacingError("Document not found.", { status: 404 });
  if (patch.kind !== undefined && !isComplianceKind(patch.kind)) throw new ValidationError("Pick what kind of document it is.");
  for (const date of [patch.issuedOn, patch.expiresOn]) if (date && !isDateKey(date)) throw new ValidationError("Use a real date.");
  const today = localDate(nowMs, company.timeZone);
  const db = admin as Db;
  // Plain fields first (nulls clear them).
  const plain: Record<string, unknown> = {};
  if (patch.issuer !== undefined) plain.issuer = patch.issuer?.trim().slice(0, 80) || null;
  if (patch.number !== undefined) plain.number = patch.number?.trim().slice(0, 40) || null;
  if (patch.issuedOn !== undefined) plain.issued_on = patch.issuedOn || null;
  if (patch.notes !== undefined) plain.notes = patch.notes?.trim().slice(0, 1000) || null;
  if (patch.title !== undefined) plain.title = patch.title?.trim().slice(0, 60) || null;
  if (patch.expiresOn === null || patch.expiresOn === "") {
    plain.expires_on = null;
    plain.reminded_30_at = null;
    plain.reminded_7_at = null;
    plain.reminded_0_at = null;
    if (doc.status !== "pending" && doc.status !== "replaced") plain.status = "current";
  }
  if (Object.keys(plain).length) {
    const { error } = await db.from("compliance_documents").update(plain).eq("id", doc.id).eq("organization_id", scope.organizationId).eq("company_id", scope.companyId);
    if (error) throw error;
  }
  const holderChange = patch.holder ? await holderFrom(admin, company, patch.holder) : null;
  const needsAssign = holderChange || (patch.kind && patch.kind !== doc.kind) || (patch.expiresOn && patch.expiresOn !== doc.expires_on);
  if (!needsAssign) return;
  const current = (await loadDocument(admin, scope, id)) ?? doc;
  const holder: HolderPick | null =
    holderChange ??
    (current.holder_type === "company"
      ? COMPANY_HOLDER
      : current.holder_type === "crew"
        ? { type: "crew", profileId: current.profile_id, subcontractorId: null, label: "crew" }
        : current.holder_type === "subcontractor"
          ? { type: "subcontractor", profileId: null, subcontractorId: current.subcontractor_id, label: "sub" }
          : null);
  if (!holder) {
    // Still pending: keep the details; it's filed once a holder is picked.
    const still: Record<string, unknown> = {};
    if (patch.kind && isComplianceKind(patch.kind)) still.kind = patch.kind;
    if (patch.expiresOn) still.expires_on = patch.expiresOn;
    if (Object.keys(still).length) await db.from("compliance_documents").update(still).eq("id", doc.id).eq("company_id", scope.companyId);
    return;
  }
  await assignHolder(admin, current, holder, { kind: isComplianceKind(patch.kind) ? patch.kind : null, expiresOn: patch.expiresOn || null }, today, nowMs);
}

export async function deleteDocument(admin: AdminClient, scope: Scope, id: string, actor: string): Promise<void> {
  const doc = await loadDocument(admin, scope, id);
  if (!doc) throw new UserFacingError("Document not found.", { status: 404 });
  const db = admin as Db;
  // An older document this one had replaced comes back.
  await db.from("compliance_documents").update({ status: "current", replaced_by: null }).eq("company_id", scope.companyId).eq("replaced_by", doc.id);
  const { error } = await db.from("compliance_documents").delete().eq("id", doc.id).eq("organization_id", scope.organizationId).eq("company_id", scope.companyId);
  if (error) throw error;
  if (doc.file_path) {
    try {
      await complianceDeps().storage(admin).remove([doc.file_path]);
    } catch (err) {
      console.error("[compliance] could not delete the file:", err instanceof Error ? err.message : err);
    }
  }
  await logEvent(admin, { organizationId: scope.organizationId, companyId: scope.companyId, event: "document_deleted", documentId: doc.id, actor, detail: { kind: doc.kind } });
}

export async function documentFileUrl(admin: AdminClient, scope: Scope, id: string, actor: string): Promise<string> {
  const doc = await loadDocument(admin, scope, id);
  if (!doc?.file_path) throw new UserFacingError("No file for that document.", { status: 404 });
  const url = await complianceDeps().storage(admin).signedUrl(doc.file_path, 120, null);
  if (!url) throw new UserFacingError("Couldn't open that file - try again.", { status: 502 });
  await logEvent(admin, { organizationId: scope.organizationId, companyId: scope.companyId, event: "document_viewed", documentId: doc.id, actor });
  return url;
}

export async function saveSub(admin: AdminClient, scope: Scope, id: string | null, input: SubInput): Promise<SubcontractorRow> {
  await enabledCompany(admin, scope);
  if (!id) return createSub(admin, scope, input);
  const row = await updateSub(admin, scope, id, input);
  if (!row) throw new UserFacingError("Sub not found.", { status: 404 });
  return row;
}

export async function revokeShareFromSettings(admin: AdminClient, scope: Scope, shareId: string, actor: string, nowMs: number = Date.now()): Promise<number> {
  return revokeShares(admin, scope, { shareId }, actor, nowMs);
}
