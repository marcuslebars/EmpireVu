/**
 * One spreadsheet row + the column mapping → a clean customer record (or the reason it can't be
 * used). Phones to E.164 (North American numbers; "+…" kept), emails lowercased, names split,
 * dates read in the column's own format (YYYY-MM-DD, MM/DD/YYYY or DD/MM/YYYY, "Jun 14 2025",
 * Excel serial numbers), money as cents. PURE.
 */
import { createHash } from "node:crypto";

import type { ImportField } from "./db-types";

export interface ImportedJob {
  date: string;
  description: string | null;
  amountCents: number | null;
}

export interface ImportRecord {
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  phone: string | null;
  otherPhones: string[];
  email: string | null;
  address: string | null;
  notes: string | null;
  tags: string[];
  /** Past completed work from this row (a job date, or the last service date). */
  job: ImportedJob | null;
  balanceCents: number;
  balanceDate: string | null;
  balanceDueDate: string | null;
  invoiceRef: string | null;
  /** Problems that didn't stop the row (a phone we couldn't read, a future job date…). */
  warnings: string[];
}

export type DateOrder = "ymd" | "mdy" | "dmy";

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function validYmd(y: number, m: number, d: number): string | null {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (y < 1950 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCMonth() !== m - 1) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

function fullYear(y: number): number {
  if (y >= 100) return y;
  return y <= 69 ? 2000 + y : 1900 + y;
}

/**
 * Which way round a column's slash dates are: any first part > 12 → day first; any second part
 * > 12 → month first; otherwise month first (QuickBooks / Jobber / Square in Canada). PURE.
 */
export function detectDateOrder(values: string[]): DateOrder {
  let dayFirst = false;
  let monthFirst = false;
  for (const v of values) {
    const m = /^\s*(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b/.exec(v);
    if (!m) continue;
    if (Number(m[1]) > 12) dayFirst = true;
    if (Number(m[2]) > 12) monthFirst = true;
  }
  if (dayFirst && !monthFirst) return "dmy";
  return "mdy";
}

/** A date cell → YYYY-MM-DD, or null. PURE. */
export function parseDate(value: string, order: DateOrder = "mdy"): string | null {
  const v = value.trim();
  if (!v) return null;
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/.exec(v);
  if (m) return validYmd(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?:[T\s].*)?$/.exec(v);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const y = fullYear(Number(m[3]));
    return order === "dmy" ? validYmd(y, b, a) : validYmd(y, a, b);
  }
  // "Jun 14, 2025", "June 14 2025", "14 Jun 2025", "Sat, Jun 14, 2025"
  const cleaned = v.toLowerCase().replace(/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+/, "").replace(/,/g, " ").replace(/\s+/g, " ").trim();
  m = /^([a-z]+)\.? (\d{1,2})(?:st|nd|rd|th)? (\d{4})/.exec(cleaned);
  if (m && MONTHS[m[1]]) return validYmd(Number(m[3]), MONTHS[m[1]], Number(m[2]));
  m = /^(\d{1,2}) ([a-z]+)\.? (\d{4})/.exec(cleaned);
  if (m && MONTHS[m[2]]) return validYmd(Number(m[3]), MONTHS[m[2]], Number(m[1]));
  // An Excel serial day number (1900 system) that survived as text.
  if (/^\d{5}(\.\d+)?$/.test(v)) {
    const serial = Math.floor(Number(v));
    if (serial > 18000 && serial < 80000) {
      const d = new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000);
      return validYmd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    }
  }
  return null;
}

/** "$1,234.56" / "(45.00)" / "1 234.50 CAD" → cents; null when it isn't money. PURE. */
export function parseMoney(value: string): number | null {
  let v = value.trim();
  if (!v) return null;
  let negative = false;
  if (/^\(.*\)$/.test(v)) {
    negative = true;
    v = v.slice(1, -1);
  }
  v = v.replace(/\b(cad|usd|ca\$|us\$)\b/gi, "").replace(/[$\s]/g, "");
  if (v.startsWith("-")) {
    negative = !negative;
    v = v.slice(1);
  }
  if (/cr$/i.test(v)) {
    negative = !negative;
    v = v.slice(0, -2);
  }
  if (!/^\d{1,3}(,\d{3})*(\.\d+)?$|^\d+(\.\d+)?$/.test(v)) return null;
  const n = Number(v.replace(/,/g, ""));
  if (!Number.isFinite(n) || n > 10_000_000) return null;
  const cents = Math.round(n * 100);
  return negative ? -cents : cents;
}

