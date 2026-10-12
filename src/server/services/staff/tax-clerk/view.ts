// ─────────────────────────────────────────────────────────────────────────────
// SANCTIONED EXCEPTION (service role): Settings → AI front desk → Receipts & HST. The route checks
// org membership (owner/admin for anything but reading the switches) and that the company belongs
// to the org on the caller's RLS client FIRST; only then does this read / write that one
// company's rows with the service role. Settings writes merge ONLY ai_settings.tax_clerk.
// ─────────────────────────────────────────────────────────────────────────────
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { updateAiSettings } from "@/server/services/front-desk/ai-settings-write";
import { isValidDateString, localDate } from "@/server/services/booking-windows";
import { EXPENSE_CATEGORIES, type ExpenseCategory } from "@/server/services/expenses/rules";
import type { Db, HstPeriodRow, ReceiptTextRow } from "./db-types";
import { DISCLAIMER, lastEndedPeriod, periodContaining, worksheetFor, type HstPeriod } from "./hst";
import { defaultPacketDeps, emailPacket, loadPeriodRow, packetDestination, type PacketDeps } from "./packet";
import { findDuplicate } from "./receipts";
import { hstRemindersOn, loadTaxClerkCompany, mergeTaxClerkSettings, type TaxClerkPatch, type TaxClerkSettings } from "./settings";
import { supabaseReceiptStorage, type ReceiptStorage } from "./storage";

export interface TaxClerkView {
  companyId: string;
  companyName: string;
  settings: TaxClerkSettings;
  defaultEnabled: boolean;
  hstNumberOnFile: boolean;
  remindersActive: boolean;
  ownerPhoneOnFile: boolean;
  /** Owners/admins only (null for members). */
  hst: {
    period: { label: string; range: string; start: string; end: string; dueDate: string; paymentDueDate: string; toDate: boolean };
    salesCents: number;
    collectedCents: number;
    itcCents: number;
    netCents: number;
    missingReceipts: number;
    importedExcluded: number;
    packet: { emailedAt: string | null; emailedTo: string | null; error: string | null; sendsTo: string | null };
    disclaimer: string;
  } | null;
  toFinish: Array<{ id: string; vendor: string | null; spentOn: string | null; taxCents: number | null; category: string | null; createdAt: string; pictureUrl: string | null; missing: string[] }> | null;
  recent: Array<{ id: string; status: string; vendor: string | null; amountCents: number | null; createdAt: string; poReference: string | null }> | null;
}

export interface ViewDeps {
  storage(admin: AdminClient): ReceiptStorage;
  packet: PacketDeps;
}

export const defaultViewDeps: ViewDeps = { storage: (admin) => supabaseReceiptStorage(admin), packet: defaultPacketDeps };

/** The period Settings shows: the one being filed (until its payment date), then this one so far. */
export function settingsPeriod(today: string, settings: TaxClerkSettings): { period: HstPeriod; toDate: boolean } {
  const last = lastEndedPeriod(today, settings.hst);
  if (today <= last.paymentDueDate) return { period: last, toDate: false };
  return { period: periodContaining(today, settings.hst), toDate: true };
}

