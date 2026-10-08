/**
 * Fetching a web page whose URL a user (or a buyer's Google listing) gave us — shared by the
 * "import services from your website" parser (src/server/ai/catalog-parser.ts) and the
 * done-for-you website crawl (src/server/services/dfy/crawl.ts).
 *
 * SSRF guard: only public http(s) hosts on the default ports. The hostname is checked as
 * written AND after DNS resolution (a public name pointing at 10.x / 127.x / metadata is
 * refused), and redirects are followed by hand so every hop is checked again. Responses are
 * size-capped and time-limited.
 *
 * DNS rebinding: the pre-flight lookup only produces a friendly error. The connection itself is
 * pinned through an undici dispatcher whose `connect.lookup` re-validates EVERY address the
 * resolver hands back at connect time (and refuses literal private IPs), so a name that answers
 * "public" to the check and "127.0.0.1" to the connect is still refused. Every hop — including
 * each manual redirect — goes through that dispatcher.
 */
import { lookup as dnsLookupCb, type LookupAddress } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

import { Agent, buildConnector, type Dispatcher } from "undici";

import { ValidationError } from "@/server/organizations/context";

export const DEFAULT_MAX_BYTES = 240_000;
export const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;

// IPv4 ranges that are not the public internet (RFC 6890 special-purpose registry + friends).
const BLOCKED_V4_CIDRS: Array<[string, number]> = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // CGNAT / internal mesh
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local (cloud metadata)
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
];

function v4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const v = Number(part);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

const BLOCKED_V4_RANGES = BLOCKED_V4_CIDRS.map(([base, bits]) => {
  const size = 2 ** (32 - bits);
  const start = v4ToInt(base)!;
  return { start, end: start + size - 1 };
});

function isPrivateV4Int(n: number): boolean {
  return BLOCKED_V4_RANGES.some((r) => n >= r.start && n <= r.end);
}

/**
 * Parse an IPv6 literal (any spelling: compressed, with an embedded dotted IPv4 tail, zone id
 * stripped) into its 16 bytes. Returns null when it isn't valid IPv6.
 */
