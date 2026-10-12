/**
 * Receipt pictures and PDFs the owner texted (Twilio MMS). The same guard as sms-agent/media.ts
 * (only Twilio's media host, every redirect hop re-checked, the account's Basic auth only on the
 * first request to Twilio's API host) but it also takes PDFs and larger files (10 MB, the
 * expense-receipts limit). Never throws: anything it can't fetch is skipped.
 */
import type { InboundMedia } from "@/server/services/front-desk/contracts";
import { isTwilioMediaRedirect, isTwilioMediaUrl } from "@/server/services/sms-agent/media";

export const RECEIPT_MEDIA_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"] as const;
export type ReceiptMediaType = (typeof RECEIPT_MEDIA_TYPES)[number];

export const MAX_RECEIPT_MEDIA_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 2;

export interface FetchedReceiptMedia {
  /** Position in the text's media list (the idempotency key with the log id). */
  index: number;
  type: ReceiptMediaType;
  bytes: Buffer;
}

export function receiptMediaType(raw: string | null | undefined): ReceiptMediaType | null {
  const type = (raw ?? "").split(";")[0].trim().toLowerCase();
  const fixed = type === "image/jpg" || type === "image/pjpeg" ? "image/jpeg" : type;
  return (RECEIPT_MEDIA_TYPES as readonly string[]).includes(fixed) ? (fixed as ReceiptMediaType) : null;
}

export type ReceiptMediaFetcher = (media: InboundMedia[], options?: { max?: number }) => Promise<FetchedReceiptMedia[]>;

export function makeReceiptMediaFetcher(doFetch: typeof fetch = fetch, timeoutMs = 15_000): ReceiptMediaFetcher {
  return async (media, options = {}) => {
    const max = options.max ?? 3;
    const sid = process.env.TWILIO_ACCOUNT_SID?.trim();
    const token = process.env.TWILIO_AUTH_TOKEN?.trim();
    const auth = sid && token ? `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}` : null;
    const out: FetchedReceiptMedia[] = [];
    for (let index = 0; index < media.length && out.length < max; index++) {
      const item = media[index];
      if (!item?.url || !isTwilioMediaUrl(item.url)) continue;
      if (item.contentType && !receiptMediaType(item.contentType)) continue;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        let url = item.url;
        let response = await doFetch(url, { headers: auth ? { Authorization: auth } : undefined, redirect: "manual", signal: controller.signal });
        for (let hop = 0; hop < MAX_REDIRECTS && response.status >= 300 && response.status < 400; hop++) {
          const location = response.headers.get("location");
          const next = location ? new URL(location, url).toString() : null;
          if (!next || !isTwilioMediaRedirect(next)) {
            response = new Response(null, { status: 502 });
            break;
          }
          url = next;
          response = await doFetch(url, { redirect: "manual", signal: controller.signal });
        }
        if (!response.ok) continue;
        const type = receiptMediaType(response.headers.get("content-type") ?? item.contentType);
        if (!type) continue;
        if (Number(response.headers.get("content-length") ?? "0") > MAX_RECEIPT_MEDIA_BYTES) continue;
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.byteLength === 0 || bytes.byteLength > MAX_RECEIPT_MEDIA_BYTES) continue;
        out.push({ index, type, bytes });
      } catch (err) {
        console.warn("[tax-clerk] media fetch failed:", err instanceof Error ? err.message : err);
      } finally {
        clearTimeout(timer);
      }
    }
    return out;
  };
}
