/**
 * The Tax Clerk's owner-by-text tools (scoped to the ONE company the owner's phone resolved to —
 * state.scope; nothing from the model is trusted as an id):
 *
 *   fix_receipt       change / delete the last receipt texted in ("fix fuel", "fix Smith job",
 *                     "fix $92.10", "fix personal card", "fix delete" within 24 h); with no change
 *                     it says what's on file. Finishes a receipt that was missing its total.
 *   receipts_summary  this (or last) month by category, HST paid, what's missing a job / receipt
 *   hst_summary       the HST worksheet with the CRA line numbers ("hst")
 *   send_hst_packet   asks to email the packet (accountant_packet approval, asked inline)
 *
 * Never throw (return { error }).
 */
import type { ToolRunState } from "@/server/services/owner-channel/tools";
import { replyInstruction } from "@/server/services/front-desk/approval-text";
import { isValidDateString, localDate } from "@/server/services/booking-windows";
import { EXPENSE_CATEGORIES, summarizeExpenses, type ExpenseCategory } from "@/server/services/expenses/rules";
import type { RoleOwnerTool } from "@/server/services/staff/types";
import { ACCOUNTANT_PACKET_KIND, createPacketApproval } from "./approvals";
import type { Db, ExpenseLite, ReceiptTextRow } from "./db-types";
import { breakdownText, daysBetween, DISCLAIMER, lastEndedPeriod, money, netPhrase, periodContaining, periodName, worksheetFor, type HstPeriod } from "./hst";
import { packetDestination } from "./packet";
import { currentReceiptDeps, dayLabel, findDuplicate, jobCandidates, jobPhrase, shortCategory, type ReceiptDeps } from "./receipts";
import { isEmail, loadTaxClerkCompany, ownerProfileId, type TaxClerkCompany } from "./settings";
import { jobWordsIn, matchJob } from "./words";
import { JOB_CATEGORIES } from "./nudges";

type Input = Record<string, unknown>;
const MAX_TELL_OWNER = 470;
const EDIT_WINDOW_MS = 7 * 86_400_000;
const DELETE_WINDOW_MS = 24 * 3_600_000;

function str(value: unknown, max = 200): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

/** "$84.20" / "84.2" / "1,240" → cents; null when it isn't one clear amount. */
export function centsOf(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value > 0 && value <= 1_000_000 ? Math.round(value * 100) : null;
  const t = str(value, 40);
  if (!t) return null;
  const m = /^\$?\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/.exec(t.replace(/\s+/g, ""));
  if (!m) return null;
  const cents = Number(m[1].replace(/,/g, "")) * 100 + (m[2] ? Number(m[2].padEnd(2, "0")) : 0);
  return cents > 0 && cents <= 100_000_000 ? cents : null;
}

async function companyOf(state: ToolRunState): Promise<TaxClerkCompany | { error: string }> {
  const company = await loadTaxClerkCompany(state.admin, state.scope.organizationId, state.scope.companyId);
  return company ?? { error: "Business not found." };
}

const EXPENSE_COLUMNS = "id, organization_id, company_id, booking_id, spent_on, vendor, description, category, amount_cents, tax_cents, paid_with, receipt_path, receipt_type, created_by, created_at, billed_invoice_id, reimbursed_at";

/** "Home Depot $84.20 (HST $9.69), Materials, Jones roof (Oct 14)". */
async function describe(state: ToolRunState, company: TaxClerkCompany, e: { vendor: string | null; amount_cents: number; tax_cents: number; category: string; booking_id: string | null; paid_with: string; spent_on: string }, po: string | null): Promise<string> {
  const bits = [`${e.vendor ?? "Receipt"} ${money(e.amount_cents)} (HST ${money(e.tax_cents)}) on ${dayLabel(e.spent_on)}`, shortCategory(e.category)];
  if (e.booking_id) {
    const job = (await jobCandidates(state.admin, company, e.spent_on)).find((j) => j.bookingId === e.booking_id);
    if (job) bits.push(jobPhrase(job, company.timeZone));
    else bits.push("on a job");
  } else bits.push("no job");
  if (e.paid_with === "personal") bits.push("your own card");
  if (po) bits.push(po);
  return bits.join(", ");
}

