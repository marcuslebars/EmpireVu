/**
 * What the owner's words next to a receipt picture mean ("Jones job", "personal card", "fuel",
 * "PO-12"). PURE and conservative: anything unclear is left for the owner to "fix".
 */
import type { ExpenseCategory } from "@/server/services/expenses/rules";

/**
 * Words that name a compliance document (insurance certificate, WSIB clearance, licence…), the
 * same list as staff/compliance/kinds.ts. With these words the Tax Clerk still reads the picture
 * but files it only when its reader says it IS a receipt / supplier bill; otherwise it passes
 * and the Compliance role (next in registry order) takes it.
 */
const COMPLIANCE_RE =
  /\b(insurance|insured|insurer|certificates?|certs?|certifications?|coi|wsib|clearances?|licen[cs]es?|licen[cs]ed|permits?|tickets?|polic(y|ies)|bond(ed)?|whmis|first[ -]aid|working at heights|tssa|ecra|esa|309a|306a|313a|g2)\b/i;

export function namesComplianceDoc(text: string): boolean {
  return COMPLIANCE_RE.test(text);
}

/** "PO-12", "po 12", "P.O. #12" → "PO-12". */
export function poReferenceIn(text: string): string | null {
  const m = /\bp\.?\s?o\.?\s*(?:#|no\.?|number)?\s*[-:#]?\s*(\d{1,9})\b/i.exec(text);
  return m ? `PO-${Number(m[1])}` : null;
}

/** "personal card" → personal; "company card" → business; both or neither → null. */
export function paidWithIn(text: string): "business" | "personal" | null {
  const personal = /\b(personal|my own|own (card|money|pocket)|out of (my )?pocket|paid (it |for it )?myself|my (visa|mastercard|amex|debit|card|cash))\b/i.test(text);
  const business = /\b(business|company|corporate|biz|work) (card|visa|mastercard|amex|account|debit)\b/i.test(text);
  if (personal === business) return null;
  return personal ? "personal" : "business";
}

const CATEGORY_WORDS: Array<[ExpenseCategory, RegExp]> = [
  ["fuel", /\b(fuel|gas|gasoline|diesel|fill[- ]?up)\b/i],
  ["materials", /\b(materials?|supplies|lumber|shingles|parts|hardware)\b/i],
  ["tools", /\b(tools?)\b/i],
  ["equipment", /\b(rental|rented|equipment)\b/i],
  ["meals", /\b(meals?|lunch|dinner|breakfast|coffee|food)\b/i],
  ["vehicle", /\b(truck|van|vehicle|tires|tyres|oil change|mechanic)\b/i],
  ["subcontractor", /\b(sub|subs|subcontractor|subbie)\b/i],
  ["office", /\b(office|software|stationery|printer)\b/i],
  ["marketing", /\b(marketing|advertising|ads|flyers|signs?)\b/i],
  ["travel", /\b(parking|hotel|motel|travel|tolls?|407)\b/i],
  ["utilities", /\b(phone bill|internet|cell bill|hydro|utilities)\b/i],
  ["fees", /\b(bank fees?|card fees?|service charge)\b/i],
];

/** One clear category word → that category; none or two different ones → null. */
export function categoryIn(text: string): ExpenseCategory | null {
  const hits = new Set(CATEGORY_WORDS.filter(([, re]) => re.test(text)).map(([c]) => c));
  return hits.size === 1 ? [...hits][0] : null;
}

const STOP = new Set([
  "the", "for", "and", "job", "jobs", "receipt", "receipts", "invoice", "bill", "this", "that", "from", "with", "was", "were", "paid",
  "card", "personal", "business", "company", "cash", "debit", "visa", "mastercard", "amex", "my", "our", "his", "her", "their", "on",
  "at", "to", "of", "it", "its", "is", "a", "an", "today", "yesterday", "here", "please", "pls", "thanks", "put", "file", "under",
  "own", "pocket", "out", "work", "site", "house", "place",
]);

/** The words that might name a job or customer (lowercase, ≥3 letters, no filler / PO / category words). */
export function jobWordsIn(text: string): string[] {
  const cleaned = text
    .replace(/\bp\.?\s?o\.?\s*(?:#|no\.?|number)?\s*[-:#]?\s*\d{1,9}\b/gi, " ")
    .replace(/[$]\s?\d[\d,.]*/g, " ");
  const words = cleaned.toLowerCase().match(/[a-z][a-z'’-]{2,}/g) ?? [];
  const categoryWord = (w: string) => CATEGORY_WORDS.some(([, re]) => re.test(w));
  return [...new Set(words.map((w) => w.replace(/['’]s$/, "")).filter((w) => w.length >= 3 && !STOP.has(w) && !categoryWord(w)))];
}

export interface JobCandidate {
  bookingId: string;
  title: string;
  scheduledFor: string;
  contactId: string | null;
  firstName: string | null;
  lastName: string | null;
}

export type JobMatch = { kind: "none" } | { kind: "one"; job: JobCandidate } | { kind: "ambiguous"; jobs: JobCandidate[] };

const GENERIC_TITLE_WORDS = new Set(["job", "visit", "service", "estimate", "quote", "work", "call", "repair", "install", "installation", "new", "old"]);

function scoreOf(words: Set<string>, c: JobCandidate): number {
  let score = 0;
  const last = c.lastName?.trim().toLowerCase();
  const first = c.firstName?.trim().toLowerCase();
  if (last && last.length >= 3 && words.has(last)) score += 3;
  if (first && first.length >= 3 && words.has(first)) score += 2;
  for (const t of new Set(c.title.toLowerCase().match(/[a-z][a-z'’-]{2,}/g) ?? [])) {
    const w = t.replace(/['’]s$/, "");
    if (!GENERIC_TITLE_WORDS.has(w) && words.has(w) && w !== last && w !== first) score += 1;
  }
  return score;
}

/**
 * Which job the words name. A name (first or last) must match; title words only break ties. When
 * the best match is one customer with several jobs, the job closest to `nearDate` wins. Two
 * different customers tied → ambiguous (the owner is asked). PURE.
 */
export function matchJob(words: string[], candidates: JobCandidate[], nearDate: string): JobMatch {
  if (words.length === 0 || candidates.length === 0) return { kind: "none" };
  const set = new Set(words);
  const scored = candidates.map((c) => ({ c, score: scoreOf(set, c), named: Boolean((c.lastName && set.has(c.lastName.toLowerCase())) || (c.firstName && set.has(c.firstName.toLowerCase()))) }));
  const named = scored.filter((s) => s.named);
  // No name: a title word alone counts only when exactly one job has it ("the cottage dock").
  const pool = named.length ? named : scored.filter((s) => s.score >= 1);
  if (pool.length === 0) return { kind: "none" };
  const best = Math.max(...pool.map((s) => s.score));
  const top = pool.filter((s) => s.score === best).map((s) => s.c);
  if (!named.length && top.length > 1) return { kind: "none" };
  const people = new Set(top.map((c) => c.contactId ?? c.bookingId));
  if (people.size > 1) return { kind: "ambiguous", jobs: top.slice(0, 3) };
  const near = Date.parse(`${nearDate}T12:00:00Z`);
  const closest = [...top].sort((a, b) => Math.abs(Date.parse(a.scheduledFor) - near) - Math.abs(Date.parse(b.scheduledFor) - near))[0];
  return { kind: "one", job: closest };
}

/** "Jones roof" from a booking title and its customer — short, for the owner's reply. */
export function jobLabel(job: Pick<JobCandidate, "title" | "lastName" | "firstName">): string {
  const title = job.title.replace(/\s+/g, " ").trim();
  const name = job.lastName?.trim() || job.firstName?.trim() || "";
  if (!title) return name || "the job";
  if (name && !title.toLowerCase().includes(name.toLowerCase())) return `${name} ${title.length > 24 ? `${title.slice(0, 22).trimEnd()}…` : title}`;
  return title.length > 32 ? `${title.slice(0, 30).trimEnd()}…` : title;
}
