/**
 * The done-for-you website crawl (docs/done-for-you.md, "Intake & enrichment"): the buyer's
 * homepage plus up to 5 same-origin pages that look like services / pricing / rates / about /
 * contact. Fetches go through the shared SSRF guard (src/server/net/safe-fetch.ts).
 *
 * Everything here except crawlWebsite is pure and fixture-tested. We only pull facts the site
 * states: logo, meta description, hours text, phone numbers, and the page text the catalog
 * parser reads services + stated prices from.
 */
import { extractReadableText } from "@/server/ai/catalog-parser";
import { isPageContentType, safeFetchText, type SafeFetchOptions } from "@/server/net/safe-fetch";

export const MAX_EXTRA_PAGES = 5;
const PAGE_MAX_BYTES = 400_000;

// ── Tiny HTML helpers (regex-level; we never execute or render the page) ─────

export function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n: string) => {
      const code = Number(n);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => {
      const code = Number.parseInt(n, 16);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
    });
}

export function parseAttributes(attrs: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(attrs))) {
    const name = match[1].toLowerCase();
    if (!(name in out)) out[name] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return out;
}

function tags(html: string, name: string): Array<Record<string, string>> {
  const re = new RegExp(`<${name}\\b([^>]*)>`, "gi");
  const out: Array<Record<string, string>> = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) out.push(parseAttributes(match[1]));
  return out;
}

function stripComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ");
}

