/**
 * PURE checks and shaping for what the SMS agent sends. The model writes the reply; these make
 * sure that, whatever it wrote:
 *   • no dollar amount goes out that the price list or a tool didn't vouch for (else → owner),
 *   • no deal goes out ("% off", "half price", "free first visit", "knock 100 off") — the owner decides,
 *   • the first AI message says it's an automated assistant,
 *   • every link a tool produced is in the text exactly once, and no other link is,
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

// ── URLs ───────────────────────────────────────────────────────────────────────

/**
 * Anything that looks like a link: a scheme URL, a www. host, or a bare host with a common TLD
 * (optionally with a port and path). Trailing sentence punctuation is not part of the link.
 */
const URL_RE =
  /\b(?:https?:\/\/[^\s<>"'`]+|www\.[^\s<>"'`]+|(?:[a-z0-9-]+\.)+(?:com|ca|net|org|io|co|app|dev|biz|info|us|localhost)(?::\d{2,5})?(?:\/[^\s<>"'`]*)?(?![a-z0-9-]))/gi;
const TRAILING_PUNCT = /[.,!?;:)\]}'"]+$/;

/** Every link in `text`, in order, without trailing punctuation. PURE. */
export function extractUrls(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0].replace(TRAILING_PUNCT, "");
    if (url) out.push(url);
  }
  return out;
}

/**
 * Replace every link with a private-use placeholder so text-level rewrites (platform names,
 * the money guard) never touch a URL; `restore` puts them back exactly.
 */
export function maskUrls(text: string): { masked: string; urls: string[]; restore(s: string): string } {
  const urls: string[] = [];
  const masked = text.replace(URL_RE, (raw) => {
    const url = raw.replace(TRAILING_PUNCT, "");
    const tail = raw.slice(url.length);
    urls.push(url);
    return `\uE000${urls.length - 1}\uE001${tail}`;
  });
  return { masked, urls, restore: (s: string) => s.replace(/\uE000(\d+)\uE001/g, (_m, i: string) => urls[Number(i)] ?? "") };
}

function sameUrl(a: string, b: string): boolean {
  const norm = (u: string) => u.replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

/** A garbled copy of one of our links (same token path, wrong/missing host): "…/q/abc123". */
function looksLike(url: string, link: string): boolean {
  const path = (u: string) => u.replace(/^https?:\/\//i, "").replace(/^[^/]*/, "").replace(/\/+$/, "");
  const p = path(link);
  return p.split("/").filter(Boolean).length >= 2 && path(url) === p;
}

/** Platform names → the business's name, never inside a link. */
export function stripPlatformNames(text: string, businessName: string): string {
  const { masked, restore } = maskUrls(text);
  return restore(masked.replace(PLATFORM_NAMES, businessName));
}

function tidyAfterRemoval(text: string): string {
  return text
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .replace(/:\s*([.!?])/g, "$1")
    .replace(/([.!?])[.:,]+/g, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

/**
 * Make the links in a customer text exactly right:
 *   • a link that is not one we produced (`links`) or a known business link (`allowed`) is
 *     removed — the model can't invent, mangle or truncate a link into the text;
 *   • a link that appears twice is kept once;
 *   • a produced link that's missing is appended.
 * So the customer gets each correct link exactly once. PURE.
 */
export function ensureLinks(text: string, links: string[], allowed: string[] = []): string {
  const wanted = [...new Set(links.filter(Boolean))];
  const ok = [...wanted, ...allowed.filter(Boolean)];
  const seen: string[] = [];
  let out = text.replace(URL_RE, (raw) => {
    const url = raw.replace(TRAILING_PUNCT, "");
    const tail = raw.slice(url.length);
    const known = ok.find((l) => sameUrl(l, url)) ?? wanted.find((l) => looksLike(url, l));
    if (!known || seen.some((s) => sameUrl(s, known))) return tail;
    seen.push(known);
    return `${known}${tail}`;
  });
  out = tidyAfterRemoval(out);
  for (const link of wanted) {
    if (seen.some((s) => sameUrl(s, link))) continue;
    out = `${out.replace(/[\s:]+$/, "")}${/[.!?]$/.test(out) || !out ? "" : "."} ${link}`.trim();
    seen.push(link);
  }
  return out;
}

/**
 * The last step for ANY text to a customer (agent reply or an approved action): plain
 * characters, platform names out (links untouched), then exactly-once links. PURE.
 */
export function finalizeCustomerText(text: string, input: { businessName: string; links: string[]; allowed?: string[] }): string {
  return ensureLinks(stripPlatformNames(toPlainText(text), input.businessName), input.links, input.allowed ?? []);
}

// ── the money guard ───────────────────────────────────────────────────────────

const SMALL_NUMBERS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90,
};
const NUMBER_WORD = "(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|fou?rty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|grand|a|and)";
const SPELLED_RE = new RegExp(`\\b${NUMBER_WORD}(?:[\\s-]+${NUMBER_WORD})*\\b`, "gi");

/** "six hundred and fifty" → 650; "two grand" → 2000; null when it isn't a number. PURE. */
export function parseSpelledNumber(phrase: string): number | null {
  const words = phrase.toLowerCase().split(/[\s-]+/).filter((w) => w && w !== "and");
  if (!words.some((w) => w !== "a")) return null;
  let total = 0;
  let current = 0;
  let any = false;
  for (const w of words) {
    if (w === "a") {
      current = Math.max(current, 1);
      continue;
    }
    if (w in SMALL_NUMBERS) {
      current += SMALL_NUMBERS[w];
      any = true;
    } else if (w === "hundred") {
      current = Math.max(current, 1) * 100;
      any = true;
    } else if (w === "thousand" || w === "grand") {
      total += Math.max(current, 1) * 1000;
      current = 0;
      any = true;
    } else return null;
  }
  return any ? total + current : null;
}

const MONEY_AFTER = /^\s*(?:\$|dollars?\b|bucks?\b|cad\b|cdn\b|canadian\b|loonies\b|(?:\+|plus)\s*(?:hst|tax|gst)\b|(?:hst|tax)\b|before\s+(?:hst|tax)|(?:all\s+)?in\b)/i;
const MONEY_BEFORE = /(?:\$|\bcad|\bcdn|\btotal|\bprice[ds]?|\bcosts?|\brates?|\bcharged?|\bcharges|\bfees?|\bquoted?|\bdeposit|\bpay|\bpaying|\bfor\s+just|\bonly|\bknock(?:ing)?|\bsave|\bsaving|\bdiscount(?:ed)?|\bdown\s+to|\bbring\s+it\s+to|\bmatch)\s*(?:is|of|at|be|would\s+be|will\s+be|comes?\s+to|:|-|=|it|you|just|about|around|roughly|~)?\s*(?:is|at|be|of|just)?\s*$/i;
const UNIT_AFTER = /^\s*(?:%|percent|cm|mm|m\b|km|ft|feet|foot|in\b|inch|inches|sq|square|am\b|pm\b|a\.m|p\.m|h\b|hrs?\b|hours?|mins?\b|minutes?|days?|weeks?|months?|years?|yrs?|visits?|times?|x\b|st\b|nd\b|rd\b|th\b|people|trucks?|cars?|loads?|bags?|yards?|metres?|meters?|units?|storeys?|stories|floors?|windows?|doors?|rooms?)/i;

export interface MoneyFinding {
  /** Unvouched amounts in cents (a spelled-out/unparseable amount is -1). */
  amounts: number[];
  /** Why the text needs the owner, for the owner's approval text. */
  reasons: string[];
}

/**
 * Amounts in a text, in cents: "$650", "$1,200.50", "600$", "$6 50" (→ $6), "CAD 600",
 * "600 + HST", "the total is 600", "six hundred dollars". Numbers inside links, times, dates,
 * phone numbers and measurements are not amounts. PURE.
 */
export function extractAmountsCents(text: string): number[] {
  const { masked } = maskUrls(text);
  const out: number[] = [];
  const re = /(\$\s?)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(\s?k\b)?/gi;
  for (const m of masked.matchAll(re)) {
    const start = m.index ?? 0;
    const before = masked.slice(Math.max(0, start - 28), start);
    const after = masked.slice(start + m[0].length, start + m[0].length + 24);
    // Part of a time (9:30), a date (2026-10-13 / 10/13), a phone number or a longer digit run.
    if (/[\d:/\-.]$/.test(before.replace(/\$\s?$/, "")) && !m[1]) continue;
    if (/^[:/-]\d/.test(after) || /^\d/.test(after)) continue;
    const dollarBefore = Boolean(m[1]);
    const dollarAfter = /^\s?\$/.test(after);
    const moneyAfter = MONEY_AFTER.test(after);
    const moneyBefore = MONEY_BEFORE.test(before);
    if (!dollarBefore && !dollarAfter && !moneyAfter && !moneyBefore) continue;
    if (!dollarBefore && !dollarAfter && UNIT_AFTER.test(after)) continue;
    const whole = m[2].replace(/,/g, "");
    let cents = Number(whole) * 100 + (m[3] ? Number(m[3].padEnd(2, "0")) : 0);
    if (m[4]) cents *= 1000;
    if (!dollarBefore && !dollarAfter && !moneyAfter && cents < 1000) continue; // "only 2" / "rate of 3" — too small to be a price
    out.push(cents);
  }
  for (const m of masked.matchAll(SPELLED_RE)) {
    const start = m.index ?? 0;
    const value = parseSpelledNumber(m[0]);
    if (value === null || value < 10) continue;
    if (/\bgrand\b/i.test(m[0])) {
      out.push(value * 100);
      continue;
    }
    const before = masked.slice(Math.max(0, start - 28), start);
    const after = masked.slice(start + m[0].length, start + m[0].length + 24);
    if (!MONEY_AFTER.test(after) && !/\$\s?$/.test(before) && !MONEY_BEFORE.test(before)) continue;
    if (UNIT_AFTER.test(after)) continue;
    out.push(value * 100);
  }
  return out;
}

/** Amounts in `text` nobody vouched for. PURE. */
export function unvouchedAmounts(text: string, allowed: Iterable<number>): number[] {
  const ok = new Set(allowed);
  return extractAmountsCents(text).filter((c) => !ok.has(c));
}

const DEAL_RE =
  /\b(?:free(?!\s+to\b)|half[\s-]+(?:price|off|the\s+(?:price|cost|rate))|discount(?:s|ed)?|waived?|waiving|deals?|special\s+(?:offer|price|pricing|rate|deal)|on\s+special|specials\b|promo(?:tion)?s?|promo\s?code|coupons?|cheaper|bargain|price\s+match|(?:knock|take|knocking|taking)\s+(?:\S+\s+){0,3}off|\d\s*(?:\$|dollars|bucks)?\s+off\b|\$\s?\d[\d,.]*\s+off\b|(?:%|percent)|no\s+charge|on\s+the\s+house|complimentary|bogo)/gi;
const DEAL_OK = /\b(?:feel\s+free|toll[\s-]free|hands[\s-]free|free\s+to\b|carefree|worry[\s-]free|maintenance[\s-]free|free\s+of\s+(?:debris|snow|ice|leaves))/gi;

const NEGATED = /\b(?:can'?t|cannot|can\s+not|don'?t|do\s+not|doesn'?t|does\s+not|won'?t|aren'?t|isn'?t|unable\s+to|not\s+able\s+to|no|not|never|any)\s+(?:\S+\s+){0,2}$/i;

/**
 * A deal of any kind ("% off", "half price", "free first visit", "knock 100 off"). A plain
 * refusal ("we can't offer a discount", "no discounts") isn't a deal; "no charge" is. PURE.
 */
export function mentionsDeal(text: string): boolean {
  const masked = maskUrls(text).masked.replace(DEAL_OK, " ");
  for (const m of masked.matchAll(DEAL_RE)) {
    const word = m[0].toLowerCase();
    const before = masked.slice(Math.max(0, (m.index ?? 0) - 40), m.index ?? 0);
    const refusal = /^(?:discount|deal|special|promo|coupon|cheaper|bargain|price match)/.test(word) && NEGATED.test(before);
    if (!refusal) return true;
  }
  return false;
}

/** Kept for callers of the old name. */
export function mentionsPercentDeal(text: string): boolean {
  return mentionsDeal(text);
}

/**
 * The money guard: every amount must be vouched for, and no deal goes out without the owner.
 * PURE.
 */
export function moneyGuard(text: string, vouched: Iterable<number>): MoneyFinding {
  const amounts = unvouchedAmounts(text, vouched);
  const reasons: string[] = [];
  if (amounts.length) reasons.push(`${amounts.map((c) => (c < 0 ? "an amount" : `$${(c / 100).toLocaleString("en-CA", { maximumFractionDigits: 2 })}`)).join(", ")} isn't on your price list`);
  if (mentionsDeal(text)) reasons.push("it mentions a deal or discount");
  return { amounts, reasons };
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
  if (out.length <= MAX_REPLY_CHARS_WITH_LINK) return out;
  // Still too long: cut the words, never a link (links go last, whole).
  const present = uniqueLinks.filter((l) => out.includes(l));
  let words = out;
  for (const l of present) words = words.split(l).join(" ");
  words = words.replace(/\s+/g, " ").trim();
  const tail = present.length ? ` ${present.join(" ")}` : "";
  const room = Math.max(0, MAX_REPLY_CHARS_WITH_LINK - tail.length - 3);
  return `${words.slice(0, room).trimEnd()}...${tail}`;
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