async function lastReceipt(state: ToolRunState): Promise<ReceiptTextRow | null> {
  const since = new Date(state.nowMs - EDIT_WINDOW_MS).toISOString();
  const { data } = await (state.admin as Db)
    .from("receipt_texts")
    .select("*")
    .eq("organization_id", state.scope.organizationId)
    .eq("company_id", state.scope.companyId)
    .in("status", ["filed", "needs_review"])
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(1);
  return ((data ?? []) as ReceiptTextRow[])[0] ?? null;
}

async function resolveJob(state: ToolRunState, company: TaxClerkCompany, words: string, near: string): Promise<{ bookingId: string | null; label: string | null } | { error: string }> {
  if (/^(none|no job|no|overhead|not a job|clear)$/i.test(words.trim())) return { bookingId: null, label: null };
  const match = matchJob(jobWordsIn(words), await jobCandidates(state.admin, company, near), near);
  if (match.kind === "one") return { bookingId: match.job.bookingId, label: jobPhrase(match.job, company.timeZone) };
  if (match.kind === "ambiguous") return { error: `Which one: ${match.jobs.map((j) => jobPhrase(j, company.timeZone)).join(" or ")}?` };
  return { error: `No job matches "${words.slice(0, 40)}" near ${dayLabel(near)}. Use the customer's name.` };
}

