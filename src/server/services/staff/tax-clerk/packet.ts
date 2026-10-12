/**
 * The accountant packet (approval kind `accountant_packet`): one email with
 *   - expenses-<period>.csv   every expense in the period with its HST, the ITC claimed and a
 *                             receipt link (signed, good for 30 days)
 *   - invoices-<period>.csv   every invoice issued in the period that counts toward line 101
 *   - hst-summary-<period>.pdf  one page with the CRA line numbers and notes
 * sent to the accountant email setting, else the owner (Resend, under the business's name,
 * reply-to the owner). Claimed on hst_periods (packet_claimed_at) so a double Y emails once.
 * Prepared figures only: nothing is ever filed with CRA.
 */
import { sendEmail, type SendEmailInput } from "@/server/outbound/email";
import type { AdminClient, ApprovalDecision, ExecuteResult, OwnerApprovalRow } from "@/server/services/front-desk/contracts";
import { ctxFor } from "@/server/services/owner-channel/common";
import { categoryLabel, csvCell } from "@/server/services/expenses/rules";
import { orgOwnerEmail } from "@/server/services/workflow-engine/messaging";
import { localDate } from "@/server/services/booking-windows";
import type { Db, ExpenseLite, HstPeriodRow, InvoiceLite } from "./db-types";
import { computeWorksheet, DISCLAIMER, itcOf, invoiceCounts, loadPeriodRecords, money, netPhrase, periodContaining, periodName, type HstPeriod, type HstWorksheet } from "./hst";
import { hstSummaryPdf } from "./pdf";
import { isEmail, loadTaxClerkCompany, type TaxClerkCompany } from "./settings";
import { PACKET_LINK_TTL_SECONDS, supabaseReceiptStorage, type ReceiptStorage } from "./storage";

export interface PacketDeps {
  storage(admin: AdminClient): ReceiptStorage;
  sendEmail(input: SendEmailInput): Promise<{ id: string | null }>;
  /** The org owner's email when the company has none on file. */
  orgOwnerEmail(admin: AdminClient, organizationId: string): Promise<string | null>;
}

export const defaultPacketDeps: PacketDeps = {
  storage: (admin) => supabaseReceiptStorage(admin),
  sendEmail: (input) => sendEmail(input),
  orgOwnerEmail: (admin, organizationId) => orgOwnerEmail(ctxFor(admin, organizationId)),
};

/** A money cell: digits, a dot and maybe a minus — never formula-guarded (csvCell would put ' before a negative). */
const dollars = (c: number) => (c / 100).toFixed(2);
/** A packet claim older than this is a crashed attempt and may be retried. */
const CLAIM_STALE_MS = 10 * 60_000;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Where the packet goes: the accountant email setting, else the owner. */
export async function packetDestination(admin: AdminClient, company: TaxClerkCompany, deps: PacketDeps = defaultPacketDeps): Promise<{ to: string; toWho: "accountant" | "owner" } | null> {
  if (company.settings.hst.accountantEmail) return { to: company.settings.hst.accountantEmail, toWho: "accountant" };
  const owner = company.ownerEmail ?? (await deps.orgOwnerEmail(admin, company.organizationId).catch(() => null));
  return owner && isEmail(owner) ? { to: owner.trim(), toWho: "owner" } : null;
}

// ── Files ────────────────────────────────────────────────────────────────────

export const EXPENSE_CSV_HEADER = ["Date", "Vendor", "Description", "Category", "Total", "HST", "ITC claimed", "Before tax", "Job", "Paid with", "Receipt link", "Claimed late (from)"];

