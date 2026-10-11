/**
 * SANCTIONED EXCEPTION (service role): the private `porting-docs` bucket (phone bill + signed LOA).
 * The bucket has no storage policies, so nobody reads it with their own session. Every path is
 * `{organizationId}/{portId}/…` and every function refuses a path outside its port's folder.
 * Behind the PortingStorage seam so tests never touch Supabase Storage.
 */
import { randomUUID } from "node:crypto";

import type { AdminClient } from "@/server/services/front-desk/contracts";

export const PORTING_BUCKET = "porting-docs";
export const MAX_BILL_BYTES = 10 * 1024 * 1024;
const READ_URL_TTL_SECONDS = 120;

export const BILL_TYPES: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
};

export interface PortingStorage {
  createUploadUrl(path: string): Promise<{ path: string; token: string }>;
  exists(path: string): Promise<boolean>;
  upload(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  signedUrl(path: string, downloadName: string): Promise<string | null>;
  remove(paths: string[]): Promise<void>;
}

export function portFolder(organizationId: string, portId: string): string {
  return `${organizationId}/${portId}/`;
}

export function isPortPath(organizationId: string, portId: string, path: string | null | undefined): path is string {
  if (!path) return false;
  const folder = portFolder(organizationId, portId);
  return path.startsWith(folder) && /^[A-Za-z0-9._-]+$/.test(path.slice(folder.length));
}

export function billPathFor(organizationId: string, portId: string, contentType: string): string | null {
  const ext = BILL_TYPES[contentType];
  return ext ? `${portFolder(organizationId, portId)}bill-${randomUUID()}.${ext}` : null;
}

export function loaPathFor(organizationId: string, portId: string, signedAtMs: number): string {
  return `${portFolder(organizationId, portId)}loa-${signedAtMs}.pdf`;
}

/** The real bucket, through the service-role client. */
export function supabasePortingStorage(admin: AdminClient): PortingStorage {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bucket = () => (admin as any).storage.from(PORTING_BUCKET);
  return {
    async createUploadUrl(path) {
      const { data, error } = await bucket().createSignedUploadUrl(path, { upsert: true });
      if (error || !data) throw error ?? new Error("Could not create an upload URL.");
      return { path, token: data.token as string };
    },
    async exists(path) {
      const slash = path.lastIndexOf("/");
      const { data, error } = await bucket().list(path.slice(0, slash), { search: path.slice(slash + 1), limit: 1 });
      if (error) throw error;
      return ((data ?? []) as Array<{ name: string }>).some((o) => o.name === path.slice(slash + 1));
    },
    async upload(path, bytes, contentType) {
      const { error } = await bucket().upload(path, bytes, { contentType, upsert: true });
      if (error) throw error;
    },
    async signedUrl(path, downloadName) {
      const { data, error } = await bucket().createSignedUrl(path, READ_URL_TTL_SECONDS, { download: downloadName });
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
