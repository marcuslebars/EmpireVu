/**
 * Receipts by text (the Tax Clerk's ownerMedia handler, docs/ai-staff.md → "Receipts & HST").
 *
 * The owner texts a photo or PDF of a receipt / supplier bill to the platform number, maybe with
 * words ("Jones job", "personal card", "fuel", "PO-12"). We:
 *   1. pass (null) when the words name a compliance document (insurance, WSIB, licence…) or
 *      receipts are off, so the Compliance role or the old "Got the picture" reply takes it;
 *   2. fetch up to 3 pictures (Twilio auth + SSRF guard, PDFs ≤ 10 MB) and claim each one in
 *      receipt_texts (unique log id + media index — a redelivered text files nothing twice);
 *   3. read each with readReceipt (it also says whether it IS a receipt / supplier bill; when
 *      it isn't we pass);
 *   4. map the words to a job (recent / upcoming bookings by customer name), paid-with, a
 *      category and a PO reference;
 *   5. skip duplicates (same vendor, date and total in the company), else store the picture in
 *      expense-receipts (PNG wrapped in a PDF) and create the `expenses` row (company set, so it
 *      syncs to QuickBooks/Xero; created_by = the owner's profile);
 *   6. reply in one text: Got it: Home Depot $84.20 (HST $9.69), Materials, Jones roof (Oct 14).
 *      Reply "fix" to change it.
 * A receipt with no readable total is kept as a picture to finish (needs_review) — no expense
 * until the owner texts the amount ("fix $84.20") or finishes it in Settings.
 * Never throws (the owner channel would skip us anyway).
 */
import { randomUUID } from "node:crypto";

import { readReceipt, ReceiptReadingUnavailableError, type ReaderImageType, type ReceiptDocKind } from "@/server/ai/receipt-reader";
import { isAIConfigured } from "@/server/ai/claude";
import { addDays, localDate } from "@/server/services/booking-windows";
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { receiptPathFor, type ExpenseCategory, type ReceiptScan, type ReceiptType } from "@/server/services/expenses/rules";
import { recordAiUsageSafe } from "@/server/services/usage";
import type { OwnerMediaHandler, OwnerMediaInput, OwnerMediaResult } from "@/server/services/staff/types";
import type { Db, ExpenseLite, ReceiptTextRow } from "./db-types";
import { money } from "./hst";
import { makeReceiptMediaFetcher, receiptMediaType, type FetchedReceiptMedia, type ReceiptMediaFetcher } from "./media";
import { pngAsPdf } from "./pdf";
import { loadTaxClerkCompany, ownerProfileId, type TaxClerkCompany } from "./settings";
import { supabaseReceiptStorage, type ReceiptStorage } from "./storage";
import { categoryIn, jobLabel, jobWordsIn, matchJob, namesComplianceDoc, paidWithIn, poReferenceIn, type JobCandidate, type JobMatch } from "./words";

export function taxClerkModel(): string {
  return process.env.AI_MODEL_TAX_CLERK?.trim() || "claude-sonnet-5-5";
}

export interface ReadResult {
  kind: ReceiptDocKind;
  scan: ReceiptScan;
}

export interface ReceiptDeps {
  fetchMedia: ReceiptMediaFetcher;
  /** null → no reader (ANTHROPIC_API_KEY unset); throws → the model call failed. */
  read(file: { bytes: Buffer; type: ReceiptType | ReaderImageType }, today: string, scope: { organizationId: string; companyId: string }): Promise<ReadResult | null>;
  storage(admin: AdminClient): ReceiptStorage;
  newId(): string;
}

export const defaultReceiptDeps: ReceiptDeps = {
  fetchMedia: makeReceiptMediaFetcher(),
  async read(file, today, scope) {
    if (!isAIConfigured()) return null;
    try {
      const { scan, usage, kind } = await readReceipt(file, today, { model: taxClerkModel(), withKind: true });
      await recordAiUsageSafe({ organizationId: scope.organizationId, companyId: scope.companyId, model: usage.model, responseId: usage.responseId, usage: usage.usage });
      return { kind: kind ?? "receipt", scan };
    } catch (err) {
      if (err instanceof ReceiptReadingUnavailableError) return null;
      throw err;
    }
  },
  storage: (admin) => supabaseReceiptStorage(admin),
  newId: () => randomUUID(),
};

let activeDeps: ReceiptDeps = defaultReceiptDeps;

export function currentReceiptDeps(): ReceiptDeps {
  return activeDeps;
}

/** Test hook: the owner channel calls the handler without deps. */
export function setReceiptDeps(deps: Partial<ReceiptDeps> | null): void {
  activeDeps = deps ? { ...defaultReceiptDeps, ...deps } : defaultReceiptDeps;
}

