/**
 * Purchasing's words, all PURE (docs/ai-staff.md → "Purchasing"): quantities, the owner's
 * materials_order question, reading the owner's note on a "Y" ("Y 12 delivery", "Y 12 no nails",
 * "Y 12 25 bundles shingles"), the supplier email and the owner's call-in list.
 */
import { dollars, prettyPhone } from "@/server/services/front-desk/approval-text";
import type { Fulfilment, PoLine } from "./db-types";

/** Budget for the owner's question, before the code and the reply instruction. */
export const MAX_SUMMARY_CHARS = 430;

/** "22", "2.5", "0.25". */
export function formatQty(qty: number): string {
  if (!Number.isFinite(qty)) return "0";
  const rounded = Math.round(qty * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/0$/, "");
}

/** "22 bundles shingles", "3 rolls underlay", "4 drip edge". */
export function lineText(line: Pick<PoLine, "qty" | "unit" | "label">): string {
  const unit = line.unit?.trim();
  return `${formatQty(line.qty)} ${unit ? `${unit} ` : ""}${line.label.trim()}`.replace(/\s+/g, " ");
}

/** Estimated total of the lines (cents); lines with no estimate count as 0. */
export function estTotalCents(lines: PoLine[]): number {
  return lines.reduce((sum, l) => sum + (l.estUnitCostCents != null ? Math.round(l.qty * l.estUnitCostCents) : 0), 0);
}

/** Lines as one comma list that fits `max` characters ("…, +2 more"). */
export function linesList(lines: PoLine[], max: number): string {
  const parts = lines.map(lineText);
  let out = parts.join(", ");
  if (out.length <= max) return out;
  for (let keep = parts.length - 1; keep >= 1; keep--) {
    out = `${parts.slice(0, keep).join(", ")}, +${parts.length - keep} more`;
    if (out.length <= max) return out;
  }
  return `${parts[0].slice(0, Math.max(10, max - 12))}, +${parts.length - 1} more`;
}

/** "Wed Oct 14" for a local date "YYYY-MM-DD". */
export function dayLabel(dateStr: string | null | undefined): string {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return "";
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("en-CA", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).replace(/,/g, "");
}