export async function getTaxClerkView(admin: AdminClient, organizationId: string, companyId: string, opts: { manage: boolean; nowMs?: number } = { manage: false }, deps: ViewDeps = defaultViewDeps): Promise<TaxClerkView | null> {
  const company = await loadTaxClerkCompany(admin, organizationId, companyId);
  if (!company) return null;
  const base: TaxClerkView = {
    companyId,
    companyName: company.name,
    settings: company.settings,
    defaultEnabled: company.crankleads,
    hstNumberOnFile: Boolean(company.hstNumber),
    remindersActive: hstRemindersOn(company.settings),
    ownerPhoneOnFile: Boolean(company.ownerPhone),
    hst: null,
    toFinish: null,
    recent: null,
  };
  if (!opts.manage) return { ...base, settings: { ...company.settings, hst: { ...company.settings.hst, accountantEmail: null } } };
  const nowMs = opts.nowMs ?? Date.now();
  const today = localDate(new Date(nowMs), company.timeZone);
  const { period, toDate } = settingsPeriod(today, company.settings);
  const db = admin as Db;
  const [w, row, dest, finish, recent] = await Promise.all([
    worksheetFor(admin, company, toDate ? { start: period.start, end: today } : period),
    loadPeriodRow(admin, company, period),
    packetDestination(admin, company, deps.packet).catch(() => null),
    db.from("receipt_texts").select("*").eq("organization_id", organizationId).eq("company_id", companyId).eq("status", "needs_review").order("created_at", { ascending: false }).limit(20),
    db.from("receipt_texts").select("id, status, vendor, amount_cents, created_at, po_reference").eq("organization_id", organizationId).eq("company_id", companyId).in("status", ["filed", "duplicate", "needs_review"]).order("created_at", { ascending: false }).limit(10),
  ]);
  const finishRows = (finish.data ?? []) as ReceiptTextRow[];
  const urls = await deps.storage(admin).signedUrls(organizationId, finishRows.map((r) => r.file_path).filter((p): p is string => !!p), 3600);
  const pr = row as HstPeriodRow | null;
  return {
    ...base,
    hst: {
      period: { label: period.label, range: period.range, start: period.start, end: period.end, dueDate: period.dueDate, paymentDueDate: period.paymentDueDate, toDate },
      salesCents: w.salesCents,
      collectedCents: w.collectedCents,
      itcCents: w.itcCents,
      netCents: w.netCents,
      missingReceipts: w.missingReceipts,
      importedExcluded: w.importedExcluded,
      packet: { emailedAt: pr?.packet_emailed_at ?? null, emailedTo: pr?.packet_emailed_to ?? null, error: pr?.packet_error ?? null, sendsTo: dest?.to ?? null },
      disclaimer: DISCLAIMER,
    },
    toFinish: finishRows.map((r) => ({
      id: r.id,
      vendor: r.vendor,
      spentOn: r.spent_on,
      taxCents: r.tax_cents,
      category: r.category,
      createdAt: r.created_at,
      pictureUrl: r.file_path ? (urls.get(r.file_path) ?? null) : null,
      missing: r.missing ?? [],
    })),
    recent: ((recent.data ?? []) as ReceiptTextRow[]).map((r) => ({ id: r.id, status: r.status, vendor: r.vendor, amountCents: r.amount_cents, createdAt: r.created_at, poReference: r.po_reference })),
  };
}

/** Merge ONLY ai_settings.tax_clerk; returns the fresh view (null → company not found). */
export async function updateTaxClerk(admin: AdminClient, organizationId: string, companyId: string, patch: TaxClerkPatch, deps: ViewDeps = defaultViewDeps): Promise<TaxClerkView | null> {
  const written = await updateAiSettings(admin, { organizationId, companyId }, (current) => mergeTaxClerkSettings(current, patch));
  if (!written) return null;
  return getTaxClerkView(admin, organizationId, companyId, { manage: true }, deps);
}

export interface FinishInput {
  id: string;
  action: "file" | "discard";
  amountCents?: number;
  taxCents?: number;
  spentOn?: string;
  category?: ExpenseCategory;
}

