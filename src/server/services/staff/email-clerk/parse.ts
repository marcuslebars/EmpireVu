/**
 * PURE helpers for inbound email: addresses, the Message-ID chain, HTML → text, a sanitized HTML
 * excerpt, quoted-history stripping, and the one cleaner every owner-facing snippet goes through
 * (no links, no markup — an email is untrusted data, and a link in an owner text is a phishing
 * vector).
 */

export const MAX_TEXT_CHARS = 20_000;
export const MAX_HTML_CHARS = 20_000;

export interface ParsedAddress {
  name: string | null;
  address: string | null;
}

const EMAIL_RE = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/** `"Dana Jones" <Dana@Example.com>` → { name: "Dana Jones", address: "dana@example.com" }. */
export function parseAddress(raw: string | null | undefined): ParsedAddress {
  const text = (raw ?? "").replace(/[\r\n]+/g, " ").trim();
  if (!text) return { name: null, address: null };
  const angle = /^(.*)<([^<>]+)>\s*$/.exec(text);
  const addrPart = angle ? angle[2] : text;
  const address = EMAIL_RE.exec(addrPart)?.[0]?.toLowerCase() ?? null;
  let name = angle ? angle[1].trim().replace(/^"(.*)"$/, "$1").replace(/\\"/g, '"').trim() : null;
  if (name && (name.toLowerCase() === address || EMAIL_RE.test(name))) name = null;
  return { name: name ? name.slice(0, 120) : null, address };
}

export function normalizeAddress(raw: string | null | undefined): string | null {
  return parseAddress(raw).address;
}

export function domainOf(address: string | null | undefined): string | null {
  const a = normalizeAddress(address);
  return a ? a.slice(a.indexOf("@") + 1) : null;
}

/** Every `<…@…>` id in a Message-ID / In-Reply-To / References header, in order, deduped. */
export function messageIds(raw: string | null | undefined): string[] {
  const out: string[] = [];
  for (const m of (raw ?? "").matchAll(/<[^<>\s]{1,250}>/g)) {
    if (!out.includes(m[0])) out.push(m[0]);
  }
  return out.slice(-30);
}

/** A bare id gets its angle brackets. */
export function asMessageId(raw: string | null | undefined): string | null {
  const t = (raw ?? "").trim();
  if (!t) return null;
  const ids = messageIds(t);
  if (ids.length) return ids[0];
  return /^[^<>\s]{1,250}$/.test(t) ? `<${t}>` : null;
}

/** The thread's root: the first id in References, else In-Reply-To, else this message. */
export function threadKeyFor(messageId: string, inReplyTo: string | null, references: string[]): string {
  return references[0] ?? inReplyTo ?? messageId;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "-", mdash: "-", hellip: "...", rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"' };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : " ";
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

function dropDangerousBlocks(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|head|title|template|noscript|svg|math|iframe|object)[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(script|style|iframe|object|embed)[^>]*>/gi, " ");
}

/** HTML → readable text (block tags become line breaks). */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return "";
  const text = dropDangerousBlocks(html)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|table)>/gi, "\n")
    .replace(/<(ul|ol|table)[^>]*>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(text)
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const KEEP_TAGS = new Set(["p", "br", "b", "strong", "i", "em", "u", "ul", "ol", "li", "blockquote", "div", "span", "h1", "h2", "h3", "h4", "table", "tr", "td", "th", "tbody", "thead"]);

/**
 * A sanitized HTML excerpt: only plain formatting tags survive, with NO attributes (so no links,
 * images, styles or event handlers); scripts/styles/comments are gone. Capped. The app shows the
 * text version; this is kept for reference only.
 */
export function sanitizeHtml(html: string | null | undefined, max = MAX_HTML_CHARS): string | null {
  if (!html) return null;
  const out = dropDangerousBlocks(html)
    .replace(/<\s*(\/?)\s*([a-z0-9]+)[^>]*>/gi, (_m, close: string, tag: string) => (KEEP_TAGS.has(tag.toLowerCase()) ? `<${close}${tag.toLowerCase()}>` : " "))
    .replace(/<(?![a-z/])/gi, "&lt;")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  if (!out) return null;
  return out.length > max ? out.slice(0, max) : out;
}

/**
 * The new part of a reply: everything before the quoted history ("On … wrote:", "-----Original
 * Message-----", "From: … Sent: …", "> " lines, Outlook's underscore rule).
 */
export function newText(text: string | null | undefined): string {
  const lines = (text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (/^-{2,}\s*(original message|forwarded message)\s*-{2,}/i.test(t)) break;
    if (/^_{10,}$/.test(t)) break;
    if (/^On .{4,200}wrote:\s*$/i.test(t) || (/^On .{4,200}$/i.test(t) && /wrote:\s*$/i.test(lines[i + 1]?.trim() ?? ""))) break;
    if (/^Le .{4,200}a écrit\s*:\s*$/i.test(t)) break;
    if (/^From:\s.+/i.test(t) && lines.slice(i + 1, i + 5).some((l) => /^(Sent|Date|To|Subject):\s/i.test(l.trim()))) break;
    if (/^>/.test(t)) continue;
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

const PLATFORM_NAMES = /\b(crank\s?leads|empire\s?vu)\b/gi;

/**
 * One line of untrusted email text made safe for an owner text or a prompt label: links,
 * e-mail-ish markup, angle brackets and control characters out, whitespace collapsed, capped.
 */
export function clean(text: string | null | undefined, max: number): string {
  const t = (text ?? "")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\bwww\.\S+/gi, " ")
    .replace(/<[^>]*>/g, " ")
    // eslint-disable-next-line no-control-regex -- control characters out of untrusted text
    .replace(/[<>{}`\u0000-\u001f\u007f]/g, " ")
    .replace(PLATFORM_NAMES, " ")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(1, max - 3)).trimEnd()}...`;
}

/** PO-12, PO 12, PO#12, P.O. 12 → "PO-12" (the purchasing number format). */
export function poNumbersIn(text: string | null | undefined): string[] {
  const out: string[] = [];
  for (const m of (text ?? "").matchAll(/\bP\.?\s?O\.?\s?(?:#|no\.?|number)?\s?-?\s?(\d{1,6})\b/gi)) {
    const po = `PO-${Number(m[1])}`;
    if (!out.includes(po)) out.push(po);
  }
  return out.slice(0, 5);
}

const NO_REPLY_LOCAL = /^(no-?reply|do-?not-?reply|donotreply|noreply[-+.].*|bounces?|mailer-daemon|postmaster|notifications?|notify|alerts?|automated|system|mailer)([-+.].*)?$/i;

export function isNoReplyAddress(address: string | null | undefined): boolean {
  const a = normalizeAddress(address);
  if (!a) return true;
  return NO_REPLY_LOCAL.test(a.slice(0, a.indexOf("@")));
}

/** Personal mailbox domains: matching a supplier by domain never uses these. */
export const FREEMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "hotmail.ca", "live.com", "live.ca", "msn.com", "yahoo.com", "yahoo.ca",
  "icloud.com", "me.com", "mac.com", "aol.com", "rogers.com", "bell.net", "sympatico.ca", "shaw.ca", "telus.net", "cogeco.ca", "eastlink.ca",
  "proton.me", "protonmail.com", "gmx.com", "mail.com", "yandex.com", "zoho.com", "videotron.ca", "execulink.com",
]);

/** "Re: Re: Fwd: Roof quote" → "Roof quote". */
export function baseSubject(subject: string | null | undefined): string {
  let s = (subject ?? "").trim();
  for (let i = 0; i < 6; i++) {
    const next = s.replace(/^\s*(re|fw|fwd|aw|tr)\s*(\[\d+\])?\s*:\s*/i, "");
    if (next === s) break;
    s = next;
  }
  return s.trim();
}

/** "Re: <subject>" for our reply (never "Re: Re:"). */
export function replySubject(subject: string | null | undefined): string {
  const base = baseSubject(subject).replace(/[\r\n]+/g, " ").slice(0, 180);
  return base ? `Re: ${base}` : "Re: your email";
}

/** First name for a greeting: the display name's first word, else null. */
export function firstNameOf(name: string | null | undefined): string | null {
  const first = (name ?? "").trim().split(/[\s,]+/)[0] ?? "";
  return /^[A-Za-zÀ-ÿ'-]{2,30}$/.test(first) ? first[0].toUpperCase() + first.slice(1) : null;
}