/** "Wednesday, October 14" for the supplier email. */
export function longDayLabel(dateStr: string | null | undefined): string {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return "as soon as you can";
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("en-CA", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" });
}

/** "Jones" / "Dana Jones" → the job's short name for the owner ("Jones - Roof replacement"). */
export function jobLabel(input: { lastName?: string | null; firstName?: string | null; title?: string | null }): string {
  const who = input.lastName?.trim() || input.firstName?.trim() || "";
  const title = (input.title ?? "").replace(/\s+/g, " ").trim().slice(0, 50);
  if (who && title) return `${who} - ${title}`;
  return who || title || "the job";
}

/** "Home Depot Pro (Barrie)". */
export function supplierLabel(s: { name: string; branch?: string | null } | null | undefined): string | null {
  if (!s?.name?.trim()) return null;
  return s.branch?.trim() ? `${s.name.trim()} (${s.branch.trim()})` : s.name.trim();
}

export interface OrderSummaryInput {
  job: string;
  jobDay: string;
  poNumber: string;
  lines: PoLine[];
  estTotalCents: number;
  aiEstimate: boolean;
  supplier: string | null;
  supplierEmail: string | null;
  supplierPhone: string | null;
  fulfilment: Fulfilment;
  neededBy: string | null;
}

function fulfilmentPhrase(fulfilment: Fulfilment, neededBy: string | null): string {
  const day = dayLabel(neededBy);
  return fulfilment === "pickup" ? `for pickup${day ? ` ${day}` : ""}` : `for delivery${day ? ` by ${day}` : ""}`;
}

/** What Y does, in words. PURE. */
export function yesAction(input: Pick<OrderSummaryInput, "supplier" | "supplierEmail" | "supplierPhone" | "fulfilment" | "neededBy">): string {
  const when = fulfilmentPhrase(input.fulfilment, input.neededBy);
  if (input.supplier && input.supplierEmail) return `Y emails ${input.supplier} ${when}`;
  if (input.supplier) {
    const phone = prettyPhone(input.supplierPhone);
    return `Y texts you the list to call in to ${input.supplier}${phone ? ` (${phone})` : ""} ${when}`;
  }
  return `Y texts you the list to order ${when} (no supplier set up - text "add supplier")`;
}

/** The owner's materials_order question (the code and reply line are added when it's texted). PURE. */
export function buildOrderSummary(input: OrderSummaryInput): string {
  const money = input.estTotalCents > 0 ? `~${dollars(input.estTotalCents)}` : "no prices yet";
  const tail = `(${money}${input.aiEstimate ? ", AI estimate - check it" : ""}). ${yesAction(input)}.`;
  const head = `Materials for ${input.job} ${input.jobDay} (${input.poNumber}): `;
  const room = Math.max(40, MAX_SUMMARY_CHARS - head.length - tail.length - 1);
  return `${head}${linesList(input.lines, room)} ${tail}`;
}

// ── The owner's note on a "Y" ─────────────────────────────────────────────────────

export type NoteResult =
  | { ok: true; fulfilment: Fulfilment; lines: PoLine[]; changes: string[] }
  | { ok: false; why: string };

const FILLER = /^(?:but|please|pls|just|ok|okay|and|also|then|so|actually|make it|i'?ll|we'?ll|i will|we will|it|send it|order it|go ahead)\b[\s,]*/i;

function stem(word: string): string {
  const w = word.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (w.length > 4 && w.endsWith("es") && /(ch|sh|x|ss)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

const STOP_WORDS = new Set(["the", "of", "a", "an", "any", "for", "x", "box", "boxes", "roll", "rolls", "bundle", "bundles", "bag", "bags", "piece", "pieces", "pcs", "sheet", "sheets", "tube", "tubes", "ea", "each"]);

function words(text: string): string[] {
  return text.split(/[\s/,()-]+/).map(stem).filter(Boolean);
}

/** Lines whose label (+ unit) contain every meaningful word of `target`. */
export function matchLines(lines: PoLine[], target: string): number[] {
  const all = words(target);
  const meaningful = all.filter((w) => !STOP_WORDS.has(w) && w.length >= 2);
  const want = meaningful.length ? meaningful : all;
  if (want.length === 0) return [];
  const out: number[] = [];
  lines.forEach((line, i) => {
    const have = new Set(words(`${line.label} ${line.unit ?? ""}`));
    if (want.every((w) => have.has(w))) out.push(i);
  });
  return out;
}

/**
 * Read the owner's note on a materials_order "Y". Understood: pickup / delivery, leaving items
 * out ("no nails", "without underlay", "skip the drip edge") and changing an amount
 * ("25 bundles shingles", "shingles 25"). Anything else → not understood (nothing is sent; the
 * owner is asked again). PURE.
 */
export function parseOrderNote(note: string, lines: PoLine[], current: Fulfilment): NoteResult {
  const text = note
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[.!]+$/g, "")
    .trim();
  if (!text) return { ok: true, fulfilment: current, lines, changes: [] };
  const clauses = text
    .split(/\s*(?:,|;|&|\+|\band\b|\bplus\b|\balso\b)\s*|\s+(?=(?:no|without|skip|drop|minus|except|remove|delivery|deliver|delivered|pickup|pick up)\b)/)
    .map((c) => c.trim())
    .filter(Boolean);
  let fulfilment = current;
  let next = lines.map((l) => ({ ...l }));
  const changes: string[] = [];
  for (const raw of clauses) {
    let clause = raw;
    for (let i = 0; i < 4 && FILLER.test(clause); i++) clause = clause.replace(FILLER, "").trim();
    if (!clause) continue;
    if (/^(?:for |as a |as |by |get it |have it |have them )?(?:delivery|deliver(?:ed)?(?: it| them)?|ship(?: it)?|drop(?:ped)? off)$/.test(clause)) {
      if (fulfilment !== "delivery") changes.push("delivery");
      fulfilment = "delivery";
      continue;
    }
    if (/^(?:for |as a |as )?(?:pick ?up|pick(?: it| them)? up|pickup instead|grab(?: it| them)?)$/.test(clause)) {
      if (fulfilment !== "pickup") changes.push("pickup");
      fulfilment = "pickup";
      continue;
    }
    const remove = /^(?:no|without|skip|drop|minus|remove|except|leave (?:out|off)|hold(?: the)?|don'?t need(?: the)?|not)\s+(?:the\s+)?(.+)$/.exec(clause);
    if (remove) {
      const hit = matchLines(next, remove[1]);
      if (hit.length === 0) return { ok: false, why: `there's no "${remove[1]}" on the list` };
      changes.push(`no ${hit.map((i) => next[i].label).join(", ")}`);
      next = next.filter((_, i) => !hit.includes(i));
      continue;
    }
    const qtyFirst = /^(?:only\s+|just\s+)?(\d{1,5}(?:\.\d{1,2})?)\s*(?:x\s+)?([a-z].*)$/.exec(clause);
    const qtyLast = /^([a-z][a-z\s'/-]*?)\s*(?:x\s*)?(\d{1,5}(?:\.\d{1,2})?)$/.exec(clause);
    const amount = qtyFirst ? { qty: Number(qtyFirst[1]), target: qtyFirst[2] } : qtyLast ? { qty: Number(qtyLast[2]), target: qtyLast[1] } : null;
    if (amount) {
      if (!(amount.qty > 0 && amount.qty <= 100_000)) return { ok: false, why: `${formatQty(amount.qty)} doesn't look like an amount` };
      const hit = matchLines(next, amount.target);
      if (hit.length !== 1) return { ok: false, why: hit.length ? `"${amount.target}" matches more than one item` : `there's no "${amount.target}" on the list` };
      next[hit[0]] = { ...next[hit[0]], qty: amount.qty };
      changes.push(lineText(next[hit[0]]));
      continue;
    }
    return { ok: false, why: `I'm not sure what "${raw}" means` };
  }
  if (next.length === 0) return { ok: false, why: "that leaves nothing to order" };
  return { ok: true, fulfilment, lines: next, changes };
}

/** A short item word for the reply line's example ("Y 12 no nails"). PURE. */
export function exampleItem(lines: PoLine[]): string | null {
  for (const line of [...lines].reverse()) {
    const w = line.label.trim().split(/\s+/).pop()?.toLowerCase().replace(/[^a-z]/g, "");
    if (w && w.length >= 3 && w.length <= 14) return w;
  }
  return null;
}

// ── Supplier email and the owner's call-in list ────────────────────────────────────

export interface SupplierEmailInput {
  companyName: string;
  supplierName: string;
  poNumber: string;
  accountNumber: string | null;
  fulfilment: Fulfilment;
  neededBy: string | null;
  deliverTo: string | null;
  lines: PoLine[];
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The supplier's email: PO number, list, needed-by, pickup/delivery, account. No prices, no customer name. PURE. */
export function renderSupplierEmail(input: SupplierEmailInput): { subject: string; text: string; html: string } {
  const when = longDayLabel(input.neededBy);
  const ask = input.fulfilment === "pickup" ? `Please have this order ready for pickup on ${when}.` : `Please deliver this order by ${when}.`;
  const facts = [
    `PO number: ${input.poNumber}`,
    input.accountNumber?.trim() ? `Account: ${input.accountNumber.trim()}` : null,
    `${input.fulfilment === "pickup" ? "Pickup" : "Delivery"}: ${when}`,
    input.fulfilment === "delivery" ? `Deliver to: ${input.deliverTo?.trim() || "we'll confirm the address by reply"}` : null,
  ].filter((l): l is string => Boolean(l));
  const items = input.lines.map((l) => `- ${lineText(l)}`);
  const subject = `Purchase order ${input.poNumber} - ${input.companyName} (${input.fulfilment === "pickup" ? "pickup" : "delivery"} ${dayLabel(input.neededBy) || "ASAP"})`;
  const text = [
    `Hi ${input.supplierName},`,
    "",
    ask,
    "",
    ...facts,
    "",
    "Items:",
    ...items,
    "",
    "Please reply to this email to confirm, or to let us know about anything out of stock or substituted.",
    "",
    "Thanks,",
    input.companyName,
  ].join("\n");
  const html = [
    `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:15px;line-height:1.5;color:#111">`,
    `<p>Hi ${esc(input.supplierName)},</p>`,
    `<p>${esc(ask)}</p>`,
    `<p>${facts.map(esc).join("<br>")}</p>`,
    `<p><strong>Items</strong></p><ul style="margin:0;padding-left:20px">${input.lines.map((l) => `<li>${esc(lineText(l))}</li>`).join("")}</ul>`,
    `<p>Please reply to this email to confirm, or to let us know about anything out of stock or substituted.</p>`,
    `<p>Thanks,<br>${esc(input.companyName)}</p>`,
    `</div>`,
  ].join("");
  return { subject, text, html };
}

/** The owner's text when there's no supplier email: the list to call in. PURE. */
export function callInText(input: { poNumber: string; job: string; supplier: string | null; supplierPhone: string | null; accountNumber: string | null; fulfilment: Fulfilment; neededBy: string | null; lines: PoLine[] }): string {
  const phone = prettyPhone(input.supplierPhone);
  const to = input.supplier ? `${input.supplier}${phone ? ` (${phone})` : ""}` : "your supplier";
  const account = input.accountNumber?.trim() ? ` Account ${input.accountNumber.trim()}.` : "";
  const head = `Call in ${input.poNumber} to ${to} ${fulfilmentPhrase(input.fulfilment, input.neededBy)} (${input.job}).${account} `;
  const tail = ` Text "${input.poNumber} ready" when it's ready.`;
  return `${head}${linesList(input.lines, Math.max(60, 600 - head.length - tail.length))}.${tail}`;
}
