/**
 * Fetching a web page whose URL a user (or a buyer's Google listing) gave us — shared by the
 * "import services from your website" parser (src/server/ai/catalog-parser.ts) and the
 * done-for-you website crawl (src/server/services/dfy/crawl.ts).
 *
 * SSRF guard: only public http(s) hosts on the default ports. The hostname is checked as
 * written AND after DNS resolution (a public name pointing at 10.x / 127.x / metadata is
 * refused), and redirects are followed by hand so every hop is checked again. Responses are
 * size-capped and time-limited.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

import { ValidationError } from "@/server/organizations/context";

export const DEFAULT_MAX_BYTES = 240_000;
export const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;

const BLOCKED_V4 = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT / internal mesh
  /^(22[4-9]|2[3-5]\d)\./, // multicast + reserved
];

/** Is this IP address (v4 or v6) private / loopback / link-local / otherwise not public? */
export function isPrivateAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, "").toLowerCase();
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateAddress(mapped[1]);
  if (isIP(ip) === 4) return BLOCKED_V4.some((re) => re.test(ip));
  if (isIP(ip) === 6) {
    return ip === "::" || ip === "::1" || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip) || /^ff/.test(ip);
  }
  return false;
}

/** Hostnames refused before any DNS lookup. */
export function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (host === "metadata.google.internal") return true;
  // Bare intranet names ("intranet", "db") — real business sites have a dot.
  if (!host.includes(".") && isIP(host.replace(/^\[|\]$/g, "")) === 0) return true;
  return isPrivateAddress(host);
}

/** Parse + check a URL we're about to fetch. Throws a plain-English ValidationError. */
export function assertFetchableUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError("Enter a valid website URL (including https://).");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ValidationError("Only http(s) URLs are supported.");
  }
  if (url.username || url.password) throw new ValidationError("That website address isn't supported.");
  if (url.port && url.port !== "80" && url.port !== "443") throw new ValidationError("That host isn't reachable.");
  if (isBlockedHost(url.hostname)) throw new ValidationError("That host isn't reachable.");
  return url;
}

/** "acme.ca" / "www.acme.ca/services" → "https://acme.ca" style URL, or null if hopeless. */
export function normalizeWebsiteUrl(raw: string | null | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname.includes(".")) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export type HostResolver = (hostname: string) => Promise<string[]>;

const defaultResolver: HostResolver = async (hostname) => {
  const results = await dnsLookup(hostname, { all: true, verbatim: true });
  return results.map((r) => r.address);
};

export interface SafeFetchOptions {
  maxBytes?: number;
  timeoutMs?: number;
  accept?: string;
  userAgent?: string;
  /** Injected in tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected in tests; defaults to DNS lookup. */
  resolveHost?: HostResolver;
}

export interface SafeFetchResult {
  /** The final URL after redirects. */
  url: string;
  status: number;
  contentType: string;
  body: string;
}

async function assertResolvesPublic(url: URL, resolveHost: HostResolver): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return; // literal IPs were checked by isBlockedHost
  let addresses: string[];
  try {
    addresses = await resolveHost(host);
  } catch {
    throw new ValidationError("We couldn't find that website. Check the address and try again.");
  }
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new ValidationError("That host isn't reachable.");
  }
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return (await response.text()).slice(0, maxBytes);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    total += value.byteLength;
    if (total >= maxBytes) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  const merged = new Uint8Array(Math.min(total, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    const room = merged.length - offset;
    if (room <= 0) break;
    merged.set(chunk.subarray(0, room), offset);
    offset += Math.min(chunk.byteLength, room);
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(merged);
}

/**
 * GET a public page (manual redirects, each hop SSRF-checked), size-capped and time-limited.
 * Non-2xx answers resolve with their status (callers decide); network/guard problems throw
 * ValidationError with a plain-English message.
 */
export async function safeFetchText(rawUrl: string, options: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const resolveHost = options.resolveHost ?? defaultResolver;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    let url = assertFetchableUrl(rawUrl);
    for (let hop = 0; ; hop++) {
      await assertResolvesPublic(url, resolveHost);
      const response = await fetchImpl(url.toString(), {
        signal: controller.signal,
        redirect: "manual",
        headers: {
          "User-Agent": options.userAgent ?? "WebsiteImport/1.0",
          Accept: options.accept ?? "text/html,application/xhtml+xml",
        },
      });
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        if (hop >= MAX_REDIRECTS) throw new ValidationError("That website redirects too many times.");
        url = assertFetchableUrl(new URL(location, url).toString());
        continue;
      }
      const body = response.ok ? await readCapped(response, maxBytes) : "";
      return { url: url.toString(), status: response.status, contentType: response.headers.get("content-type") ?? "", body };
    }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw new ValidationError("The site took too long to respond.");
    if (err instanceof ValidationError) throw err;
    throw new ValidationError("We couldn't reach that website.");
  } finally {
    clearTimeout(timer);
  }
}