const SHORT_CATEGORY: Record<string, string> = {
  materials: "Materials",
  fuel: "Fuel",
  equipment: "Equipment rental",
  tools: "Tools",
  subcontractor: "Subcontractor",
  vehicle: "Vehicle",
  insurance: "Insurance",
  office: "Office",
  marketing: "Marketing",
  meals: "Meals",
  travel: "Travel",
  utilities: "Phone & utilities",
  fees: "Fees",
  other: "Other",
};

export function shortCategory(category: string): string {
  return SHORT_CATEGORY[category] ?? "Other";
}

/** "Oct 14". */
export function dayLabel(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  return d.toLocaleDateString("en-CA", { timeZone: "UTC", month: "short", day: "numeric" });
}

/** Words that say "this picture is a receipt" when there's no reader to ask. */
export function soundsLikeReceipt(text: string): boolean {
  return /\b(receipts?|invoices?|bills?|bought|purchased?|paid|expense)\b/i.test(text) || Boolean(poReferenceIn(text) || paidWithIn(text) || categoryIn(text));
}

// ── Jobs ─────────────────────────────────────────────────────────────────────

/** Bookings near the receipt date (45 days back, 30 ahead), not cancelled, with their customer's name. */
export async function jobCandidates(admin: AdminClient, scope: { organizationId: string; companyId: string }, around: string): Promise<JobCandidate[]> {
  const db = admin as Db;
  const { data } = await db
    .from("bookings")
    .select("id, title, scheduled_for, contact_id, status")
    .eq("organization_id", scope.organizationId)
    .eq("company_id", scope.companyId)
    .gte("scheduled_for", `${addDays(around, -45)}T00:00:00Z`)
    .lte("scheduled_for", `${addDays(around, 31)}T00:00:00Z`)
    .order("scheduled_for", { ascending: true })
    .limit(500);
  const bookings = ((data ?? []) as Array<{ id: string; title: string | null; scheduled_for: string; contact_id: string | null; status: string }>).filter((b) => b.status !== "cancelled");
  const contactIds = [...new Set(bookings.map((b) => b.contact_id).filter((v): v is string => !!v))];
  const names = new Map<string, { first_name: string | null; last_name: string | null }>();
  for (let i = 0; i < contactIds.length; i += 200) {
    const { data: contacts } = await db.from("contacts").select("id, first_name, last_name").eq("organization_id", scope.organizationId).in("id", contactIds.slice(i, i + 200));
    for (const c of (contacts ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null }>) names.set(c.id, c);
  }
  return bookings.map((b) => ({
    bookingId: b.id,
    title: b.title ?? "",
    scheduledFor: b.scheduled_for,
    contactId: b.contact_id,
    firstName: b.contact_id ? (names.get(b.contact_id)?.first_name ?? null) : null,
    lastName: b.contact_id ? (names.get(b.contact_id)?.last_name ?? null) : null,
  }));
}

/** The booking a Purchasing order (purchase_orders.po_number, e.g. "PO-12") was for. Tolerant: no table → null. */
export async function bookingForPo(admin: AdminClient, scope: { organizationId: string; companyId: string }, po: string): Promise<string | null> {
  try {
    const { data, error } = await (admin as Db)
      .from("purchase_orders")
      .select("booking_id")
      .eq("organization_id", scope.organizationId)
      .eq("company_id", scope.companyId)
      .eq("po_number", po.toUpperCase())
      .maybeSingle();
    if (error || !data) return null;
    return (data as { booking_id: string | null }).booking_id ?? null;
  } catch {
    return null;
  }
}

/** "Jones roof (Oct 14)". */
export function jobPhrase(job: JobCandidate, timeZone: string): string {
  return `${jobLabel(job)} (${dayLabel(localDate(new Date(job.scheduledFor), timeZone))})`;
}

// ── Filing ───────────────────────────────────────────────────────────────────

export interface WordsMeaning {
  category: ExpenseCategory | null;
  paidWith: "business" | "personal" | null;
  po: string | null;
  jobWords: string[];
}

export function meaningOf(body: string): WordsMeaning {
  return { category: categoryIn(body), paidWith: paidWithIn(body), po: poReferenceIn(body), jobWords: jobWordsIn(body) };
}