/** A phone cell → E.164, or null. North American 10/11 digits, or an explicit "+" number. PURE. */
export function normalizePhone(value: string): string | null {
  const v = value.trim().replace(/\s*(x|ext\.?|extension)\s*\d+$/i, "");
  if (!v) return null;
  const digits = v.replace(/\D/g, "");
  if (v.startsWith("+")) {
    if (digits.startsWith("1")) return digits.length === 11 && /^1[2-9]\d{2}[2-9]\d{6}$/.test(digits) ? `+${digits}` : null;
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (ten.length !== 10 || !/^[2-9]\d{2}[2-9]\d{6}$/.test(ten)) return null;
  return `+1${ten}`;
}

/** A cell may hold several numbers ("705-555-0123 / 705-555-0199"). PURE. */
export function phonesIn(value: string): { phones: string[]; bad: boolean } {
  const parts = value.split(/[;,/|]|\s{2,}|\bor\b|\band\b/i).map((p) => p.trim()).filter(Boolean);
  const phones: string[] = [];
  let bad = false;
  for (const part of parts) {
    const p = normalizePhone(part);
    if (p) phones.push(p);
    else if (/\d{3}/.test(part)) bad = true;
  }
  if (phones.length === 0 && value.trim()) {
    const whole = normalizePhone(value);
    if (whole) return { phones: [whole], bad: false };
  }
  return { phones, bad };
}

const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[a-z]{2,}$/i;

/** First valid email in a cell, lowercased. PURE. */
export function normalizeEmail(value: string): string | null {
  for (const part of value.split(/[;,\s]+/)) {
    const p = part.trim().replace(/^mailto:/i, "").replace(/^<|>$/g, "");
    if (EMAIL_RE.test(p) && p.length <= 254) return p.toLowerCase();
  }
  return null;
}

function titleish(value: string): string {
  const v = value.trim().replace(/\s+/g, " ");
  // ALL CAPS or all lower → Title Case; mixed case is left as the owner typed it.
  if (v === v.toUpperCase() || v === v.toLowerCase()) {
    return v.toLowerCase().replace(/(^|[\s'-])([a-zà-ÿ])/g, (_, a: string, b: string) => `${a}${b.toUpperCase()}`);
  }
  return v;
}

/** "Lee, Jamie" / "Jamie Lee" / "Mr. Jamie A. Lee" → first + last. PURE. */
export function splitName(full: string): { first: string | null; last: string | null } {
  let v = full.trim().replace(/\s+/g, " ");
  if (!v) return { first: null, last: null };
  if (v.includes(",")) {
    const [last, first] = v.split(",", 2).map((s) => s.trim());
    if (first && last && !/\b(inc|ltd|llc|corp)\b/i.test(first)) return { first: titleish(first), last: titleish(last) };
    v = v.replace(/,/g, " ").trim();
  }
  v = v.replace(/^(mr|mrs|ms|miss|dr|mx)\.?\s+/i, "");
  const parts = v.split(" ");
  if (parts.length === 1) return { first: titleish(parts[0]), last: null };
  return { first: titleish(parts[0]), last: titleish(parts.slice(1).join(" ")) };
}

function joinCells(values: string[], sep: string): string | null {
  const out = values.map((v) => v.trim()).filter(Boolean);
  return out.length ? [...new Set(out)].join(sep) : null;
}

export interface RecordContext {
  /** Per-column date order (only date columns matter). */
  dateOrders: DateOrder[];
  /** YYYY-MM-DD today (company time zone): a job on or after it isn't past work. */
  today: string;
}

/** The date order for every column of a file, from all its values. PURE. */
export function dateOrdersFor(rows: string[][], columns: number): DateOrder[] {
  return Array.from({ length: columns }, (_, c) => detectDateOrder(rows.map((r) => r[c] ?? "")));
}

export type RecordResult = { ok: true; record: ImportRecord; reason?: undefined } | { ok: false; reason: string; record?: undefined };

/** One row → a record, or why it can't be imported. PURE. */
export function buildRecord(cells: string[], mapping: ImportField[], ctx: RecordContext): RecordResult {
  const by = (field: ImportField) => mapping.map((f, i) => (f === field ? i : -1)).filter((i) => i >= 0);
  const first = (field: ImportField) => {
    const col = by(field)[0];
    return col === undefined ? "" : (cells[col] ?? "").trim();
  };
  const date = (field: ImportField) => {
    const col = by(field)[0];
    if (col === undefined) return { value: null as string | null, raw: "" };
    const raw = (cells[col] ?? "").trim();
    return { value: raw ? parseDate(raw, ctx.dateOrders[col] ?? "mdy") : null, raw };
  };
  const warnings: string[] = [];

  let firstName = first("first_name") ? titleish(first("first_name")) : null;
  let lastName = first("last_name") ? titleish(first("last_name")) : null;
  const full = first("full_name");
  if (full && !firstName && !lastName) {
    const split = splitName(full);
    firstName = split.first;
    lastName = split.last;
  } else if (full && firstName && !lastName) {
    const split = splitName(full);
    if (split.first?.toLowerCase() === firstName.toLowerCase()) lastName = split.last;
  }
  const company = first("company") ? first("company").replace(/\s+/g, " ").slice(0, 200) : null;

  const phones: string[] = [];
  for (const col of by("phone")) {
    const { phones: found, bad } = phonesIn(cells[col] ?? "");
    for (const p of found) if (!phones.includes(p)) phones.push(p);
    if (bad) warnings.push(`couldn't read the phone "${(cells[col] ?? "").slice(0, 30)}"`);
  }
  let email: string | null = null;
  const emailRaw = first("email");
  if (emailRaw) {
    email = normalizeEmail(emailRaw);
    if (!email) warnings.push(`couldn't read the email "${emailRaw.slice(0, 40)}"`);
  }
  const address = joinCells(by("address").map((c) => cells[c] ?? ""), ", ");
  const notes = joinCells(by("notes").map((c) => cells[c] ?? ""), "\n");
  const tags = [...new Set(by("tags").flatMap((c) => (cells[c] ?? "").split(/[,;|]/).map((t) => t.trim()).filter(Boolean)))].slice(0, 20);

  if (!firstName && !lastName && !company && phones.length === 0 && !email) {
    return { ok: false, reason: by("phone").length || by("email").length ? "no name, phone or email we could read" : "no name, phone or email" };
  }

  // Past work: a job date on this row, else the last service date.
  let job: ImportedJob | null = null;
  const jobDate = date("job_date");
  const lastService = date("last_service_date");
  const pick = jobDate.raw ? jobDate : lastService;
  if (pick.raw) {
    if (!pick.value) warnings.push(`couldn't read the date "${pick.raw.slice(0, 30)}"`);
    else if (pick.value >= ctx.today) warnings.push(`job date ${pick.value} isn't in the past, so no past job`);
    else {
      const amountRaw = first("job_amount");
      const amount = amountRaw ? parseMoney(amountRaw) : null;
      if (amountRaw && amount === null) warnings.push(`couldn't read the amount "${amountRaw.slice(0, 20)}"`);
      const description = first("job_description").slice(0, 300) || null;
      job = { date: pick.value, description: jobDate.raw ? description : description ?? null, amountCents: amount !== null && amount >= 0 ? amount : null };
    }
  }

  let balanceCents = 0;
  const balanceRaw = first("balance");
  if (balanceRaw) {
    const b = parseMoney(balanceRaw);
    if (b === null) warnings.push(`couldn't read the balance "${balanceRaw.slice(0, 20)}"`);
    else if (b < 0) warnings.push("a credit balance, not money owing - skipped");
    else balanceCents = b;
  }
  const balanceDate = date("balance_date").value;
  const balanceDueDate = date("balance_due_date").value;
  const invoiceRef = first("invoice_ref").slice(0, 60) || null;

  if (!firstName && !lastName && company) firstName = company;
  return {
    ok: true,
    record: {
      firstName: firstName?.slice(0, 100) ?? null,
      lastName: lastName?.slice(0, 100) ?? null,
      company,
      phone: phones[0] ?? null,
      otherPhones: phones.slice(1, 4),
      email,
      address: address?.slice(0, 300) ?? null,
      notes: notes?.slice(0, 2000) ?? null,
      tags,
      job,
      balanceCents,
      balanceDate,
      balanceDueDate,
      invoiceRef,
      warnings,
    },
  };
}

/** The name the contact gets (contacts.first_name is required). PURE. */
export function displayName(r: Pick<ImportRecord, "firstName" | "lastName" | "company" | "phone" | "email">): string {
  const name = [r.firstName, r.lastName].filter(Boolean).join(" ");
  return name || r.company || r.email || r.phone || "Customer";
}

/** Last 10 digits of a North American number (how contacts are matched). PURE. */
export function phoneLast10(phone: string | null): string | null {
  if (!phone) return null;
  const d = phone.replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : null;
}

/**
 * Who this row is, for matching: phone last-10, else email, else the lowercased name. Rows of
 * one file with the same identity are the same customer. PURE.
 */
export function identityKey(r: ImportRecord): string {
  const p = phoneLast10(r.phone);
  if (p) return `p:${p}`;
  if (r.email) return `e:${r.email}`;
  return `n:${displayName(r).toLowerCase().replace(/\s+/g, " ")}`;
}

export function sha(text: string, length = 32): string {
  return createHash("sha256").update(text).digest("hex").slice(0, length);
}

/** Same cells → same hash (row-level idempotency within a batch). PURE. */
export function rowHash(cells: string[]): string {
  return sha(JSON.stringify(cells.map((c) => c.trim())));
}

/** The past job's idempotency key (bookings.source_call_id): same customer + date + work. PURE. */
export function jobKey(companyId: string, contactId: string, job: ImportedJob): string {
  return `import:${sha(`${companyId}|${contactId}|${job.date}|${(job.description ?? "").toLowerCase()}|${job.amountCents ?? ""}`, 24)}`;
}

/** The open balance's idempotency key (invoices.import_key). PURE. */
export function balanceKey(contactId: string, r: Pick<ImportRecord, "invoiceRef" | "balanceCents" | "balanceDate">): string {
  if (r.invoiceRef) return sha(`${contactId}|ref|${r.invoiceRef.toLowerCase()}`, 24);
  return sha(`${contactId}|${r.balanceDate ?? ""}|${r.balanceCents}`, 24);
}
