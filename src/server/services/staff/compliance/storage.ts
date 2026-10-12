/**
 * SANCTIONED EXCEPTION (service role): the private `compliance-docs` bucket (certificates,
 * policies, licences). The bucket has no storage policies, so nobody reads it with their own
 * session. Every path is built here by the server:
 *
 *   {org}/{company}/doc-{uuid}.{ext}             owner texts / Settings uploads
 *   {org}/{company}/sub-{requestId}-{uuid}.{ext} a sub's upload link
 *
 * Behind the ComplianceStorage seam so tests never touch Supabase Storage.
 */
import { randomUUID } from "node:crypto";

import type { AdminClient } from "@/server/services/front-desk/contracts";

export const COMPLIANCE_BUCKET = "compliance-docs";
export const MAX_DOC_BYTES = 10 * 1024 * 1024;

export const DOC_TYPES: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/heic": "heic",
  "image/heif": "heif",
};

export function normalizeDocType(raw: string | null | undefined): string | null {
  const t = (raw ?? "").split(";")[0].trim().toLowerCase();
  const fixed = t === "image/jpg" ? "image/jpeg" : t;
  return DOC_TYPES[fixed] ? fixed : null;
}

export interface ComplianceStorage {
  upload(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  download(path: string): Promise<Uint8Array | null>;
  createUploadUrl(path: string): Promise<{ path: string; token: string }>;
  exists(path: string): Promise<boolean>;
  /** A short-lived read URL (seconds). */
  signedUrl(path: string, ttlSeconds: number, downloadName?: string | null): Promise<string | null>;
  remove(paths: string[]): Promise<void>;
}

export function companyFolder(organizationId: string, companyId: string): string {
  return `${organizationId}/${companyId}/`;
}

export function docPathFor(organizationId: string, companyId: string, contentType: string): string | null {
  const ext = DOC_TYPES[contentType];
  return ext ? `${companyFolder(organizationId, companyId)}doc-${randomUUID()}.${ext}` : null;
}

export function subUploadPathFor(organizationId: string, companyId: string, requestId: string, contentType: string): string | null {
  const ext = DOC_TYPES[contentType];
  return ext ? `${companyFolder(organizationId, companyId)}sub-${requestId}-${randomUUID()}.${ext}` : null;
}

/** A path the server made for this company (and, for a sub link, this request). */
export function isCompanyDocPath(organizationId: string, companyId: string, path: string | null | undefined, requestId?: string): path is string {
  if (!path) return false;
  const folder = companyFolder(organizationId, companyId);
  if (!path.startsWith(folder)) return false;
  const name = path.slice(folder.length);
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return false;
  return requestId ? name.startsWith(`sub-${requestId}-`) : name.startsWith("doc-");
}

export function supabaseComplianceStorage(admin: AdminClient): ComplianceStorage {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bucket = () => (admin as any).storage.from(COMPLIANCE_BUCKET);
  return {
    async upload(path, bytes, contentType) {
      // Never overwrite: every path is fresh, and a filed file must not be replaceable.
      const { error } = await bucket().upload(path, bytes, { contentType, upsert: false });
      if (error) throw error;
    },
    async download(path) {
      const { data, error } = await bucket().download(path);
      if (error || !data) return null;
      return new Uint8Array(await (data as Blob).arrayBuffer());
    },
    async createUploadUrl(path) {
      // upsert: false — a still-valid token can't overwrite a file that's already been filed.
      const { data, error } = await bucket().createSignedUploadUrl(path, { upsert: false });
      if (error || !data) throw error ?? new Error("Could not create an upload URL.");
      return { path, token: data.token as string };
    },
    async exists(path) {
      const slash = path.lastIndexOf("/");
      const { data, error } = await bucket().list(path.slice(0, slash), { search: path.slice(slash + 1), limit: 1 });
      if (error) throw error;
      return ((data ?? []) as Array<{ name: string }>).some((o) => o.name === path.slice(slash + 1));
    },
    async signedUrl(path, ttlSeconds, downloadName) {
      const { data, error } = await bucket().createSignedUrl(path, ttlSeconds, downloadName ? { download: downloadName } : undefined);
      if (error || !data?.signedUrl) return null;
      return data.signedUrl as string;
    },
    async remove(paths) {
      if (paths.length === 0) return;
      const { error } = await bucket().remove(paths);
      if (error) throw error;
    },
  };
}
