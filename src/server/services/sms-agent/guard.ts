/**
 * PURE checks and shaping for what the SMS agent sends. The model writes the reply; these make
 * sure that, whatever it wrote:
 *   • no dollar amount goes out that the price list or a tool didn't vouch for (else → owner),
 *   • no "% off" deal goes out (discounts always need the owner),
 *   • the first AI message says it's an automated assistant,
 *   • every link a tool produced is in the text,
 *   • it's short (≈2 SMS segments), plain, and never names the platform.
 */

const PLATFORM_NAMES = /\b(crank\s?leads|empire\s?vu)\b/gi;

export const MAX_REPLY_CHARS = 320;
export const MAX_REPLY_CHARS_WITH_LINK = 459;

/** Curly quotes / dashes / ellipsis → plain GSM characters (keeps a text in 160-char segments). */
export function toPlainText(text: string): string {
  return text
    .replace(/[\u2018\u2019\u201A\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u2033]/g, '"')
    .replace(/[\u2013\u2014\u2212]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/[\u00A0\u2007\u202F]/g, " ")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function stripPlatformNames(text: string, businessName: string): string {
  return text.replace(PLATFORM_NAMES, businessName);
}

/** "$650", "$1,200.50", "650 dollars", "$650.00" → cents. */
export function extractAmountsCents(text: string): number[] {
  const out: number[] = [];
  const re = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?|\b(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s?(?:dollars|bucks)\b/gi;
  for (const m of text.matchAll(re)) {
    const whole = (m[1] ?? m[3] ?? "").replace(/,/g, "");
    const frac = m[2] ?? m[4] ?? "";
    if (!whole) continue;
    out.push(Number(whole) * 100 + (frac ? Number(frac.padEnd(2, "0")) : 0));
  }
  return out;
}

/** Amounts in `text` nobody vouched for. PURE. */
export function unvouchedAmounts(text: string, allowed: Iterable<number>): number[] {
  const ok = new Set(allowed);
  return extractAmountsCents(text).filter((c) => !ok.has(c));
}

/** A percentage deal ("20% off", "10 percent discount"). */
export function mentionsPercentDeal(text: string): boolean {
  return /\b\d{1,3}\s?(%|percent)\s?(off|discount)\b/i.test(text);
}

const DISCLOSURE = /automated assistant|virtual assistant|\bAI\b|automated/i;

export function hasDisclosure(text: string): boolean {
  return DISCLOSURE.test(text);
}

/** Prefix the AI disclosure when the model left it out. */
export function ensureDisclosure(text: string, businessName: string): string {
  if (hasDisclosure(text)) return text;
  return `Hi, it's ${businessName}'s automated assistant. ${text.replace(/^(hi|hey|hello)( there)?[,!.]?\s*/i, "")}`;
}

/** Append any link the reply is missing. */
export function ensureLinks(text: string, links: string[]): string {
  let out = text;
  for (const link of [...new Set(links)]) {
    if (!out.includes(link)) out = `${out.replace(/[\s:]+$/, "")}${/[.!?]$/.test(out) ? "" : "."} ${link}`;
  }
  return out;
}

/**
 * Keep it to about two segments: drop trailing sentences that don't carry a link until it fits.
 * Never cuts a link. A reply that still can't fit is returned as-is up to the hard cap.
 */
export function fitLength(text: string, links: string[]): string {
  const limit = links.length ? MAX_REPLY_CHARS_WITH_LINK : MAX_REPLY_CHARS;
  if (text.length <= limit) return text;
  // Split on sentence ends without breaking links (their dots aren't sentence ends).
  const uniqueLinks = [...new Set(links)];
  let masked = text;
  uniqueLinks.forEach((l, i) => {
    masked = masked.split(l).join(`\uE000${i}\uE001`);
  });
  const restore = (s: string) => s.replace(/\uE000(\d+)\uE001/g, (_m, i: string) => uniqueLinks[Number(i)] ?? "");
  const sentences = (masked.match(/[^.!?\n]+[.!?]*\s*/g) ?? [masked]).map(restore);
  const keep = [...sentences];
  while (keep.join("").trim().length > limit && keep.length > 1) {
    const idx = [...keep].reverse().findIndex((s) => !uniqueLinks.some((l) => s.includes(l)));
    if (idx < 0) break;
    keep.splice(keep.length - 1 - idx, 1);
  }
  const out = keep.join("").trim();
  return out.length <= MAX_REPLY_CHARS_WITH_LINK ? out : out.slice(0, MAX_REPLY_CHARS_WITH_LINK - 1).trimEnd() + "…";
}

/** "ok", "thanks!", "👍", "k thx" — nothing to answer. */
export function isAcknowledgement(body: string): boolean {
  const t = body.trim().toLowerCase().replace(/[!.\s]+$/g, "");
  if (!t) return false;
  if (/^(\p{Extended_Pictographic}|\s)+$/u.test(t)) return true;
  return /^(ok(ay)?|k|kk|thanks?|thank you|thx|ty|cheers|great|perfect|sounds good|cool|got it|will do|awesome|thank you so much|thanks so much|ok thanks?|ok thank you|okay thanks?|perfect thanks?|great thanks?)$/.test(t);
}

/** Phone auto-replies ("I'm driving…", "Auto-reply:"), not meant for anyone. */
export function isAutoReply(body: string): boolean {
  return /^(auto[- ]?reply|automatic reply|i'?m driving|i am driving|driving with do not disturb|this is an automated)/i.test(body.trim()) ||
    /do not disturb while driving/i.test(body);
}
