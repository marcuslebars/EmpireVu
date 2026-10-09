/**
 * Picture messages (MMS) → image blocks for the model. Fetched server-side with the account's
 * Basic auth (Twilio media URLs require it). Only Twilio's media host, only images the model
 * reads (jpeg/png/gif/webp), at most a few per turn and a size cap each — anything else is
 * skipped (the model is told a picture was attached either way).
 */
import type { InboundMedia } from "@/server/services/front-desk/contracts";

export const SUPPORTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
export type SupportedImageType = (typeof SUPPORTED_IMAGE_TYPES)[number];

export interface FetchedImage {
  mediaType: SupportedImageType;
  base64: string;
  bytes: number;
}

export interface MediaFetchOptions {
  maxImages?: number;
  maxBytes?: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const ALLOWED_HOSTS = new Set(["api.twilio.com", "media.twiliocdn.com"]);

/** Only https Twilio media URLs (an SSRF guard — the URL arrived in a webhook payload). */
export function isTwilioMediaUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && ALLOWED_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Where a Twilio media URL may redirect to (its CDN): *.twiliocdn.com, or the S3 bucket behind
 * it. Checked on every hop; the account's Authorization header is only ever sent to Twilio's
 * own API host, never to a redirect target.
 */
export function isTwilioMediaRedirect(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return false;
    if (url.hostname === "media.twiliocdn.com" || url.hostname.endsWith(".twiliocdn.com")) return true;
    return /^s3[a-z0-9.-]*\.amazonaws\.com$/.test(url.hostname) && url.pathname.startsWith("/media.twiliocdn.com/");
  } catch {
    return false;
  }
}

const MAX_REDIRECTS = 2;

function normalizeType(raw: string | null): SupportedImageType | null {
  const type = (raw ?? "").split(";")[0].trim().toLowerCase();
  const fixed = type === "image/jpg" ? "image/jpeg" : type;
  return (SUPPORTED_IMAGE_TYPES as readonly string[]).includes(fixed) ? (fixed as SupportedImageType) : null;
}

/** Download up to `maxImages` images. Never throws; failures are logged and skipped. */
export async function fetchMmsImages(media: InboundMedia[], options: MediaFetchOptions = {}): Promise<FetchedImage[]> {
  const maxImages = options.maxImages ?? 3;
  const maxBytes = options.maxBytes ?? 3_500_000;
  const doFetch = options.fetchImpl ?? fetch;
  const sid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const token = process.env.TWILIO_AUTH_TOKEN?.trim();
  const auth = sid && token ? `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}` : null;
  const out: FetchedImage[] = [];

  for (const item of media) {
    if (out.length >= maxImages) break;
    if (!item?.url || !isTwilioMediaUrl(item.url)) continue;
    if (item.contentType && !normalizeType(item.contentType)) continue;
    // One deadline for headers + body.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
    try {
      // Follow redirects by hand: re-check every hop's host, and send the account's Basic auth
      // only on the first request to Twilio's API host — never to a redirect target.
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
      if (!response.ok) {
        console.warn(`[sms-agent] media fetch ${response.status} for ${new URL(item.url).pathname}`);
        continue;
      }
      const mediaType = normalizeType(response.headers.get("content-type") ?? item.contentType);
      if (!mediaType) continue;
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (declared > maxBytes) continue;
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength === 0 || buffer.byteLength > maxBytes) continue;
      out.push({ mediaType, base64: buffer.toString("base64"), bytes: buffer.byteLength });
    } catch (err) {
      console.warn("[sms-agent] media fetch failed:", err instanceof Error ? err.message : err);
    } finally {
      clearTimeout(timer);
    }
  }
  return out;
}

/** message_log.media (jsonb) → InboundMedia[]. PURE. */
export function readMediaColumn(raw: unknown): InboundMedia[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((m) => m as { url?: unknown; contentType?: unknown })
    .filter((m) => typeof m.url === "string")
    .map((m) => ({ url: m.url as string, contentType: typeof m.contentType === "string" ? m.contentType : null }));
}