function absoluteHttpUrl(raw: string | undefined, base: string): string | null {
  const value = raw?.trim();
  if (!value || value.startsWith("data:") || value.startsWith("javascript:")) return null;
  try {
    const url = new URL(value, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

// ── Links worth crawling ─────────────────────────────────────────────────────

export interface PageLink {
  url: string;
  text: string;
}

export function extractLinks(html: string, baseUrl: string): PageLink[] {
  const out: PageLink[] = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  const clean = stripComments(html);
  while ((match = re.exec(clean))) {
    const href = parseAttributes(match[1]).href;
    const url = absoluteHttpUrl(href, baseUrl);
    if (!url) continue;
    const text = decodeEntities(match[2].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    out.push({ url, text });
  }
  return out;
}

function siteKey(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

function canonical(url: URL): string {
  const path = url.pathname.replace(/\/+$/, "") || "/";
  return `${siteKey(url.host)}${path}${url.search}`;
}

const SKIP_EXT = /\.(pdf|jpe?g|png|gif|webp|svg|ico|mp4|mov|zip|docx?|xlsx?|css|js|xml|json)$/i;

/** Higher = more likely to state services or prices. 0 = not worth fetching. */
export function crawlLinkScore(link: PageLink): number {
  let path: string;
  try {
    path = decodeURIComponent(new URL(link.url).pathname).toLowerCase();
  } catch {
    return 0;
  }
  const hay = `${path} ${link.text.toLowerCase()}`;
  if (/\b(blog|news|careers?|jobs|privacy|terms|login|sign-?in|cart|checkout|wp-admin|feed|tag|category|author)\b/.test(hay)) return 0;
  let score = 0;
  if (/pric|rates?\b|cost|quote|packages?|plans\b/.test(hay)) score = Math.max(score, 5);
  if (/services?|what-we-do|what we do|solutions|residential|commercial/.test(hay)) score = Math.max(score, 4);
  if (/about|who-we-are|our-story|our-team|company/.test(hay)) score = Math.max(score, 2);
  if (/contact|hours|location|service-area|areas?-we-serve/.test(hay)) score = Math.max(score, 1);
  return score;
}

/** Up to `max` same-origin pages (www-insensitive) that look like services/pricing/about/contact. */
export function selectCrawlLinks(links: PageLink[], homepageUrl: string, max: number = MAX_EXTRA_PAGES): string[] {
  let home: URL;
  try {
    home = new URL(homepageUrl);
  } catch {
    return [];
  }
  const homeKey = canonical(home);
  const best = new Map<string, { url: string; score: number; order: number }>();
  links.forEach((link, order) => {
    let url: URL;
    try {
      url = new URL(link.url);
    } catch {
      return;
    }
    if (siteKey(url.host) !== siteKey(home.host)) return;
    if (SKIP_EXT.test(url.pathname)) return;
    const key = canonical(url);
    if (key === homeKey) return;
    const score = crawlLinkScore(link);
    if (score <= 0) return;
    const prior = best.get(key);
    if (!prior || score > prior.score) best.set(key, { url: url.toString(), score, order: prior?.order ?? order });
  });
  return [...best.values()]
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, max)
    .map((entry) => entry.url);
}

// ── Logo ─────────────────────────────────────────────────────────────────────

interface LogoCandidate {
  url: string;
  score: number;
}

function sizeHint(attrs: Record<string, string>): number {
  const sizes = attrs.sizes?.match(/(\d+)x(\d+)/);
  if (sizes) return Number(sizes[1]);
  const w = Number.parseInt(attrs.width ?? "", 10);
  return Number.isFinite(w) ? w : 0;
}

/**
 * The site's logo as an absolute URL, or null. Preference: an <img> that says it's the logo
 * (src/alt/class/id), the bigger the better; then the apple-touch-icon; an og:image that is
 * itself a logo; a large declared icon; any og:image; the plain favicon last. Pure.
 */
export function pickLogo(html: string, baseUrl: string, businessName?: string | null): string | null {
  const clean = stripComments(html);
  const candidates: LogoCandidate[] = [];
  const nameKey = businessName?.toLowerCase().replace(/[^a-z0-9]+/g, "") ?? "";

  for (const img of tags(clean, "img")) {
    const src = img.src || img["data-src"] || img["data-lazy-src"] || img.srcset?.split(/\s+/)[0];
    const url = absoluteHttpUrl(src, baseUrl);
    if (!url) continue;
    const width = sizeHint(img);
    const height = Number.parseInt(img.height ?? "", 10);
    if ((width > 0 && width <= 2) || (Number.isFinite(height) && height > 0 && height <= 2)) continue; // tracking pixels
    const hay = `${src} ${img.alt ?? ""} ${img.class ?? ""} ${img.id ?? ""}`.toLowerCase();
    const altKey = (img.alt ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
    const saysLogo = /logo/.test(hay);
    const namesBusiness = nameKey.length >= 4 && altKey.length >= 4 && (altKey.includes(nameKey) || nameKey.includes(altKey));
    if (!saysLogo && !namesBusiness) continue;
    if (/sprite|placeholder|loader|spinner/.test(hay)) continue;
    // Partner/payment badges often say "logo" too ("visa-logo", "bbb-logo") — downrank.
    const badge = /visa|mastercard|amex|paypal|bbb|homestars|google|facebook|instagram|twitter|youtube|linkedin|yelp|houzz|trustpilot/.test(hay);
    candidates.push({ url, score: (badge ? 20 : saysLogo ? 100 : 80) + Math.min(width, 600) / 100 });
  }
  for (const link of tags(clean, "link")) {
    const rel = (link.rel ?? "").toLowerCase();
    const url = absoluteHttpUrl(link.href, baseUrl);
    if (!url) continue;
    if (rel.includes("apple-touch-icon")) candidates.push({ url, score: 60 + sizeHint(link) / 100 });
    else if (/\bicon\b/.test(rel)) {
      const size = sizeHint(link);
      candidates.push({ url, score: size >= 96 ? 45 + size / 100 : 10 + size / 100 });
    }
  }
  for (const meta of tags(clean, "meta")) {
    const prop = (meta.property ?? meta.name ?? "").toLowerCase();
    if (prop !== "og:image" && prop !== "og:logo") continue;
    const url = absoluteHttpUrl(meta.content, baseUrl);
    if (!url) continue;
    candidates.push({ url, score: prop === "og:logo" || /logo/i.test(url) ? 55 : 30 });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].url;
}

// ── Facts from text ──────────────────────────────────────────────────────────

export function extractMetaDescription(html: string): string | null {
  const metas = tags(stripComments(html), "meta");
  const pick = (key: string) =>
    metas.find((m) => (m.name ?? m.property ?? "").toLowerCase() === key)?.content?.replace(/\s+/g, " ").trim() || null;
  const description = pick("description") ?? pick("og:description");
  if (!description || description.length < 20) return null;
  return description.length > 300 ? `${description.slice(0, 297).replace(/\s+\S*$/, "")}…` : description;
}

/** North American numbers on the page, as E.164, most frequent first. */
export function extractPhones(text: string): string[] {
  const counts = new Map<string, number>();
  const re = /(?:\+?1[\s.-]?)?\(?([2-9]\d{2})\)?[\s.-]?([2-9]\d{2})[\s.-]?(\d{4})\b/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const e164 = `+1${match[1]}${match[2]}${match[3]}`;
    counts.set(e164, (counts.get(e164) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
}

const DAY = "(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day|s|\\.)?";
const TIME = "(?:\\d{1,2}(?::\\d{2})?\\s*(?:a\\.?m\\.?|p\\.?m\\.?)|noon|\\d{1,2}:\\d{2})";
const HOURS_RE = new RegExp(
  `(${DAY}(?:\\s*(?:-|–|—|to|&|and|,)\\s*${DAY})*)\\s*:?\\s*(${TIME}\\s*(?:-|–|—|to)\\s*${TIME}|closed|24\\s*hours|open 24 hours)`,
  "gi",
);

/** "Mon–Fri 8am–5pm; Sat 9am–1pm" when the page states hours plainly, else null. Pure. */
export function extractHoursText(text: string): string | null {
  const found: string[] = [];
  let match: RegExpExecArray | null;
  HOURS_RE.lastIndex = 0;
  while ((match = HOURS_RE.exec(text)) && found.length < 7) {
    const line = `${match[1]} ${match[2]}`
      .replace(/\s+/g, " ")
      .trim()
      .replace(/(\d\s*[ap]m)\.$/i, "$1"); // "1pm." at the end of a sentence
    if (!found.some((f) => f.toLowerCase() === line.toLowerCase())) found.push(line);
  }
  return found.length > 0 ? found.join("; ") : null;
}

// ── The crawl ────────────────────────────────────────────────────────────────

export interface CrawledPage {
  url: string;
  text: string;
}

export interface CrawlResult {
  /** Homepage URL after redirects. */
  homepageUrl: string;
  pages: CrawledPage[];
  logoUrl: string | null;
  description: string | null;
  hoursText: string | null;
  phones: string[];
  /** Pages we tried and couldn't read (url → reason). */
  failures: Array<{ url: string; reason: string }>;
}

export type CrawlDeps = Pick<SafeFetchOptions, "fetchImpl" | "resolveHost">;

export async function crawlWebsite(rawUrl: string, businessName: string | null, deps: CrawlDeps = {}): Promise<CrawlResult> {
  const fetchOpts: SafeFetchOptions = { ...deps, maxBytes: PAGE_MAX_BYTES, userAgent: "Mozilla/5.0 (compatible; SiteSetup/1.0)" };
  const home = await safeFetchText(rawUrl, fetchOpts);
  if (home.status < 200 || home.status >= 300) throw new Error(`The website answered ${home.status}.`);
  if (!isPageContentType(home.contentType)) throw new Error(`The website's homepage isn't a web page (${home.contentType}).`);
  const pages: CrawledPage[] = [{ url: home.url, text: extractReadableText(home.body) }];
  const htmls: string[] = [home.body];
  const failures: CrawlResult["failures"] = [];

  for (const url of selectCrawlLinks(extractLinks(home.body, home.url), home.url)) {
    try {
      const page = await safeFetchText(url, fetchOpts);
      if (page.status < 200 || page.status >= 300 || !isPageContentType(page.contentType)) {
        failures.push({ url, reason: page.status < 200 || page.status >= 300 ? `status ${page.status}` : `not a page (${page.contentType})` });
        continue;
      }
      pages.push({ url: page.url, text: extractReadableText(page.body) });
      htmls.push(page.body);
    } catch (err) {
      failures.push({ url, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  const allText = pages.map((p) => p.text).join("\n");
  return {
    homepageUrl: home.url,
    pages,
    logoUrl: pickLogo(home.body, home.url, businessName),
    description: htmls.map(extractMetaDescription).find((d): d is string => Boolean(d)) ?? null,
    hoursText: extractHoursText(allText),
    phones: extractPhones(allText),
    failures,
  };
}
