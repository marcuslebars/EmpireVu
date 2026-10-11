/**
 * Keep your number (docs/ai-staff.md → "Keep your number"): the owner's /port/:token form (public,
 * the token is the credential), the Settings section, and the concierge porting queue.
 */
import { ApiError, apiFetch, resolveApiUrl } from "@/lib/api-client";
import { toJpeg } from "@/lib/jobs-api";
import { supabase } from "@/lib/supabase";

export type PortStatus = "collecting" | "ready" | "submitted" | "foc_scheduled" | "completed" | "rejected" | "cancelled";
export type PinStatus = "none" | "stored" | "call";

export interface ServiceAddress {
  line1: string;
  line2: string | null;
  city: string;
  province: string;
  postalCode: string;
  country: "CA" | "US";
}

export interface PortFormView {
  businessName: string;
  status: PortStatus;
  statusLabel: string;
  editable: boolean;
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

export interface PortFormAnswers {
  numbers: string[];
  carrier: string;
  businessName: string;
  authorizedName: string;
  serviceAddress: ServiceAddress;
  accountNumber?: string | null;
  pin?: string | null;
  noPin?: boolean;
  billPath?: string | null;
  billContentType?: string | null;
  billIsRecent: true;
  signature: { typedName: string; agree: true };
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

const publicBase = (token: string) => `/api/public/port/${encodeURIComponent(token)}`;

export function fetchPortForm(token: string): Promise<PortFormView> {
  return publicCall<PortFormView>(publicBase(token));
}

export function submitPortForm(token: string, answers: PortFormAnswers): Promise<PortFormView> {
  return publicCall<PortFormView>(publicBase(token), { method: "POST", body: JSON.stringify(answers) });
}

const BILL_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);

/** A photo → JPEG (resized, EXIF stripped) when the browser can read it; a PDF as-is. ≤10 MB. */
export async function uploadPortBill(token: string, file: File): Promise<{ path: string; contentType: string }> {
  if (!supabase) throw new Error("Uploads aren't available right now - try again later.");
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  let blob: Blob = file;
  let contentType = isPdf ? "application/pdf" : file.type;
  if (!isPdf) {
    try {
      blob = (await toJpeg(file)).blob;
      contentType = "image/jpeg";
    } catch {
      blob = file;
    }
  }
  if (!BILL_TYPES.has(contentType)) throw new Error("Use a photo (JPG, PNG, HEIC) or a PDF of the bill.");
  if (blob.size > 10 * 1024 * 1024) throw new Error("That file is over 10 MB - try a photo instead.");
  const upload = await publicCall<{ path: string; token: string; bucket: string }>(`${publicBase(token)}/upload`, {
    method: "POST",
    body: JSON.stringify({ contentType }),
  });
  const { error } = await supabase.storage.from(upload.bucket).uploadToSignedUrl(upload.path, upload.token, blob, { contentType, upsert: true });
  if (error) throw new Error(error.message || "Upload failed - try again.");
  return { path: upload.path, contentType };
}

// ── Settings ─────────────────────────────────────────────────────────────────

export interface RingSettings {
  enabled: boolean;
  seconds: number;
  crew: boolean;
  screen: boolean;
}

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
  ownerCanCancel: boolean;
}

export interface PortingSettingsView {
  companyId: string;
  enabled: boolean;
  enabledIsDefault: boolean;
  defaultEnabled: boolean;
  ring: RingSettings;
  ownerPhone: string | null;
  ownerPhoneVerified: boolean;
  businessLine: string | null;
  businessLineIsCell: boolean;
  collectsAccountDetails: boolean;
  port: PortSummary | null;
  portedLines: string[];
  crewWithCells: number;
  started?: { url: string; texted: boolean };
}

export interface PortingSettingsPatch {
  enabled?: boolean;
  ring?: Partial<RingSettings>;
}

const settingsPath = (orgId: string, companyId: string) => `/api/organizations/${orgId}/companies/${companyId}/ai-settings/porting`;

export const fetchPortingSettings = (orgId: string, companyId: string) => apiFetch<PortingSettingsView>(settingsPath(orgId, companyId));
export const patchPortingSettings = (orgId: string, companyId: string, patch: PortingSettingsPatch) =>
  apiFetch<PortingSettingsView>(settingsPath(orgId, companyId), { method: "PATCH", body: JSON.stringify(patch) });
export const startNumberPort = (orgId: string, companyId: string) =>
  apiFetch<PortingSettingsView>(settingsPath(orgId, companyId), { method: "POST", body: JSON.stringify({ action: "start" }) });
export const cancelNumberPort = (orgId: string, companyId: string, portId: string) =>
  apiFetch<PortingSettingsView>(settingsPath(orgId, companyId), { method: "POST", body: JSON.stringify({ action: "cancel", portId }) });

// ── Concierge ────────────────────────────────────────────────────────────────

export interface TwilioFormField {
  label: string;
  value: string;
  copy: boolean;
}

export interface OperatorPortView {
  id: string;
  organizationId: string;
  companyId: string;
  companyName: string;
  status: PortStatus;
  statusLabel: string;
  ownerPhone: string | null;
  numbers: string[];
  createdAt: string;
  readyAt: string | null;
  submittedAt: string | null;
  focDate: string | null;
  focDateText: string | null;
  twilioPortRequestId: string | null;
  rejectionReason: string | null;
  pinStatus: PinStatus;
  accountLast4: string | null;
  secretsPurged: boolean;
  hasLoa: boolean;
  hasBill: boolean;
  loaSignedAt: string | null;
  billUploadedAt: string | null;
  warnings: string[];
  twilioForm: TwilioFormField[];
}

export const fetchOperatorPorts = () => apiFetch<OperatorPortView[]>("/api/concierge/ports", { credentials: "include" });
export const fetchPortFileUrl = (portId: string, kind: "loa" | "bill") =>
  apiFetch<{ url: string }>(`/api/concierge/ports/${encodeURIComponent(portId)}/files/${kind}`, { credentials: "include" });
