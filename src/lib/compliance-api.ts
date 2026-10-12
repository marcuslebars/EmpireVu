/**
 * Compliance (docs/ai-staff.md → "Compliance"): the Settings section and a sub's upload page
 * (/compliance/upload/:token, public — the token is the credential).
 */
import { ApiError, apiFetch, resolveApiUrl } from "@/lib/api-client";
import { toJpeg } from "@/lib/jobs-api";
import { supabase } from "@/lib/supabase";

export type ComplianceKind =
  | "liability_insurance"
  | "wsib_clearance"
  | "wsib_account"
  | "vehicle_insurance"
  | "trade_licence"
  | "business_licence"
  | "certification"
  | "bond"
  | "other";

export const KIND_OPTIONS: Array<{ value: ComplianceKind; label: string }> = [
  { value: "liability_insurance", label: "Liability insurance" },
  { value: "wsib_clearance", label: "WSIB clearance" },
  { value: "wsib_account", label: "WSIB account" },
  { value: "vehicle_insurance", label: "Vehicle insurance" },
  { value: "trade_licence", label: "Trade licence" },
  { value: "business_licence", label: "Business licence" },
  { value: "certification", label: "Certification / ticket" },
  { value: "bond", label: "Bond" },
  { value: "other", label: "Other" },
];

export type DocStatus = "pending" | "current" | "expiring" | "expired" | "replaced";
export type HolderChoice = { type: "company" } | { type: "crew"; profileId: string } | { type: "subcontractor"; subcontractorId: string };

export interface ComplianceDocument {
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
  status: DocStatus;
  uploadedVia: "sms" | "settings" | "sub_link";
  hasFile: boolean;
  notes: string | null;
  createdAt: string;
}

export interface ComplianceSub {
  id: string;
  name: string;
  businessName: string | null;
  contactName: string | null;
  trade: string | null;
  phone: string | null;
  email: string | null;
  notes: string | null;
  active: boolean;
  clearance: "current" | "expiring" | "expired" | "missing";
}

export interface ComplianceView {
  companyId: string;
  settings: { enabled: boolean; enabledIsDefault: boolean; defaultEnabled: boolean; reminders: boolean; sharing: boolean };
  ownerPhoneVerified: boolean;
  documents: ComplianceDocument[] | null;
  crew: Array<{ profileId: string; name: string }> | null;
  subs: ComplianceSub[] | null;
  shares: Array<{ id: string; customer: string; document: string; status: string; sentAt: string | null; expiresAt: string; opens: number; lastOpenedAt: string | null; live: boolean }> | null;
  requests: Array<{ id: string; sub: string; status: string; sentAt: string | null; expiresAt: string; uploads: number; live: boolean }> | null;
  counts: { documents: number; expiring: number; expired: number; pending: number };
  message?: string;
}

export interface SubInput {
  id?: string | null;
  name?: string | null;
  businessName?: string | null;
  trade?: string | null;
  phone?: string | null;
  email?: string | null;
  notes?: string | null;
  active?: boolean;
}

export interface DocumentPatch {
  kind?: ComplianceKind;
  title?: string | null;
  holder?: HolderChoice;
  issuer?: string | null;
  number?: string | null;
  issuedOn?: string | null;
  expiresOn?: string | null;
  notes?: string | null;
}

const settingsPath = (orgId: string, companyId: string) => `/api/organizations/${orgId}/companies/${companyId}/ai-settings/compliance`;
const post = <T>(orgId: string, companyId: string, body: Record<string, unknown>) => apiFetch<T>(settingsPath(orgId, companyId), { method: "POST", body: JSON.stringify(body) });

export const fetchComplianceSettings = (orgId: string, companyId: string) => apiFetch<ComplianceView>(settingsPath(orgId, companyId));
export const patchComplianceSettings = (orgId: string, companyId: string, patch: { enabled?: boolean; reminders?: boolean; sharing?: boolean }) =>
  apiFetch<ComplianceView>(settingsPath(orgId, companyId), { method: "PATCH", body: JSON.stringify(patch) });