/** Owner/admin: file a receipt picture that was missing its total, or throw it away. */
export async function finishReceipt(
  admin: AdminClient,
  scope: { organizationId: string; companyId: string },
  actorProfileId: string,
  input: FinishInput,
  nowMs: number = Date.now(),
  deps: ViewDeps = defaultViewDeps,
): Promise<{ status: "filed" | "discarded" | "duplicate" | "not_found" | "invalid"; message: string }> {
  const db = admin as Db;
  const { data } = await db.from("receipt_texts").select("*").eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).eq("id", input.id).maybeSingle();
  const row = data as ReceiptTextRow | null;
  if (!row || row.status !== "needs_review") return { status: "not_found", message: "That receipt isn't waiting any more." };
  if (input.action === "discard") {
    const { data: claimed } = await db.from("receipt_texts").update({ status: "discarded" }).eq("id", row.id).eq("organization_id", scope.organizationId).eq("status", "needs_review").select("id");
    if (((claimed ?? []) as unknown[]).length && row.file_path) await deps.storage(admin).remove(scope.organizationId, row.file_path);
    return { status: "discarded", message: "Thrown away." };
  }
  const amount = input.amountCents ?? row.amount_cents ?? 0;
  const tax = input.taxCents ?? row.tax_cents ?? 0;
  const company = await loadTaxClerkCompany(admin, scope.organizationId, scope.companyId);
  const spentOn = input.spentOn ?? row.spent_on ?? localDate(new Date(nowMs), company?.timeZone ?? "America/Toronto");
  const category = input.category ?? ((EXPENSE_CATEGORIES as readonly string[]).includes(row.category ?? "") ? (row.category as ExpenseCategory) : "other");
  if (!(amount > 0) || tax < 0 || tax > amount || !isValidDateString(spentOn)) return { status: "invalid", message: "Enter the total (and HST no more than the total)." };
  const dup = await findDuplicate(admin, scope, { vendor: row.vendor, spentOn, amountCents: amount });
  if (dup) {
    await db.from("receipt_texts").update({ status: "duplicate", duplicate_of: dup.id }).eq("id", row.id).eq("organization_id", scope.organizationId);
    return { status: "duplicate", message: "That one's already in your expenses." };
  }
  const { data: claimed } = await db.from("receipt_texts").update({ status: "reading" }).eq("id", row.id).eq("organization_id", scope.organizationId).eq("status", "needs_review").select("id");
  if (((claimed ?? []) as unknown[]).length === 0) return { status: "not_found", message: "That receipt isn't waiting any more." };
  const { data: inserted, error } = await db
    .from("expenses")
    .insert({
      organization_id: scope.organizationId,
      company_id: scope.companyId,
      booking_id: row.booking_id,
      spent_on: spentOn,
      vendor: row.vendor,
      description: row.description,
      category,
      amount_cents: amount,
      tax_cents: tax,
      paid_with: row.paid_with ?? "business",
      billable: false,
      receipt_path: row.file_path,
      receipt_type: row.file_path ? row.file_type : null,
      created_by: actorProfileId,
    })
    .select("id")
    .single();
  if (error || !inserted) {
    await db.from("receipt_texts").update({ status: "needs_review" }).eq("id", row.id).eq("organization_id", scope.organizationId);
    return { status: "invalid", message: "Couldn't save it - try again." };
  }
  await db
    .from("receipt_texts")
    .update({ status: "filed", expense_id: (inserted as { id: string }).id, amount_cents: amount, tax_cents: tax, spent_on: spentOn, category, missing: [], filed_at: new Date(nowMs).toISOString() })
    .eq("id", row.id)
    .eq("organization_id", scope.organizationId);
  return { status: "filed", message: "Filed." };
}

/** Owner/admin: email the packet for the period Settings shows (their own click — no approval). */
export async function emailPacketFromApp(
  admin: AdminClient,
  scope: { organizationId: string; companyId: string },
  nowMs: number = Date.now(),
  deps: ViewDeps = defaultViewDeps,
): Promise<{ status: "sent" | "busy" | "failed" | "no_email" | "not_found" | "not_over"; to: string | null; message: string }> {
  const company = await loadTaxClerkCompany(admin, scope.organizationId, scope.companyId);
  if (!company) return { status: "not_found", to: null, message: "Company not found." };
  const today = localDate(new Date(nowMs), company.timeZone);
  const { period, toDate } = settingsPeriod(today, company.settings);
  const target = toDate ? lastEndedPeriod(today, company.settings.hst) : period;
  const dest = await packetDestination(admin, company, deps.packet);
  if (!dest) return { status: "no_email", to: null, message: "Add an accountant email (or an owner email) first." };
  const out = await emailPacket(admin, company, target, dest.to, nowMs, deps.packet);
  if (out.status === "sent") return { status: "sent", to: dest.to, message: `Emailed the ${target.label} packet to ${dest.to}.` };
  if (out.status === "busy") return { status: "busy", to: dest.to, message: "It's already going out." };
  return { status: "failed", to: dest.to, message: "Couldn't send it - try again in a minute." };
}