async function fixReceipt(state: ToolRunState, input: Input, deps: ReceiptDeps): Promise<Record<string, unknown>> {
  const company = await companyOf(state);
  if ("error" in company) return company;
  if (!company.settings.receipts.enabled) return { error: "Receipts by text are off for this business (Settings > AI front desk > Receipts & HST)." };
  const row = await lastReceipt(state);
  if (!row) return { error: "No receipt texted in the last week to fix. Change older ones in the app (Expenses)." };
  const db = state.admin as Db;
  const org = state.scope.organizationId;
  const today = localDate(new Date(state.nowMs), company.timeZone);

  // Delete (24 h).
  if (input.delete === true) {
    if (state.nowMs - Date.parse(row.created_at) > DELETE_WINDOW_MS) return { error: "That receipt is more than a day old - delete it in the app (Expenses)." };
    if (row.expense_id) {
      const { data: exp } = await db.from("expenses").select("id, billed_invoice_id, reimbursed_at").eq("organization_id", org).eq("id", row.expense_id).maybeSingle();
      if (exp && ((exp as { billed_invoice_id: string | null }).billed_invoice_id || (exp as { reimbursed_at: string | null }).reimbursed_at)) return { error: "That expense is already billed or paid back - change it in the app." };
      if (exp) await db.from("expenses").delete().eq("organization_id", org).eq("id", row.expense_id);
    }
    if (row.file_path) await deps.storage(state.admin).remove(org, row.file_path);
    await db.from("receipt_texts").update({ status: row.status === "filed" ? "deleted" : "discarded", expense_id: null }).eq("id", row.id).eq("organization_id", org);
    return { ok: true, tell_owner: `Deleted: ${row.vendor ?? "the receipt"}${row.amount_cents ? ` ${money(row.amount_cents)}` : ""}.` };
  }

  const category = str(input.category, 40);
  if (category && !(EXPENSE_CATEGORIES as readonly string[]).includes(category)) return { error: `Category must be one of: ${EXPENSE_CATEGORIES.join(", ")}.` };
  const amount = input.amount !== undefined ? centsOf(input.amount) : null;
  if (input.amount !== undefined && amount === null) return { error: "Give the total like $84.20." };
  const tax = input.tax !== undefined ? (str(input.tax) === "0" || input.tax === 0 ? 0 : centsOf(input.tax)) : null;
  if (input.tax !== undefined && tax === null) return { error: "Give the HST like $9.69." };
  const date = str(input.date, 10);
  if (date && (!isValidDateString(date) || daysBetween(date, today) < -7 || daysBetween(date, today) > 366)) return { error: "Give the date like 2026-10-14 (within the last year)." };
  const paidWith = input.paid_with === "personal" || input.paid_with === "business" ? input.paid_with : null;
  const vendor = str(input.vendor, 200);
  const po = str(input.po, 20);
  const poRef = po ? (/^(?:po)?[-\s#]*(\d{1,9})$/i.exec(po) ? `PO-${Number(/(\d{1,9})/.exec(po)![1])}` : null) : null;
  if (po && !poRef) return { error: "Give the PO like PO-12." };
  const jobWords = str(input.job, 120);
  const nothing = !category && amount === null && tax === null && !date && !paidWith && !vendor && !poRef && !jobWords;

  if (row.status === "needs_review") {
    const near = date ?? row.spent_on ?? today;
    let bookingId = row.booking_id;
    if (jobWords) {
      const job = await resolveJob(state, company, jobWords, near);
      if ("error" in job) return job;
      bookingId = job.bookingId;
    }
    const merged = {
      vendor: vendor ?? row.vendor,
      spent_on: date ?? row.spent_on,
      amount_cents: amount ?? row.amount_cents,
      tax_cents: tax ?? row.tax_cents,
      category: (category ?? row.category ?? "other") as ExpenseCategory,
      paid_with: paidWith ?? row.paid_with ?? "business",
      booking_id: bookingId,
      po_reference: poRef ?? row.po_reference,
    };
    if (!merged.amount_cents) {
      await db.from("receipt_texts").update({ ...merged, amount_cents: null }).eq("id", row.id).eq("organization_id", org);
      return { ok: true, tell_owner: `Still need the total for ${row.vendor ?? "that receipt"} - text "fix $84.20" with the real amount.` };
    }
    const spentOn = merged.spent_on ?? today;
    const dup = await findDuplicate(state.admin, company, { vendor: merged.vendor, spentOn, amountCents: merged.amount_cents });
    if (dup) {
      await db.from("receipt_texts").update({ status: "duplicate", duplicate_of: dup.id }).eq("id", row.id).eq("organization_id", org);
      return { ok: true, tell_owner: `Already have that one: ${merged.vendor ?? "receipt"} ${money(merged.amount_cents)} on ${dayLabel(spentOn)} - not added again.` };
    }
    const owner = await ownerProfileId(state.admin, org, state.ownerPhone);
    if (!owner) return { error: "No owner account to file it under - add it in the app (Expenses)." };
    const taxCents = Math.min(merged.tax_cents ?? 0, merged.amount_cents);
    const { data: inserted, error } = await db
      .from("expenses")
      .insert({
        organization_id: org,
        company_id: state.scope.companyId,
        booking_id: merged.booking_id,
        spent_on: spentOn,
        vendor: merged.vendor,
        description: row.description,
        category: merged.category,
        amount_cents: merged.amount_cents,
        tax_cents: taxCents,
        paid_with: merged.paid_with,
        billable: false,
        receipt_path: row.file_path,
        receipt_type: row.file_path ? row.file_type : null,
        created_by: owner,
      })
      .select("id")
      .single();
    if (error || !inserted) return { error: "Couldn't file it - add it in the app (Expenses)." };
    await db
      .from("receipt_texts")
      .update({ ...merged, spent_on: spentOn, tax_cents: taxCents, status: "filed", expense_id: (inserted as { id: string }).id, missing: [], filed_at: new Date(state.nowMs).toISOString() })
      .eq("id", row.id)
      .eq("organization_id", org);
    const line = await describe(state, company, { ...merged, amount_cents: merged.amount_cents, tax_cents: taxCents, spent_on: spentOn }, merged.po_reference);
    return { ok: true, tell_owner: `Filed: ${line}.` };
  }

  // A filed receipt: edit its expense.
  const { data: found } = await db.from("expenses").select(EXPENSE_COLUMNS).eq("organization_id", org).eq("id", row.expense_id).maybeSingle();
  const expense = found as (ExpenseLite & { billed_invoice_id: string | null; reimbursed_at: string | null }) | null;
  if (!expense) return { error: "That receipt's expense is gone (deleted in the app?)." };
  if (nothing) {
    const line = await describe(state, company, expense, row.po_reference);
    return { ok: true, nothing_changed: true, tell_owner: `Last receipt: ${line}. Say what to change, e.g. "fix fuel", "fix Smith job", "fix $92.10", "fix personal card" or "fix delete".` };
  }
  if (expense.billed_invoice_id || expense.reimbursed_at) return { error: "That expense is already billed or paid back - change it in the app." };
  const patch: Record<string, unknown> = {};
  if (category) patch.category = category;
  if (amount !== null) patch.amount_cents = amount;
  if (tax !== null) patch.tax_cents = tax;
  if (date) patch.spent_on = date;
  if (paidWith) patch.paid_with = paidWith;
  if (vendor) patch.vendor = vendor;
  if (jobWords) {
    const job = await resolveJob(state, company, jobWords, date ?? expense.spent_on);
    if ("error" in job) return job;
    patch.booking_id = job.bookingId;
  }
  const nextAmount = (patch.amount_cents as number | undefined) ?? expense.amount_cents;
  const nextTax = (patch.tax_cents as number | undefined) ?? expense.tax_cents;
  if (nextTax > nextAmount) return { error: "The HST can't be more than the total." };
  if (Object.keys(patch).length) {
    const { error } = await db.from("expenses").update(patch).eq("organization_id", org).eq("id", expense.id);
    if (error) return { error: "Couldn't change it - try in the app (Expenses)." };
  }
  const mirror: Record<string, unknown> = { ...patch };
  if (poRef) mirror.po_reference = poRef;
  if (Object.keys(mirror).length) await db.from("receipt_texts").update(mirror).eq("id", row.id).eq("organization_id", org);
  const line = await describe(state, company, { ...expense, ...(patch as Partial<ExpenseLite>) }, poRef ?? row.po_reference);
  return { ok: true, tell_owner: `Fixed: ${line}.` };
}

function monthRange(today: string, which: "this" | "last"): { start: string; end: string; label: string } {
  const [y, m] = today.split("-").map(Number);
  const idx = y * 12 + (m - 1) - (which === "last" ? 1 : 0);
  const yy = Math.floor(idx / 12);
  const mm = (idx % 12) + 1;
  const start = `${yy}-${String(mm).padStart(2, "0")}-01`;
  const endDay = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  const end = which === "this" ? today : `${yy}-${String(mm).padStart(2, "0")}-${String(endDay).padStart(2, "0")}`;
  return { start, end, label: new Date(Date.UTC(yy, mm - 1, 1)).toLocaleDateString("en-CA", { timeZone: "UTC", month: "long" }) };
}

async function receiptsSummary(state: ToolRunState, input: Input): Promise<Record<string, unknown>> {
  const company = await companyOf(state);
  if ("error" in company) return company;
  const today = localDate(new Date(state.nowMs), company.timeZone);
  const range = monthRange(today, input.month === "last" ? "last" : "this");
  const db = state.admin as Db;
  const { data } = await db
    .from("expenses")
    .select("category, amount_cents, tax_cents, paid_with, reimbursed_at, booking_id, created_by, receipt_path, vendor, spent_on")
    .eq("organization_id", company.organizationId)
    .eq("company_id", company.companyId)
    .gte("spent_on", range.start)
    .lte("spent_on", range.end)
    .limit(5000);
  const rows = (data ?? []) as Array<{ category: string; amount_cents: number; tax_cents: number; paid_with: string; reimbursed_at: string | null; booking_id: string | null; created_by: string | null; receipt_path: string | null; vendor: string | null; spent_on: string }>;
  const summary = summarizeExpenses(rows);
  const noJob = rows.filter((r) => JOB_CATEGORIES.has(r.category) && !r.booking_id);
  const noReceipt = rows.filter((r) => !r.receipt_path);
  const { data: review } = await db.from("receipt_texts").select("vendor, created_at").eq("organization_id", company.organizationId).eq("company_id", company.companyId).eq("status", "needs_review").limit(50);
  const toFinish = (review ?? []) as Array<{ vendor: string | null; created_at: string }>;
  const top = summary.byCategory.slice(0, 5).map((c) => `${shortCategory(c.category)} ${money(c.cents)}`);
  return {
    ok: true,
    month: range.label,
    count: summary.count,
    total: money(summary.totalCents),
    hst_paid: money(summary.taxCents),
    before_tax_by_category: summary.byCategory.map((c) => ({ category: shortCategory(c.category), amount: money(c.cents), count: c.count })),
    materials_without_a_job: noJob.slice(0, 8).map((r) => `${r.vendor ?? "?"} ${money(r.amount_cents)} ${dayLabel(r.spent_on)}`),
    without_a_receipt: noReceipt.length,
    pictures_to_finish: toFinish.length,
    owed_out_of_pocket: money(summary.owedCents),
    tell_owner: `${range.label}: ${summary.count} expense${summary.count === 1 ? "" : "s"}, ${money(summary.totalCents)} (HST ${money(summary.taxCents)}). ${top.length ? `${top.join(", ")}.` : ""}${noJob.length ? ` ${noJob.length} materials buy${noJob.length === 1 ? "" : "s"} with no job.` : ""}${noReceipt.length ? ` ${noReceipt.length} without a receipt.` : ""}${toFinish.length ? ` ${toFinish.length} picture${toFinish.length === 1 ? "" : "s"} still need${toFinish.length === 1 ? "s" : ""} a total.` : ""}`.trim(),
  };
}

/** The period "hst" means: the last one until its payment date, then the current one so far. */
function pickPeriod(company: TaxClerkCompany, today: string, which: unknown): { period: HstPeriod; toDate: boolean } {
  const last = lastEndedPeriod(today, company.settings.hst);
  if (which === "last") return { period: last, toDate: false };
  if (which === "current" || today > last.paymentDueDate) return { period: periodContaining(today, company.settings.hst), toDate: true };
  return { period: last, toDate: false };
}

async function hstSummary(state: ToolRunState, input: Input): Promise<Record<string, unknown>> {
  const company = await companyOf(state);
  if ("error" in company) return company;
  const today = localDate(new Date(state.nowMs), company.timeZone);
  const { period, toDate } = pickPeriod(company, today, input.period);
  const w = await worksheetFor(state.admin, company, toDate ? { start: period.start, end: today } : period);
  const text = breakdownText(period, w, { refYear: Number(today.slice(0, 4)), toDate });
  return {
    ok: true,
    registrant: company.settings.hst.registrant,
    period: period.range,
    line_101_sales: money(w.salesCents),
    line_103_collected: money(w.collectedCents),
    line_106_itcs: money(w.itcCents),
    line_109_net: money(w.netCents),
    due: period.paymentDueDate,
    days_to_due: daysBetween(today, period.paymentDueDate),
    tell_owner: company.settings.hst.registrant ? text : `${text} (You're not set up as HST registered - turn it on in Settings > AI front desk > Receipts & HST if you are.)`,
  };
}

async function sendHstPacket(state: ToolRunState, input: Input): Promise<Record<string, unknown>> {
  const company = await companyOf(state);
  if ("error" in company) return company;
  const today = localDate(new Date(state.nowMs), company.timeZone);
  const { period, toDate } = pickPeriod(company, today, input.period);
  if (toDate) return { error: `${periodName(period)} isn't over yet (ends ${dayLabel(period.end)}). I can send the last one: say "send last quarter's hst packet".` };
  const asked = str(input.email, 254);
  if (asked && !isEmail(asked)) return { error: "That email doesn't look right." };
  const dest = asked ? { to: asked.toLowerCase(), toWho: "other" as const } : await packetDestination(state.admin, company);
  if (!dest) return { error: "No email to send it to. Add your accountant's email in Settings > AI front desk > Receipts & HST, or say who to send it to." };
  const w = await worksheetFor(state.admin, company, period);
  const summary = `Email the ${periodName(period)} packet (${period.range}) to ${dest.to}: expenses with receipt links, invoices and a one-page summary. Collected ${money(w.collectedCents)}, ITCs ${money(w.itcCents)}, ${netPhrase(w.netCents)}. ${DISCLAIMER}`;
  const approval = await createPacketApproval(
    state.admin,
    {
      organizationId: company.organizationId,
      companyId: company.companyId,
      summary,
      payload: { frequency: period.frequency, periodStart: period.start, periodEnd: period.end, label: period.label, to: dest.to, toWho: dest.toWho },
      askedInlineTo: state.ownerPhone,
    },
    state.nowMs,
  );
  const line = `#${approval.shortCode ?? "?"} ${approval.summary} ${replyInstruction(ACCOUNTANT_PACKET_KIND, approval.shortCode)}`;
  return { ok: true, nothing_sent_yet: true, tell_owner_exactly: line.length <= MAX_TELL_OWNER ? line : `${line.slice(0, MAX_TELL_OWNER - 3)}...` };
}

const CATEGORY_ENUM = [...EXPENSE_CATEGORIES];

export function taxClerkOwnerTools(): RoleOwnerTool[] {
  return [
    {
      tool: {
        name: "fix_receipt",
        description:
          "Change or delete the LAST receipt the owner texted in (within a week). Pass only what the owner wants changed. With nothing to change it returns what's on file. Also finishes a receipt that was saved without its total (pass amount).",
        input_schema: {
          type: "object",
          properties: {
            category: { type: "string", enum: CATEGORY_ENUM },
            job: { type: "string", description: "The customer's name / job words as the owner said them, or 'none' for no job." },
            amount: { type: "string", description: "Total paid incl. tax, e.g. '$84.20'." },
            tax: { type: "string", description: "The HST on it, e.g. '$9.69' (0 for none)." },
            date: { type: "string", description: "YYYY-MM-DD" },
            paid_with: { type: "string", enum: ["business", "personal"] },
            vendor: { type: "string" },
            po: { type: "string", description: "Purchase order, e.g. 'PO-12'." },
            delete: { type: "boolean", description: "Delete it (only within 24 h of texting it)." },
          },
        },
      },
      run: async (state, input) => {
        try {
          return await fixReceipt(state, input, currentReceiptDeps());
        } catch (err) {
          console.error("[tax-clerk] fix_receipt failed:", err instanceof Error ? err.message : err);
          return { error: "Couldn't change it - try in the app (Expenses)." };
        }
      },
    },
    {
      tool: {
        name: "receipts_summary",
        description: "This month's (or last month's) expenses by category, HST paid, materials with no job, expenses with no receipt, receipt pictures still missing a total.",
        input_schema: { type: "object", properties: { month: { type: "string", enum: ["this", "last"] } } },
      },
      run: async (state, input) => {
        try {
          return await receiptsSummary(state, input);
        } catch (err) {
          console.error("[tax-clerk] receipts_summary failed:", err instanceof Error ? err.message : err);
          return { error: "Couldn't add up the receipts right now." };
        }
      },
    },
    {
      tool: {
        name: "hst_summary",
        description:
          "The HST worksheet (regular method) with CRA lines 101/103/106/109 and the due date. Default: the period being filed now (or this period so far once it's paid).",
        input_schema: { type: "object", properties: { period: { type: "string", enum: ["last", "current"] } } },
      },
      run: async (state, input) => {
        try {
          return await hstSummary(state, input);
        } catch (err) {
          console.error("[tax-clerk] hst_summary failed:", err instanceof Error ? err.message : err);
          return { error: "Couldn't work out the HST right now." };
        }
      },
    },
    {
      tool: {
        name: "send_hst_packet",
        description:
          "Ask the owner to OK emailing the HST packet (expenses CSV with receipt links, invoice list, one-page CRA summary) for the last finished period - to the accountant email in Settings, the owner, or an email the owner typed. Sends nothing by itself.",
        input_schema: {
          type: "object",
          properties: { period: { type: "string", enum: ["last"] }, email: { type: "string", description: "Only an address the owner typed in this text." } },
        },
      },
      run: async (state, input) => {
        try {
          return await sendHstPacket(state, input);
        } catch (err) {
          console.error("[tax-clerk] send_hst_packet failed:", err instanceof Error ? err.message : err);
          return { error: "Couldn't set up the packet right now." };
        }
      },
    },
  ];
}