export function expensesCsv(expenses: Array<ExpenseLite & { fromLabel?: string }>, jobTitles: Map<string, string>, links: Map<string, string>): string {
  const rows = expenses.map((e) =>
    [
      csvCell(e.spent_on),
      csvCell(e.vendor),
      csvCell(e.description),
      csvCell(categoryLabel(e.category)),
      dollars(e.amount_cents),
      dollars(e.tax_cents),
      dollars(itcOf(e)),
      dollars(e.amount_cents - e.tax_cents),
      csvCell(e.booking_id ? (jobTitles.get(e.booking_id) ?? "") : ""),
      csvCell(e.paid_with === "personal" ? "Out of pocket" : "Business"),
      csvCell(e.receipt_path ? (links.get(e.receipt_path) ?? "(link unavailable)") : "No receipt"),
      csvCell(e.fromLabel ?? ""),
    ].join(","),
  );
  return `${[EXPENSE_CSV_HEADER.join(","), ...rows].join("\r\n")}\r\n`;
}

export const INVOICE_CSV_HEADER = ["Invoice #", "Issue date", "Customer", "Status", "Before tax", "HST", "Total", "Deposit / credit applied", "Paid", "Balance"];

export function invoicesCsv(invoices: InvoiceLite[]): string {
  const rows = invoices.map((i) => {
    const bill = record(i.bill_to);
    const name = [bill.name, bill.company].filter((v) => typeof v === "string" && v.trim()).join(" - ");
    return [
      csvCell(i.invoice_number),
      csvCell(i.issue_date),
      csvCell(name || i.title),
      csvCell(i.subtotal_cents < 0 ? "credit note" : i.status.replace(/_/g, " ")),
      dollars(i.subtotal_cents),
      dollars(i.tax_cents),
      dollars(i.total_cents),
      dollars(i.credit_cents),
      dollars(i.amount_paid_cents),
      dollars(i.balance_due_cents),
    ].join(",");
  });
  return `${[INVOICE_CSV_HEADER.join(","), ...rows].join("\r\n")}\r\n`;
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "business";
}

export interface BuiltPacket {
  worksheet: HstWorksheet;
  attachments: Array<{ filename: string; content: string }>;
  expenseCount: number;
  invoiceCount: number;
}

export async function buildPacket(admin: AdminClient, company: TaxClerkCompany, period: HstPeriod, nowMs: number, deps: PacketDeps = defaultPacketDeps): Promise<BuiltPacket> {
  const records = await loadPeriodRecords(admin, company, period);
  const { invoices } = records;
  const expenses: Array<ExpenseLite & { fromLabel?: string }> = [...records.expenses, ...records.late];
  const counted = invoices.filter((i) => invoiceCounts(i, period));
  const worksheet = computeWorksheet(invoices, records.expenses, period, records.late);
  const bookingIds = [...new Set(expenses.map((e) => e.booking_id).filter((v): v is string => !!v))];
  const jobTitles = new Map<string, string>();
  for (let i = 0; i < bookingIds.length; i += 200) {
    const { data } = await (admin as Db).from("bookings").select("id, title").eq("organization_id", company.organizationId).in("id", bookingIds.slice(i, i + 200));
    for (const b of (data ?? []) as Array<{ id: string; title: string }>) jobTitles.set(b.id, b.title);
  }
  const links = await deps.storage(admin).signedUrls(company.organizationId, expenses.map((e) => e.receipt_path).filter((p): p is string => !!p), PACKET_LINK_TTL_SECONDS);
  const tag = `${slug(company.name)}-${period.start}-to-${period.end}`;
  const pdf = await hstSummaryPdf({
    companyName: company.name,
    hstNumber: company.hstNumber,
    period,
    worksheet,
    preparedOn: localDate(new Date(nowMs), company.timeZone),
    expenseCount: expenses.length,
    invoiceCount: counted.length,
  });
  return {
    worksheet,
    expenseCount: expenses.length,
    invoiceCount: counted.length,
    attachments: [
      { filename: `hst-summary-${tag}.pdf`, content: Buffer.from(pdf).toString("base64") },
      { filename: `expenses-${tag}.csv`, content: Buffer.from(expensesCsv(expenses, jobTitles, links), "utf8").toString("base64") },
      { filename: `invoices-${tag}.csv`, content: Buffer.from(invoicesCsv(counted), "utf8").toString("base64") },
    ],
  };
}