export const updateComplianceDocument = (orgId: string, companyId: string, id: string, patch: DocumentPatch) => post<ComplianceView>(orgId, companyId, { action: "update_doc", id, ...patch });
export const deleteComplianceDocument = (orgId: string, companyId: string, id: string) => post<ComplianceView>(orgId, companyId, { action: "delete_doc", id });
export const complianceFileUrl = (orgId: string, companyId: string, id: string) => post<{ url: string }>(orgId, companyId, { action: "file_url", id });
export const saveComplianceSub = (orgId: string, companyId: string, sub: SubInput) => post<ComplianceView>(orgId, companyId, { action: "save_sub", ...sub });
export const revokeComplianceShare = (orgId: string, companyId: string, id: string) => post<ComplianceView>(orgId, companyId, { action: "revoke_share", id });

const DOC_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);

/** A photo → JPEG (resized, EXIF stripped) when the browser can read it; a PDF as-is. ≤10 MB. */
async function prepareFile(file: File): Promise<{ blob: Blob; contentType: string }> {
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  if (isPdf) return { blob: file, contentType: "application/pdf" };
  try {
    return { blob: (await toJpeg(file)).blob, contentType: "image/jpeg" };
  } catch {
    return { blob: file, contentType: file.type };
  }
}

async function putFile(upload: { bucket: string; path: string; token: string }, blob: Blob, contentType: string): Promise<void> {
  if (!supabase) throw new Error("Uploads aren't available right now - try again later.");
  const { error } = await supabase.storage.from(upload.bucket).uploadToSignedUrl(upload.path, upload.token, blob, { contentType, upsert: false });
  if (error) throw new Error(error.message || "Upload failed - try again.");
}

function checkFile(blob: Blob, contentType: string): void {
  if (!DOC_TYPES.has(contentType)) throw new Error("Use a photo (JPG, PNG, HEIC) or a PDF.");
  if (blob.size > 10 * 1024 * 1024) throw new Error("That file is over 10 MB - try a photo instead.");
}

/** Settings: upload straight to the private bucket, then file it (the server reads it). */
export async function uploadComplianceDocument(orgId: string, companyId: string, file: File, options: { holder?: HolderChoice | null; kind?: ComplianceKind | null } = {}): Promise<ComplianceView> {
  const { blob, contentType } = await prepareFile(file);
  checkFile(blob, contentType);
  const upload = await post<{ bucket: string; path: string; token: string }>(orgId, companyId, { action: "upload_url", contentType });
  await putFile(upload, blob, contentType);
  return post<ComplianceView>(orgId, companyId, { action: "file_upload", path: upload.path, contentType, holder: options.holder ?? null, kind: options.kind ?? null });
}

// ── The sub's page ───────────────────────────────────────────────────────────────────

export interface SubUploadView {
  businessName: string;
  subName: string;
  asked: Array<{ kind: ComplianceKind; label: string }>;
  expiresAt: string;
  uploads: Array<{ label: string; expiresOn: string | null; at: string }>;
  canUpload: boolean;
}

async function publicCall<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(resolveApiUrl(path), { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const body: unknown = await res.json().catch(() => undefined);
  if (!res.ok) {
    const message =
      body && typeof body === "object" && "error" in body && typeof (body as { error: unknown }).error === "string"
        ? (body as { error: string }).error
        : "Something went wrong. Please try again.";
    throw new ApiError(res.status, message, body);
  }
  return (body as { data: T }).data;
}

const publicBase = (token: string) => `/api/public/compliance/upload/${encodeURIComponent(token)}`;

export const fetchSubUploadPage = (token: string) => publicCall<SubUploadView>(publicBase(token));

export async function uploadSubDocument(token: string, file: File, kind: ComplianceKind | null): Promise<{ result: { label: string; expiresOn: string | null; read: boolean }; view: SubUploadView | null }> {
  const { blob, contentType } = await prepareFile(file);
  checkFile(blob, contentType);
  const upload = await publicCall<{ bucket: string; path: string; token: string }>(publicBase(token), { method: "POST", body: JSON.stringify({ action: "upload_url", contentType }) });
  await putFile(upload, blob, contentType);
  return publicCall(publicBase(token), { method: "POST", body: JSON.stringify({ action: "submit", path: upload.path, contentType, kind }) });
}
