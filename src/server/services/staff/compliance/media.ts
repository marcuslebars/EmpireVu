/**
 * The owner's texted certificate (MMS) → bytes. A sibling of sms-agent/media.ts (which stays
 * images-only): same Twilio Basic auth, same SSRF guard (isTwilioMediaUrl / isTwilioMediaRedirect,
 * auth only on the first request to Twilio's API host), plus PDFs and a 10 MB cap. Never throws.
 */
import type { InboundMedia } from "@/server/services/front-desk/contracts";
import { isTwilioMediaRedirect, isTwilioMediaUrl } from "@/server/services/sms-agent/media";
import { MAX_DOC_BYTES, normalizeDocType } from "./storage";

export interface FetchedDoc {
  bytes: Uint8Array;
  contentType: string;
}

const MAX_REDIRECTS = 2;

/** The first picture or PDF that downloads (≤ 10 MB). Null when there's none. */
export async function fetchComplianceMedia(media: InboundMedia[], options: { fetchImpl?: typeof fetch; timeoutMs?: number; maxBytes?: number } = {}): Promise<FetchedDoc | null> {
  const doFetch = options.fetchImpl ?? fetch;
  const maxBytes = options.maxBytes ?? MAX_DOC_BYTES;
  const sid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const token = process.env.TWILIO_AUTH_TOKEN?.trim();
  const auth = sid && token ? `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}` : null;

  for (const item of media.slice(0, 5)) {
    if (!item?.url || !isTwilioMediaUrl(item.url)) continue;
    if (item.contentType && !normalizeDocType(item.contentType)) continue;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
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
      if (!response.ok) {
        console.warn(`[compliance] media fetch ${response.status}`);
        continue;
      }
      const contentType = normalizeDocType(response.headers.get("content-type") ?? item.contentType);
      if (!contentType) continue;
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (declared > maxBytes) continue;
      const buffer = new Uint8Array(await response.arrayBuffer());
      if (buffer.byteLength === 0 || buffer.byteLength > maxBytes) continue;
      return { bytes: buffer, contentType };
    } catch (err) {
      console.warn("[compliance] media fetch failed:", err instanceof Error ? err.message : err);
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}