// ── The period row (claim) ─────────────────────────────────────────────────────

export async function loadPeriodRow(admin: AdminClient, company: { organizationId: string; companyId: string }, period: Pick<HstPeriod, "start" | "end">): Promise<HstPeriodRow | null> {
  const { data } = await (admin as Db)
    .from("hst_periods")
    .select("*")
    .eq("organization_id", company.organizationId)
    .eq("company_id", company.companyId)
    .eq("period_start", period.start)
    .eq("period_end", period.end)
    .maybeSingle();
  return (data as HstPeriodRow | null) ?? null;
}

/** The period's row, made (status pending) when it doesn't exist yet. */
export async function ensurePeriodRow(admin: AdminClient, company: TaxClerkCompany, period: HstPeriod): Promise<HstPeriodRow | null> {
  const existing = await loadPeriodRow(admin, company, period);
  if (existing) return existing;
  const { data } = await (admin as Db)
    .from("hst_periods")
    .insert({
      organization_id: company.organizationId,
      company_id: company.companyId,
      frequency: period.frequency,
      period_start: period.start,
      period_end: period.end,
      due_date: period.dueDate,
      payment_due_date: period.paymentDueDate,
      label: period.label,
      status: "pending",
    })
    .select("*")
    .single();
  return (data as HstPeriodRow | null) ?? (await loadPeriodRow(admin, company, period));
}

export type PacketOutcome =
  | { status: "sent"; to: string; worksheet: HstWorksheet }
  | { status: "busy" }
  | { status: "failed"; to: string; error: string };

/** Build and email the packet once (claimed on the period row). */
export async function emailPacket(
  admin: AdminClient,
  company: TaxClerkCompany,
  period: HstPeriod,
  to: string,
  nowMs: number,
  deps: PacketDeps = defaultPacketDeps,
): Promise<PacketOutcome> {
  const db = admin as Db;
  const row = await ensurePeriodRow(admin, company, period);
  if (!row) return { status: "failed", to, error: "couldn't save the period" };
  if (row.packet_claimed_at && !row.packet_emailed_at && nowMs - Date.parse(row.packet_claimed_at) < CLAIM_STALE_MS) return { status: "busy" };
  const nowIso = new Date(nowMs).toISOString();
  let claim = db.from("hst_periods").update({ packet_claimed_at: nowIso, packet_error: null }).eq("id", row.id).eq("organization_id", company.organizationId);
  claim = row.packet_claimed_at ? claim.eq("packet_claimed_at", row.packet_claimed_at) : claim.is("packet_claimed_at", null);
  const { data: claimed } = await claim.select("id");
  if (((claimed ?? []) as unknown[]).length === 0) return { status: "busy" };

  try {
    const built = await buildPacket(admin, company, period, nowMs, deps);
    const w = built.worksheet;
    const body = [
      `${company.name} - ${periodName(period)} packet, ${period.range} (regular method).`,
      "",
      `Line 101 sales and other revenue: ${money(w.salesCents)}`,
      `Line 103 GST/HST collected: ${money(w.collectedCents)}`,
      `Line 106 input tax credits: ${money(w.itcCents)}${w.lateItcCents ? ` (incl. ${money(w.lateItcCents)} from ${w.lateExpenseCount} receipt${w.lateExpenseCount === 1 ? "" : "s"} of earlier periods not claimed before - flagged in the CSV)` : ""}`,
      `Line 109 net tax: ${money(w.netCents)} (${netPhrase(w.netCents)})`,
      "",
      `Attached: a one-page summary (PDF), ${built.expenseCount} expense${built.expenseCount === 1 ? "" : "s"} with receipt links (the links work for 30 days) and ${built.invoiceCount} invoice${built.invoiceCount === 1 ? "" : "s"}.`,
      company.hstNumber ? `HST #: ${company.hstNumber}` : "",
      "",
      DISCLAIMER,
    ]
      .filter((l, i, all) => l !== "" || all[i - 1] !== "")
      .join("\n");
    await deps.sendEmail({
      to,
      subject: `${periodName(period)} packet: ${period.range} (${company.name})`,
      body,
      fromName: company.name,
      replyTo: company.ownerEmail ?? undefined,
      attachments: built.attachments,
    });
    await db
      .from("hst_periods")
      .update({ packet_emailed_at: nowIso, packet_emailed_to: to, packet_error: null })
      .eq("id", row.id)
      .eq("organization_id", company.organizationId);
    return { status: "sent", to, worksheet: w };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await db.from("hst_periods").update({ packet_claimed_at: null, packet_error: reason.slice(0, 500) }).eq("id", row.id).eq("organization_id", company.organizationId);
    return { status: "failed", to, error: reason };
  }
}

