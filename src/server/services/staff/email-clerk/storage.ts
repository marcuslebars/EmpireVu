/**
 * SANCTIONED EXCEPTION (service role): the private `email-attachments` bucket. No storage
 * policies, so nobody reads it with their own session; the app gets short signed URLs from the
 * server. Every path is built here by the server, never from the email:
 *
 *   {org}/{company}/{inboundEmailId}/{uuid}.{ext}
 *
 * Only an allowlist of types is kept (PDF, pictures, plain text / CSV, Word, Excel), ≤ 10 MB
 * each. Behind the AttachmentStorage seam so tests never touch Supabase Storage.
 */
import { randomUUID } from "node:crypto";

import type { AdminClient } from "@/server/services/front-desk/contracts";

export const ATTACHMENTS_BUCKET = "email-attachments";
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** At most this many files are kept per email. */
export const MAX_ATTACHMENTS = 10;

export const ATTACHMENT_TYPES: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/heic": "heic",
  "image/heif": "heif",
  "text/plain": "txt",
  "text/csv": "csv",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
};

/** "image/JPG; name=x" → "image/jpeg"; anything off the list → null. PURE. */
export function normalizeAttachmentType(raw: string | null | undefined): string | null {
  const t = (raw ?? "").split(";")[0].trim().toLowerCase();
  const fixed = t === "image/jpg" ? "image/jpeg" : t;
  return ATTACHMENT_TYPES[fixed] ? fixed : null;
}

export function attachmentPathFor(organizationId: string, companyId: string, inboundEmailId: string, contentType: string): string | null {
  const ext = ATTACHMENT_TYPES[contentType];
  return ext ? `${organizationId}/${companyId}/${inboundEmailId}/${randomUUID()}.${ext}` : null;
}

/** A path the server made for this company. PURE. */
export function isCompanyAttachmentPath(organizationId: string, companyId: string, path: string | null | undefined): path is string {
  if (!path) return false;
  const prefix = `${organizationId}/${companyId}/`;
  return path.startsWith(prefix) && /^[A-Za-z0-9-]{1,64}\/[0-9a-f-]{36}\.[a-z]{3,4}$/.test(path.slice(prefix.length));
}

export interface AttachmentStorage {
  upload(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  signedUrl(path: string, ttlSeconds: number, downloadName?: string | null): Promise<string | null>;
}

export function supabaseAttachmentStorage(admin: AdminClient): AttachmentStorage {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bucket = () => (admin as any).storage.from(ATTACHMENTS_BUCKET);
  return {
    async upload(path, bytes, contentType) {
      const { error } = await bucket().upload(path, bytes, { contentType, upsert: false });
      if (error) throw error;
    },
    async signedUrl(path, ttlSeconds, downloadName) {
      const { data, error } = await bucket().createSignedUrl(path, ttlSeconds, downloadName ? { download: downloadName } : undefined);
      if (error || !data?.signedUrl) return null;
      return data.signedUrl as string;
    },
  };
}