export function parseIPv6(raw: string): Uint8Array | null {
  let ip = raw.replace(/^\[|\]$/g, "").toLowerCase();
  const zone = ip.indexOf("%");
  if (zone >= 0) ip = ip.slice(0, zone);
  if (isIP(ip) !== 6) return null;
  const lastColon = ip.lastIndexOf(":");
  const maybeV4 = ip.slice(lastColon + 1);
  if (maybeV4.includes(".")) {
    // "::ffff:127.0.0.1" → "::ffff:7f00:1"
    const n = v4ToInt(maybeV4);
    if (n === null) return null;
    ip = `${ip.slice(0, lastColon + 1)}${((n >>> 16) & 0xffff).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  let groups: number[];
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === "" ? [] : part.split(":").map((g) => parseInt(g, 16)));
  if (halves.length === 2) {
    const head = parse(halves[0]);
    const rest = parse(halves[1]);
    const fill = 8 - head.length - rest.length;
    if (fill < 0) return null;
    groups = [...head, ...new Array<number>(fill).fill(0), ...rest];
  } else {
    groups = parse(ip);
  }
  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null;
  const bytes = new Uint8Array(16);
  groups.forEach((g, i) => {
    bytes[i * 2] = g >> 8;
    bytes[i * 2 + 1] = g & 0xff;
  });
  return bytes;
}

function startsWith(bytes: Uint8Array, prefix: number[], bits: number): boolean {
  for (let bit = 0; bit < bits; bit++) {
    const byte = Math.floor(bit / 8);
    const mask = 0x80 >> bit % 8;
    if ((bytes[byte] & mask) !== ((prefix[byte] ?? 0) & mask)) return false;
  }
  return true;
}

function embeddedV4(bytes: Uint8Array, offset = 12): number {
  return ((bytes[offset] << 24) >>> 0) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3];
}

function isPrivateV6(bytes: Uint8Array): boolean {
  // ::ffff:0:0/96 — IPv4-mapped: judge the embedded IPv4 address.
  if (startsWith(bytes, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff], 96)) return isPrivateV4Int(embeddedV4(bytes));
  // ::ffff:0:0:0/96 — IPv4-translated (SIIT).
  if (startsWith(bytes, [0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0, 0], 96)) return true;
  // ::/96 — unspecified, loopback and the deprecated IPv4-compatible block. Never a public site.
  if (startsWith(bytes, [], 96)) return true;
  if (startsWith(bytes, [0x00, 0x64, 0xff, 0x9b], 96)) return true; // 64:ff9b::/96 NAT64 (reaches any v4)
  if (startsWith(bytes, [0x00, 0x64, 0xff, 0x9b, 0x00, 0x01], 48)) return true; // 64:ff9b:1::/48 local NAT64
  if (startsWith(bytes, [0x01, 0x00], 64)) return true; // 100::/64 discard
  if (startsWith(bytes, [0x20, 0x01, 0x00, 0x00], 32)) return true; // 2001::/32 Teredo (embeds v4)
  if (startsWith(bytes, [0x20, 0x01, 0x0d, 0xb8], 32)) return true; // 2001:db8::/32 documentation
  if (startsWith(bytes, [0x20, 0x02], 16)) return true; // 2002::/16 6to4 (embeds v4)
  if (startsWith(bytes, [0xfc], 7)) return true; // fc00::/7 unique local
  if (startsWith(bytes, [0xfe, 0x80], 10)) return true; // fe80::/10 link-local
  if (startsWith(bytes, [0xfe, 0xc0], 10)) return true; // fec0::/10 site-local (deprecated)
  if (startsWith(bytes, [0xff], 8)) return true; // multicast
  return false;
}

/** Is this IP address (v4 or v6, any spelling) private / loopback / link-local / otherwise not public? */
export function isPrivateAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(ip) === 4) {
    const n = v4ToInt(ip);
    return n === null ? true : isPrivateV4Int(n);
  }
  const v6 = parseIPv6(ip);
  if (v6) return isPrivateV6(v6);
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
  /** Injected in tests; defaults to a fresh pinned dispatcher per call (see createGuardedDispatcher). */
  dispatcher?: Dispatcher;
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

/** Error code on connections refused by the pinned dispatcher. */
export const SSRF_BLOCKED_CODE = "E_SSRF_BLOCKED";

function blockedError(hostname: string): NodeJS.ErrnoException {
  const err = new Error(`Refused to connect to a non-public address for ${hostname}`) as NodeJS.ErrnoException;
  err.code = SSRF_BLOCKED_CODE;
  return err;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;
type LookupFn = (hostname: string, options: { all?: boolean; family?: number | string } | number, callback: LookupCallback) => void;

/**
 * A `net.connect` lookup that resolves every address for the host and refuses the connection
 * when ANY of them is non-public (so a mixed public/private answer can't be raced either).
 */
export function guardedLookup(resolveAll: (hostname: string) => Promise<LookupAddress[]> = defaultResolveAll): LookupFn {
  return (hostname, options, callback) => {
    const wantAll = typeof options === "object" && options !== null && Boolean(options.all);
    resolveAll(hostname).then(
      (addresses) => {
        if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
          callback(blockedError(hostname), wantAll ? [] : "", undefined);
          return;
        }
        if (wantAll) callback(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
      },
      (err: NodeJS.ErrnoException) => callback(err, wantAll ? [] : "", undefined),
    );
  };
}

function defaultResolveAll(hostname: string): Promise<LookupAddress[]> {
  return new Promise((resolve, reject) => {
    dnsLookupCb(hostname, { all: true, verbatim: true }, (err, addresses) => (err ? reject(err) : resolve(addresses)));
  });
}

function resolverToLookupAll(resolveHost: HostResolver): (hostname: string) => Promise<LookupAddress[]> {
  return async (hostname) => (await resolveHost(hostname)).map((address) => ({ address, family: isIP(address) === 6 ? 6 : 4 }));
}

/**
 * An undici dispatcher whose every connection is checked at connect time: literal IPs must be
 * public, and names are resolved through `guardedLookup`. Pass it as `dispatcher` to fetch.
 */
export function createGuardedDispatcher(resolveHost?: HostResolver): Agent {
  const lookup = guardedLookup(resolveHost ? resolverToLookupAll(resolveHost) : defaultResolveAll);
  const base = buildConnector({ lookup: lookup as never, timeout: DEFAULT_TIMEOUT_MS });
  return new Agent({
    keepAliveTimeout: 1_000,
    connections: 4,
    connect: (opts, callback) => {
      const host = opts.hostname.replace(/^\[|\]$/g, "");
      if (isIP(host) && isPrivateAddress(host)) {
        callback(blockedError(host), null);
        return;
      }
      base(opts, callback);
    },
  });
}

function isSsrfBlocked(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 5; depth++) {
    if ((e as NodeJS.ErrnoException).code === SSRF_BLOCKED_CODE) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/** HTML-ish (or unlabeled) responses only — we never parse images, PDFs or JSON as a page. */
export function isPageContentType(contentType: string): boolean {
  return /html|text\/plain|^\s*$/i.test(contentType);
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
  const ownDispatcher = options.dispatcher ? null : createGuardedDispatcher(options.resolveHost);
  const dispatcher = options.dispatcher ?? ownDispatcher!;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    let url = assertFetchableUrl(rawUrl);
    for (let hop = 0; ; hop++) {
      await assertResolvesPublic(url, resolveHost);
      const response = await fetchImpl(url.toString(), {
        signal: controller.signal,
        redirect: "manual",
        // Node's fetch accepts an undici dispatcher (not in the DOM RequestInit type).
        ...({ dispatcher } as Record<string, unknown>),
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
    if (isSsrfBlocked(err)) throw new ValidationError("That host isn't reachable.");
    throw new ValidationError("We couldn't reach that website.");
  } finally {
    clearTimeout(timer);
    if (ownDispatcher) void ownDispatcher.destroy().catch(() => undefined);
  }
}