const norm = (v: string | null | undefined) => (v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** An expense in this company with the same vendor, date and total. */
export async function findDuplicate(
  admin: AdminClient,
  scope: { organizationId: string; companyId: string },
  e: { vendor: string | null; spentOn: string; amountCents: number },
): Promise<ExpenseLite | null> {
  const { data } = await (admin as Db)
    .from("expenses")
    .select("id, organization_id, company_id, booking_id, spent_on, vendor, description, category, amount_cents, tax_cents, paid_with, receipt_path, receipt_type, created_by, created_at")
    .eq("organization_id", scope.organizationId)
    .eq("company_id", scope.companyId)
    .eq("spent_on", e.spentOn)
    .eq("amount_cents", e.amountCents)
    .limit(20);
  return ((data ?? []) as ExpenseLite[]).find((x) => norm(x.vendor) === norm(e.vendor)) ?? null;
}

/** Store the picture (jpeg / pdf as is, PNG inside a PDF). Null → can't keep that type, or the upload failed. */
async function storeFile(admin: AdminClient, deps: ReceiptDeps, organizationId: string, media: FetchedReceiptMedia): Promise<{ path: string; type: ReceiptType } | null> {
  let bytes: Uint8Array;
  let type: ReceiptType;
  try {
    if (media.type === "image/jpeg" || media.type === "application/pdf") {
      bytes = media.bytes;
      type = media.type;
    } else if (media.type === "image/png") {
      bytes = await pngAsPdf(media.bytes);
      type = "application/pdf";
    } else return null;
    const path = receiptPathFor(organizationId, deps.newId(), type);
    await deps.storage(admin).upload(organizationId, path, bytes, type);
    return { path, type };
  } catch (err) {
    console.error("[tax-clerk] receipt upload failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

export interface FiledReceipt {
  row: ReceiptTextRow;
  /** One line for the reply. */
  line: string;
  /** Extra sentences (ask which job, date guessed…). */
  notes: string[];
}

async function updateRow(admin: AdminClient, row: ReceiptTextRow, patch: Partial<ReceiptTextRow>): Promise<ReceiptTextRow> {
  const { data } = await (admin as Db).from("receipt_texts").update(patch).eq("id", row.id).eq("organization_id", row.organization_id).select("*");
  return ((data ?? []) as ReceiptTextRow[])[0] ?? { ...row, ...patch };
}

/** Claim one picture (insert); null → already claimed (a redelivery or another worker). */
async function claim(admin: AdminClient, company: TaxClerkCompany, input: OwnerMediaInput, index: number): Promise<ReceiptTextRow | null> {
  const { data, error } = await (admin as Db)
    .from("receipt_texts")
    .insert({
      organization_id: company.organizationId,
      company_id: company.companyId,
      log_id: input.logId,
      media_index: index,
      status: "reading",
      created_at: new Date(input.nowMs).toISOString(),
      owner_words: input.body.trim().slice(0, 500) || null,
    })
    .select("*")
    .single();
  if (error || !data) return null;
  return data as ReceiptTextRow;
}

/** File one receipt that has a total. */
async function fileReceipt(
  admin: AdminClient,
  company: TaxClerkCompany,
  input: OwnerMediaInput,
  row: ReceiptTextRow,
  media: FetchedReceiptMedia,
  scan: ReceiptScan,
  meaning: WordsMeaning,
  jobs: () => Promise<JobCandidate[]>,
  deps: ReceiptDeps,
  today: string,
): Promise<FiledReceipt> {
  const scope = { organizationId: company.organizationId, companyId: company.companyId };
  const notes: string[] = [];
  const amount = scan.amountCents as number;
  const spentOn = scan.spentOn ?? today;
  const vendor = scan.vendor;
  if (!scan.spentOn) notes.push("Dated today (couldn't read the date).");

  const dup = await findDuplicate(admin, scope, { vendor, spentOn, amountCents: amount });
  if (dup) {
    const done = await updateRow(admin, row, { status: "duplicate", duplicate_of: dup.id, vendor, spent_on: spentOn, amount_cents: amount, tax_cents: scan.taxCents });
    return { row: done, line: `Already have that one: ${vendor ?? "receipt"} ${money(amount)} on ${dayLabel(spentOn)} - not added again`, notes: [] };
  }

  let job: JobCandidate | null = null;
  let match: JobMatch = { kind: "none" };
  if (meaning.jobWords.length) {
    match = matchJob(meaning.jobWords, await jobs(), spentOn);
    if (match.kind === "one") job = match.job;
    else if (match.kind === "ambiguous") notes.push(`Which job: ${match.jobs.map((j) => jobPhrase(j, company.timeZone)).join(" or ")}? Text "fix job" and the name.`);
  }
  // "PO-12" with no job named: the job that Purchasing ordered PO-12 for.
  if (!job && match.kind !== "ambiguous" && meaning.po) {
    const poBooking = await bookingForPo(admin, scope, meaning.po);
    if (poBooking) job = (await jobs()).find((j) => j.bookingId === poBooking) ?? null;
  }
  const category: ExpenseCategory = meaning.category ?? scan.category ?? "other";
  const tax = scan.taxCents ?? 0;
  const paidWith = meaning.paidWith ?? "business";
  const owner = await ownerProfileId(admin, company.organizationId, input.ownerPhone);
  const file = await storeFile(admin, deps, company.organizationId, media);
  if (!file) notes.push(media.type === "image/webp" || media.type === "image/gif" ? "I couldn't keep a copy of that picture type - snap it as a normal photo if you need it on file." : "I couldn't save the picture, so it's filed without one.");
  if (!owner) {
    const review = await updateRow(admin, row, {
      status: "needs_review",
      file_path: file?.path ?? null,
      file_type: file?.type ?? null,
      vendor,
      spent_on: spentOn,
      amount_cents: amount,
      tax_cents: scan.taxCents,
      category,
      description: scan.description,
      booking_id: job?.bookingId ?? null,
      paid_with: paidWith,
      po_reference: meaning.po,
      missing: ["owner_profile"],
    });
    return { row: review, line: `Saved ${vendor ?? "the receipt"} ${money(amount)} to finish in the app (no owner account to file it under)`, notes: [] };
  }

  const { data: inserted, error } = await (admin as Db)
    .from("expenses")
    .insert({
      organization_id: company.organizationId,
      company_id: company.companyId,
      booking_id: job?.bookingId ?? null,
      spent_on: spentOn,
      vendor,
      description: scan.description,
      category,
      amount_cents: amount,
      tax_cents: Math.min(tax, amount),
      paid_with: paidWith,
      billable: false,
      receipt_path: file?.path ?? null,
      receipt_type: file?.type ?? null,
      created_by: owner,
    })
    .select("id")
    .single();
  if (error || !inserted) {
    if (file) await deps.storage(admin).remove(company.organizationId, file.path);
    await updateRow(admin, row, { status: "failed" });
    throw new Error(`expense insert failed: ${(error as { message?: string } | null)?.message ?? "no row"}`);
  }
  const filed = await updateRow(admin, row, {
    status: "filed",
    expense_id: (inserted as { id: string }).id,
    file_path: file?.path ?? null,
    file_type: file?.type ?? null,
    vendor,
    spent_on: spentOn,
    amount_cents: amount,
    tax_cents: scan.taxCents,
    category,
    description: scan.description,
    booking_id: job?.bookingId ?? null,
    paid_with: paidWith,
    po_reference: meaning.po,
    missing: scan.spentOn ? [] : ["date"],
    filed_at: new Date(input.nowMs).toISOString(),
  });
  const bits = [`${vendor ?? "Receipt"} ${money(amount)} (${scan.taxCents === null ? "no HST read" : `HST ${money(tax)}`})`, shortCategory(category)];
  if (job) bits.push(jobPhrase(job, company.timeZone));
  if (paidWith === "personal") bits.push("your own card");
  if (meaning.po) bits.push(meaning.po);
  return { row: filed, line: bits.join(", "), notes };
}

/** A receipt we couldn't read a total from: keep the picture to finish later. */
async function keepForReview(
  admin: AdminClient,
  company: TaxClerkCompany,
  row: ReceiptTextRow,
  media: FetchedReceiptMedia,
  scan: ReceiptScan | null,
  meaning: WordsMeaning,
  deps: ReceiptDeps,
): Promise<FiledReceipt> {
  const file = await storeFile(admin, deps, company.organizationId, media);
  const missing = ["total", ...(scan?.spentOn ? [] : ["date"])];
  const review = await updateRow(admin, row, {
    status: "needs_review",
    file_path: file?.path ?? null,
    file_type: file?.type ?? null,
    vendor: scan?.vendor ?? null,
    spent_on: scan?.spentOn ?? null,
    tax_cents: scan?.taxCents ?? null,
    category: meaning.category ?? scan?.category ?? null,
    description: scan?.description ?? null,
    paid_with: meaning.paidWith,
    po_reference: meaning.po,
    missing,
  });
  const what = missing.length > 1 ? "the total or the date" : "the total";
  return {
    row: review,
    line: `Saved the picture${scan?.vendor ? ` (${scan.vendor})` : ""} but I couldn't read ${what}`,
    notes: [`Text "fix $84.20${missing.includes("date") ? " Oct 14" : ""}" with the real numbers and I'll file it.`],
  };
}

export function composeReply(filed: FiledReceipt[], skipped: number): string {
  const real = filed.filter((f) => f.row.status === "filed");
  const head =
    filed.length === 1
      ? filed[0].row.status === "filed"
        ? `Got it: ${filed[0].line}.`
        : `${filed[0].line}.`
      : `Got ${filed.length} receipts: ${filed.map((f) => f.line).join("; ")}.`;
  const notes = [...new Set(filed.flatMap((f) => f.notes))];
  const tail = real.length ? ` Reply "fix" to change ${filed.length > 1 ? "the last one" : "it"}.` : "";
  const other = skipped ? ` (${skipped} other picture${skipped === 1 ? " wasn't a receipt" : "s weren't receipts"}.)` : "";
  const out = `${head}${notes.length ? ` ${notes.join(" ")}` : ""}${tail}${other}`;
  return out.length > 600 ? `${out.slice(0, 597)}...` : out;
}

/** The handler (registered as the role's ownerMedia). */
export async function handleReceiptMedia(admin: AdminClient, input: OwnerMediaInput, deps: ReceiptDeps = activeDeps): Promise<OwnerMediaResult | null> {
  const company = await loadTaxClerkCompany(admin, input.scope.organizationId, input.scope.companyId);
  if (!company || !company.settings.receipts.enabled) return null;
  const body = input.body.trim();
  // A compliance document (insurance, WSIB clearance, licence…): the Compliance role's.
  if (namesComplianceDoc(body)) return null;
  if (!input.media.some((m) => !m.contentType || receiptMediaType(m.contentType))) return null;

  // A redelivered text: answer the same way, file nothing again.
  const { data: prior } = await (admin as Db).from("receipt_texts").select("*").eq("organization_id", company.organizationId).eq("log_id", input.logId).order("media_index", { ascending: true });
  const priorRows = (prior ?? []) as ReceiptTextRow[];
  if (priorRows.length) {
    const replied = priorRows.find((r) => r.reply);
    if (replied?.reply) return { reply: replied.reply, intent: "receipt" };
    if (priorRows.every((r) => r.status === "not_receipt")) return null;
    return { reply: "Got it - still working on that receipt.", intent: "receipt" };
  }

  const fetched = await deps.fetchMedia(input.media, { max: 3 });
  if (fetched.length === 0) {
    return soundsLikeReceipt(body) ? { reply: "I couldn't open that picture. Try sending the receipt again.", intent: "receipt" } : null;
  }

  const today = localDate(new Date(input.nowMs), company.timeZone);
  const meaning = meaningOf(body);
  let jobCache: JobCandidate[] | null = null;
  const jobs = async () => (jobCache ??= await jobCandidates(admin, company, today));
  const filed: FiledReceipt[] = [];
  let skipped = 0;
  for (const media of fetched) {
    const row = await claim(admin, company, input, media.index);
    if (!row) continue;
    try {
      let read: ReadResult | null = null;
      let readFailed = false;
      try {
        read = await deps.read({ bytes: media.bytes, type: media.type }, today, company);
      } catch (err) {
        readFailed = true;
        console.error("[tax-clerk] receipt reading failed:", err instanceof Error ? err.message : err);
      }
      if (read && read.kind === "not_receipt") {
        await updateRow(admin, row, { status: "not_receipt" });
        skipped += 1;
        continue;
      }
      // No reader (or it failed): only the owner's words can say it's a receipt.
      if (!read && !(readFailed || soundsLikeReceipt(body))) {
        await updateRow(admin, row, { status: "not_receipt" });
        skipped += 1;
        continue;
      }
      if (read && read.scan.amountCents) filed.push(await fileReceipt(admin, company, input, row, media, read.scan, meaning, jobs, deps, today));
      else filed.push(await keepForReview(admin, company, row, media, read?.scan ?? null, meaning, deps));
    } catch (err) {
      console.error("[tax-clerk] filing a texted receipt failed:", err instanceof Error ? err.message : err);
      await updateRow(admin, row, { status: "failed" }).catch(() => null);
      filed.push({ row: { ...row, status: "failed" }, line: "Couldn't file that receipt - try sending it again, or add it in the app", notes: [] });
    }
  }
  if (filed.length === 0) return null;
  const reply = composeReply(filed, skipped);
  await updateRow(admin, filed[0].row, { reply: reply.slice(0, 700) }).catch(() => null);
  return {
    reply,
    intent: "receipt",
    result: { receipts: filed.map((f) => ({ id: f.row.id, status: f.row.status, expenseId: f.row.expense_id })) },
  };
}

export const receiptMediaHandler: OwnerMediaHandler = {
  run: (admin, input) => handleReceiptMedia(admin, input),
};
