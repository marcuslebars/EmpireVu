/**
 * Client API for crew dispatch: jobs (bookings) with their crew, checklist and field
 * steps, saved checklists, and job photos.
 */
import { ApiError, apiFetch } from "@/lib/api-client";
import { supabase } from "@/lib/supabase";

export type JobStage = "scheduled" | "en_route" | "in_progress" | "done" | "cancelled";

export interface CrewMember {
  profileId: string;
  name: string;
  email: string | null;
}

export interface ChecklistItem {
  id: string;
  label: string;
  position: number;
  doneAt: string | null;
  doneBy: string | null;
}

export interface JobSummary {
  id: string;
  title: string;
  status: "pending" | "confirmed" | "completed" | "cancelled" | "no_show";
  stage: JobStage;
  scheduledFor: string;
  durationMinutes: number;
  location: string | null;
  companyId: string;
  companyName: string | null;
  timeZone: string;
  contactId: string | null;
  contactName: string | null;
  contactPhone: string | null;
  crew: CrewMember[];
  checklist: { done: number; total: number };
  assignedToMe: boolean;
}

export interface JobSheet extends JobSummary {
  description: string | null;
  contactEmail: string | null;
  quoteId: string | null;
  enRouteAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  completedBy: string | null;
  checklistItems: ChecklistItem[];
  invoiceId: string | null;
}

export interface ChecklistTemplate {
  id: string;
  companyId: string;
  name: string;
  items: string[];
  updatedAt: string;
}

export interface JobPhoto {
  id: string;
  bookingId: string;
  url: string | null;
  caption: string | null;
  takenAt: string;
  takenBy: string | null;
  width: number | null;
  height: number | null;
}

export interface FetchJobsOptions {
  scope: "mine" | "all";
  from?: string;
  to?: string;
  companyId?: string | null;
  includeDone?: boolean;
}

const jobs = (orgId: string) => `/api/organizations/${orgId}/jobs`;

export function fetchJobs(orgId: string, opts: FetchJobsOptions): Promise<JobSummary[]> {
  const q = new URLSearchParams({ scope: opts.scope });
  if (opts.from) q.set("from", opts.from);
  if (opts.to) q.set("to", opts.to);
  if (opts.companyId) q.set("companyId", opts.companyId);
  if (opts.includeDone) q.set("includeDone", "true");
  return apiFetch(`${jobs(orgId)}?${q.toString()}`);
}

export function fetchJob(orgId: string, bookingId: string): Promise<JobSheet> {
  return apiFetch(`${jobs(orgId)}/${bookingId}`);
}

export function updateJob(orgId: string, bookingId: string, patch: { location?: string | null; description?: string | null }): Promise<JobSheet> {
  return apiFetch(`${jobs(orgId)}/${bookingId}`, { method: "PATCH", body: JSON.stringify(patch) });
}

export function setJobCrew(orgId: string, bookingId: string, profileIds: string[]): Promise<CrewMember[]> {
  return apiFetch(`${jobs(orgId)}/${bookingId}/crew`, { method: "PUT", body: JSON.stringify({ profileIds }) });
}

export function markJobEnRoute(orgId: string, bookingId: string): Promise<JobSheet> {
  return apiFetch(`${jobs(orgId)}/${bookingId}/en-route`, { method: "POST" });
}

export function startJob(orgId: string, bookingId: string): Promise<JobSheet> {
  return apiFetch(`${jobs(orgId)}/${bookingId}/start`, { method: "POST" });
}

export function completeJob(orgId: string, bookingId: string, force = false): Promise<JobSheet> {
  return apiFetch(`${jobs(orgId)}/${bookingId}/complete`, { method: "POST", body: JSON.stringify({ force }) });
}

/** The server refused "done" because checklist items are open; `openItems` says how many. */
export function checklistIncomplete(error: unknown): number | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const body = error.body as { code?: string; openItems?: number } | undefined;
  return body?.code === "checklist_incomplete" ? (body.openItems ?? 1) : null;
}

export function addChecklistItems(orgId: string, bookingId: string, labels: string[]): Promise<ChecklistItem[]> {
  return apiFetch(`${jobs(orgId)}/${bookingId}/checklist`, { method: "POST", body: JSON.stringify({ labels }) });
}

export function toggleChecklistItem(orgId: string, bookingId: string, itemId: string, done: boolean): Promise<ChecklistItem[]> {
  return apiFetch(`${jobs(orgId)}/${bookingId}/checklist/${itemId}`, { method: "PATCH", body: JSON.stringify({ done }) });
}

export function deleteChecklistItem(orgId: string, bookingId: string, itemId: string): Promise<ChecklistItem[]> {
  return apiFetch(`${jobs(orgId)}/${bookingId}/checklist/${itemId}`, { method: "DELETE" });
}

export function applyChecklistTemplate(orgId: string, bookingId: string, templateId: string): Promise<ChecklistItem[]> {
  return apiFetch(`${jobs(orgId)}/${bookingId}/checklist/apply-template`, { method: "POST", body: JSON.stringify({ templateId }) });
}

const templates = (orgId: string) => `/api/organizations/${orgId}/checklist-templates`;

export function fetchChecklistTemplates(orgId: string, companyId: string): Promise<ChecklistTemplate[]> {
  return apiFetch(`${templates(orgId)}?companyId=${encodeURIComponent(companyId)}`);
}

export function createChecklistTemplate(orgId: string, input: { companyId: string; name: string; items: string[] }): Promise<ChecklistTemplate> {
  return apiFetch(templates(orgId), { method: "POST", body: JSON.stringify(input) });
}

export function updateChecklistTemplate(orgId: string, id: string, input: { name?: string; items?: string[] }): Promise<ChecklistTemplate> {
  return apiFetch(`${templates(orgId)}/${id}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function deleteChecklistTemplate(orgId: string, id: string): Promise<{ ok: true }> {
  return apiFetch(`${templates(orgId)}/${id}`, { method: "DELETE" });
}

// ── Photos (the same store the mobile app uploads to) ────────────────────────

const photos = (orgId: string, bookingId: string) => `/api/organizations/${orgId}/bookings/${bookingId}/photos`;

export function fetchJobPhotos(orgId: string, bookingId: string): Promise<JobPhoto[]> {
  return apiFetch(photos(orgId, bookingId));
}

const MAX_EDGE = 2048;

/** Any image → a JPEG at most 2048px on its long edge (the bucket takes JPEG only; re-encoding drops EXIF/GPS). */
export async function toJpeg(file: Blob): Promise<{ blob: Blob; width: number; height: number }> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext("2d");
  if (!g) throw new Error("This browser can't process photos.");
  g.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.8));
  if (!blob) throw new Error("Couldn't read that photo.");
  return { blob, width, height };
}

export async function uploadJobPhoto(orgId: string, bookingId: string, file: File): Promise<void> {
  if (!supabase) throw new Error("Photo uploads aren't available right now.");
  const { blob, width, height } = await toJpeg(file);
  const photoId = crypto.randomUUID();
  const upload = await apiFetch<{ path: string; token: string }>(`${photos(orgId, bookingId)}/upload-url`, {
    method: "POST",
    body: JSON.stringify({ photoId }),
  });
  const { error } = await supabase.storage
    .from("job-photos")
    .uploadToSignedUrl(upload.path, upload.token, blob, { contentType: "image/jpeg", upsert: true });
  if (error) throw new Error(error.message || "Upload failed.");
  await apiFetch(photos(orgId, bookingId), {
    method: "POST",
    body: JSON.stringify({ path: upload.path, width, height, bytes: blob.size, takenAt: new Date().toISOString() }),
  });
}
