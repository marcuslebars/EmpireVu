/**
 * SANCTIONED EXCEPTION (service role): receipt files the owner TEXTED in, in the existing private
 * `expense-receipts` bucket (same path rule as expenses/receipts.ts: {organizationId}/{uuid}.jpg|pdf,
 * checked by receiptTypeOfPath before every call). Behind a seam so tests never touch Storage.
 *
 *   upload      store a new receipt (jpeg as is; PDFs and PNGs-wrapped-in-a-PDF as pdf)
 *   signedUrls  read links for the accountant packet (30 days)
 *   remove      best effort, for a receipt deleted by "fix: delete" or a discarded review
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { RECEIPTS_BUCKET } from "@/server/services/expenses/receipts";
import { receiptTypeOfPath, type ReceiptType } from "@/server/services/expenses/rules";

export const PACKET_LINK_TTL_SECONDS = 30 * 86_400;

export interface ReceiptStorage {
  upload(organizationId: string, path: string, bytes: Uint8Array, type: ReceiptType): Promise<void>;
  signedUrls(organizationId: string, paths: string[], ttlSeconds: number): Promise<Map<string, string>>;
  remove(organizationId: string, path: string): Promise<void>;
}

function own(organizationId: string, path: string): boolean {
  return receiptTypeOfPath(organizationId, path) !== null;
}

export function supabaseReceiptStorage(admin: AdminClient): ReceiptStorage {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bucket = () => (admin as any).storage.from(RECEIPTS_BUCKET);
  return {
    async upload(organizationId, path, bytes, type) {
      if (!own(organizationId, path)) throw new Error("receipt path outside the organization");
      const { error } = await bucket().upload(path, bytes, { contentType: type, upsert: false });
      if (error) throw error;
    },
    async signedUrls(organizationId, paths, ttlSeconds) {
      const mine = [...new Set(paths.filter((p) => own(organizationId, p)))];
      const out = new Map<string, string>();
      if (mine.length === 0) return out;
      const { data, error } = await bucket().createSignedUrls(mine, ttlSeconds);
      if (error) {
        console.error("[tax-clerk] could not sign receipt URLs:", error.message);
        return out;
      }
      for (const entry of (data ?? []) as Array<{ path: string | null; signedUrl: string | null }>) if (entry.path && entry.signedUrl) out.set(entry.path, entry.signedUrl);
      return out;
    },
    async remove(organizationId, path) {
      if (!own(organizationId, path)) return;
      try {
        const { error } = await bucket().remove([path]);
        if (error) console.error("[tax-clerk] could not remove receipt:", error.message);
      } catch (err) {
        console.error("[tax-clerk] could not remove receipt:", err instanceof Error ? err.message : err);
      }
    },
  };
}