// ── The approval ─────────────────────────────────────────────────────────────

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** The period an approval / owner tool names (re-derived from settings + dates, never trusted blindly). */
export function periodFromPayload(company: TaxClerkCompany, payload: Record<string, unknown>): HstPeriod | null {
  const start = str(payload.periodStart);
  const end = str(payload.periodEnd);
  if (!start || !end || !/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return null;
  const frequency = str(payload.frequency);
  const settings = { ...company.settings.hst, frequency: (frequency === "monthly" || frequency === "quarterly" || frequency === "annual" ? frequency : company.settings.hst.frequency) as HstPeriod["frequency"] };
  const period = periodContaining(start, settings);
  return period.start === start && period.end === end ? period : null;
}

/** accountant_packet: Y → email the packet (once); N / expiry → nothing sent. */
export async function executeAccountantPacket(
  admin: AdminClient,
  approval: OwnerApprovalRow,
  decision: ApprovalDecision,
  deps: PacketDeps = defaultPacketDeps,
  nowMs: number = Date.now(),
): Promise<ExecuteResult> {
  const code = approval.short_code ?? "?";
  const label = str(approval.payload?.label) ?? "HST";
  if (!decision.approved) {
    return {
      ok: true,
      message: decision.decidedVia === "expiry" ? `The ${label} HST packet ask (#${code}) expired - text "hst packet" when you want it.` : `OK, not sent. Text "hst packet" when you want it.`,
    };
  }
  if (decision.ownerNote?.trim()) {
    return { ok: false, message: `I only email the packet to the address in the text. To send it somewhere else, text "send the hst packet to name@example.com".` };
  }
  const company = await loadTaxClerkCompany(admin, approval.organization_id, approval.company_id);
  if (!company) return { ok: false, message: `#${code}: business not found, nothing sent.` };
  const period = periodFromPayload(company, approval.payload ?? {});
  const to = str(approval.payload?.to);
  if (!period || !to || !isEmail(to)) return { ok: false, message: `#${code} isn't linked to an HST period any more, so nothing was sent.` };
  const row = await loadPeriodRow(admin, company, period);
  if (row?.packet_emailed_at && row.packet_emailed_to === to && Date.parse(row.packet_emailed_at) >= Date.parse(approval.created_at)) {
    return { ok: true, message: `Already emailed the ${periodName(period)} packet to ${to}.` };
  }
  const out = await emailPacket(admin, company, period, to, nowMs, deps);
  if (out.status === "busy") return { ok: true, message: `The ${periodName(period)} packet is going out to ${to} now.` };
  if (out.status === "failed") return { ok: false, message: `Couldn't email the ${periodName(period)} packet to ${to}. Try again from Settings > AI front desk > Receipts & HST.` };
  return { ok: true, message: `Emailed the ${periodName(period)} packet to ${to}: ${money(out.worksheet.collectedCents)} collected, ${money(out.worksheet.itcCents)} ITCs, ${netPhrase(out.worksheet.netCents)}. ${DISCLAIMER}` };
}
