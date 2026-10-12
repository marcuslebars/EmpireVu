/**
 * Tracking orders and the owner's own records (docs/ai-staff.md → "Purchasing"): where each PO
 * stands with estimated vs actual cost, marking one ready / picked up / delivered / cancelled,
 * and saving suppliers and recipes (owner tools + Settings share these).
 *
 * Actual cost = the job's expenses (receipts) before tax — the same figure job costing uses. This
 * module never writes job_materials or expenses.
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { localDate } from "@/server/services/booking-windows";
import type { Db, MaterialRecipeRow, PoStatus, PurchaseOrderRow, SupplierRow } from "./db-types";
import { dayLabel, lineText } from "./format";
import { BOOKING_COLUMNS, jobName, toJobs, type JobInfo } from "./orders";
import type { PurchasingCompany } from "./settings";

type Scope = { organizationId: string; companyId: string };

// ── Finding orders and jobs ─────────────────────────────────────────────────────

function norm(text: string | null | undefined): string {
  return (text ?? "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

/** Words in `query` (≥ 2 chars) that all appear in the job's name / title. PURE. */
export function jobMatches(job: Pick<JobInfo, "firstName" | "lastName" | "title">, query: string): boolean {
  const hay = ` ${norm(`${job.firstName ?? ""} ${job.lastName ?? ""} ${job.title}`)} `;
  const words = norm(query)
    .split(" ")
    .filter((w) => w.length >= 2 && !["job", "the", "for", "materials", "material", "order", "s"].includes(w));
  return words.length > 0 && words.every((w) => hay.includes(` ${w}`) || hay.includes(` ${w.replace(/s$/, "")}`));
}

/** "PO-12" / "po 12" / "#12"? → 12. PURE. */
export function poSeqOf(text: string | null | undefined): number | null {
  const m = /\bpo[\s#-]*(\d{1,6})\b/i.exec(text ?? "");
  return m ? Number(m[1]) : null;
}

export async function loadOrders(admin: AdminClient, scope: Scope, opts: { sinceIso?: string; includeCancelled?: boolean; limit?: number } = {}): Promise<PurchaseOrderRow[]> {
  let q = (admin as Db).from("purchase_orders").select("*").eq("organization_id", scope.organizationId).eq("company_id", scope.companyId);
  if (opts.sinceIso) q = q.gte("created_at", opts.sinceIso);
  const { data, error } = await q.order("created_at", { ascending: false }).limit(opts.limit ?? 50);
  if (error) throw error;
  const rows = (data ?? []) as PurchaseOrderRow[];
  return opts.includeCancelled ? rows : rows.filter((r) => r.status !== "cancelled");
}

async function jobsFor(admin: AdminClient, scope: Scope, bookingIds: string[]): Promise<Map<string, JobInfo>> {
  if (bookingIds.length === 0) return new Map();
  const { data, error } = await (admin as Db).from("bookings").select(BOOKING_COLUMNS).eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).in("id", bookingIds);
  if (error) throw error;
  return new Map((await toJobs(admin, scope.organizationId, (data ?? []) as never)).map((j) => [j.bookingId, j]));
}

/** Pre-tax receipts on each job (the same figure job costing uses). */
export async function actualCosts(admin: AdminClient, scope: Scope, bookingIds: string[]): Promise<Map<string, { cents: number; receipts: number }>> {
  const out = new Map<string, { cents: number; receipts: number }>();
  if (bookingIds.length === 0) return out;
  const { data, error } = await (admin as Db).from("expenses").select("booking_id, amount_cents, tax_cents").eq("organization_id", scope.organizationId).in("booking_id", bookingIds);
  if (error) throw error;
  for (const e of (data ?? []) as Array<{ booking_id: string; amount_cents: number; tax_cents: number | null }>) {
    const prev = out.get(e.booking_id) ?? { cents: 0, receipts: 0 };
    out.set(e.booking_id, { cents: prev.cents + (e.amount_cents - (e.tax_cents ?? 0)), receipts: prev.receipts + 1 });
  }
  return out;
}

export interface OrderStatusLine {
  po: string;
  status: string;
  job: string | null;
  jobDay: string | null;
  supplier: string | null;
  fulfilment: string;
  neededBy: string | null;
  items: string[];
  estimated: string;
  actual: string;
  receipts: number;
  difference: string | null;
  estimate_kind: string;
}

function money(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${(abs / 100).toLocaleString("en-CA", { minimumFractionDigits: abs % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
}

/** Orders as the owner sees them, with estimated vs actual (receipts on the job, before tax). */
export async function materialsStatus(admin: AdminClient, company: PurchasingCompany, query: { job?: string | null; po?: string | null }, nowMs: number): Promise<{ orders: OrderStatusLine[]; note?: string }> {
  const scope = { organizationId: company.organizationId, companyId: company.companyId };
  const seq = poSeqOf(query.po ?? query.job ?? null);
  const all = await loadOrders(admin, scope, { sinceIso: new Date(nowMs - 90 * 86_400_000).toISOString(), includeCancelled: seq != null, limit: 100 });
  const jobs = await jobsFor(admin, scope, [...new Set(all.map((p) => p.booking_id).filter((id): id is string => Boolean(id)))]);
  const today = localDate(new Date(nowMs), company.timeZone);
  let picked = all;
  if (seq != null) picked = all.filter((p) => p.po_seq === seq);
  else if (query.job?.trim()) picked = all.filter((p) => {
    const j = p.booking_id ? jobs.get(p.booking_id) : undefined;
    return j ? jobMatches(j, query.job!) : false;
  });
  else
    picked = all.filter((p) => {
      const j = p.booking_id ? jobs.get(p.booking_id) : undefined;
      const jobDate = j ? localDate(new Date(j.scheduledFor), company.timeZone) : null;
      return !["picked_up", "delivered"].includes(p.status) || (jobDate != null && jobDate >= today);
    });
  picked = picked.slice(0, 12);
  const actual = await actualCosts(admin, scope, [...new Set(picked.map((p) => p.booking_id).filter((id): id is string => Boolean(id)))]);
  const orders = picked.map((p) => {
    const j = p.booking_id ? jobs.get(p.booking_id) : undefined;
    const a = p.booking_id ? actual.get(p.booking_id) ?? { cents: 0, receipts: 0 } : { cents: 0, receipts: 0 };
    return {
      po: p.po_number,
      status: p.status === "draft" ? "waiting on your Y/N" : p.status.replace("_", " "),
      job: j ? jobName(j) : null,
      jobDay: j ? dayLabel(localDate(new Date(j.scheduledFor), company.timeZone)) : null,
      supplier: p.supplier_name,
      fulfilment: p.fulfilment,
      neededBy: dayLabel(p.needed_by) || null,
      items: p.lines.map(lineText),
      estimated: p.est_total_cents > 0 ? money(p.est_total_cents) : "no estimate",
      actual: a.receipts ? money(a.cents) : "no receipts yet",
      receipts: a.receipts,
      difference: a.receipts && p.est_total_cents > 0 ? money(a.cents - p.est_total_cents) : null,
      estimate_kind: p.basis === "ai" ? "AI estimate" : p.basis === "mixed" ? "recipes + AI estimate" : p.basis === "owner" ? "owner's list" : "recipes",
    };
  });
  const note = orders.length === 0 ? (seq != null || query.job ? "No order matches that." : "No open materials orders.") : "Actual = receipts on the job before tax (all of them, not only materials).";
  return { orders, note };
}

// ── Marking ────────────────────────────────────────────────────────────────────

export type MarkAs = "confirmed" | "ready" | "picked_up" | "delivered" | "cancelled";
const MARKABLE_FROM: PoStatus[] = ["approved", "sent", "confirmed", "ready"];

/** Find one order by "PO-12" or job words; ambiguous / none → a message. */
export async function findOrder(admin: AdminClient, company: PurchasingCompany, ref: string): Promise<{ po: PurchaseOrderRow; job: JobInfo | null } | { error: string }> {
  const scope = { organizationId: company.organizationId, companyId: company.companyId };
  const seq = poSeqOf(ref) ?? (/^\s*#?\s*(\d{1,6})\s*$/.test(ref) ? Number(ref.replace(/\D/g, "")) : null);
  const all = await loadOrders(admin, scope, { includeCancelled: seq != null, limit: 200 });
  const jobs = await jobsFor(admin, scope, [...new Set(all.map((p) => p.booking_id).filter((id): id is string => Boolean(id)))]);
  const hits = seq != null ? all.filter((p) => p.po_seq === seq) : all.filter((p) => (p.booking_id && jobs.get(p.booking_id) ? jobMatches(jobs.get(p.booking_id)!, ref) : false));
  if (hits.length === 0) return { error: `No materials order matches "${ref}".` };
  if (hits.length > 1) return { error: `More than one order matches: ${hits.slice(0, 5).map((p) => `${p.po_number} (${p.booking_id && jobs.get(p.booking_id) ? jobName(jobs.get(p.booking_id)!) : "no job"})`).join(", ")}. Which PO?` };
  return { po: hits[0], job: hits[0].booking_id ? jobs.get(hits[0].booking_id) ?? null : null };
}

export async function markOrder(admin: AdminClient, company: PurchasingCompany, ref: string, status: MarkAs, nowMs: number): Promise<{ ok: true; message: string } | { error: string }> {
  const found = await findOrder(admin, company, ref);
  if ("error" in found) return found;
  const { po } = found;
  if (po.status === status) return { ok: true, message: `${po.po_number} is already ${status.replace("_", " ")}.` };
  if (po.status === "draft") return { error: `${po.po_number} hasn't been ordered yet - answer its Y/N question first.` };
  if (!MARKABLE_FROM.includes(po.status)) return { error: `${po.po_number} is ${po.status.replace("_", " ")} - it can't be changed now.` };
  const { data } = await (admin as Db)
    .from("purchase_orders")
    .update({ status, status_changed_at: new Date(nowMs).toISOString(), ...(status === "cancelled" ? { cancel_reason: "owner" } : {}) })
    .eq("id", po.id)
    .eq("organization_id", company.organizationId)
    .eq("status", po.status)
    .select("id");
  if (((data ?? []) as unknown[]).length === 0) return { error: `${po.po_number} just changed - ask me for its status again.` };
  const tell =
    status === "cancelled" && po.sent_via === "email"
      ? ` I didn't tell ${po.supplier_name ?? "the supplier"} - call them to cancel.`
      : status === "cancelled" && po.status !== "approved"
        ? ` Let ${po.supplier_name ?? "the supplier"} know if you called it in.`
        : "";
  return { ok: true, message: `Marked ${po.po_number} ${status.replace("_", " ")}.${tell}` };
}

// ── Suppliers and recipes (owner tools + Settings) ─────────────────────────────

const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/;

export function cleanEmail(value: unknown): string | null | undefined {
  if (value === null || value === "") return null;
  if (typeof value !== "string") return undefined;
  const t = value.trim().toLowerCase();
  return t.length <= 254 && EMAIL_RE.test(t) ? t : undefined;
}

/** "705 555 0123" → "+17055550123"; "+44…" kept. undefined = invalid. */
export function cleanPhone(value: unknown): string | null | undefined {
  if (value === null || value === "") return null;
  if (typeof value !== "string") return undefined;
  const t = value.trim();
  if (/^\+\d{8,15}$/.test(t.replace(/[\s().-]/g, ""))) return t.replace(/[\s().-]/g, "");
  const d = t.replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return undefined;
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const t = value.replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : null;
}

export interface SupplierInput {
  id?: string | null;
  name?: string | null;
  branch?: string | null;
  email?: string | null;
  phone?: string | null;
  accountNumber?: string | null;
  preferred?: boolean;
  notes?: string | null;
  active?: boolean;
}

/** Create or update a supplier (by id, else by name + branch). Preferred is exclusive. */
export async function saveSupplier(admin: AdminClient, scope: Scope, input: SupplierInput, nowMs: number): Promise<{ supplier: SupplierRow; created: boolean } | { error: string }> {
  const db = admin as Db;
  const email = cleanEmail(input.email);
  if (email === undefined && input.email !== undefined) return { error: "That email doesn't look right." };
  const phone = cleanPhone(input.phone);
  if (phone === undefined && input.phone !== undefined) return { error: "That phone number doesn't look right." };
  const name = cleanText(input.name, 80);
  const branch = input.branch === undefined ? undefined : cleanText(input.branch, 80);
  const all = await db.from("suppliers").select("*").eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).limit(500);
  if (all.error) throw all.error;
  const rows = (all.data ?? []) as SupplierRow[];
  const existing = input.id
    ? rows.find((s) => s.id === input.id)
    : name
      ? rows.find((s) => s.name.toLowerCase() === name.toLowerCase() && (branch === undefined || (s.branch ?? "").toLowerCase() === (branch ?? "").toLowerCase()))
      : undefined;
  if (input.id && !existing) return { error: "Supplier not found." };
  if (!existing && !name) return { error: "What's the supplier called?" };
  const nowIso = new Date(nowMs).toISOString();
  const fields: Record<string, unknown> = { updated_at: nowIso };
  if (name) fields.name = name;
  if (branch !== undefined) fields.branch = branch;
  if (input.email !== undefined) fields.email = email;
  if (input.phone !== undefined) fields.phone = phone;
  if (input.accountNumber !== undefined) fields.account_number = cleanText(input.accountNumber, 60);
  if (input.notes !== undefined) fields.notes = cleanText(input.notes, 500);
  if (typeof input.active === "boolean") fields.active = input.active;
  // One preferred supplier per company (a unique index): clear the others first.
  const willBePreferred = typeof input.preferred === "boolean" ? input.preferred : existing ? existing.preferred : !rows.some((s) => s.active);
  if (willBePreferred) {
    for (const other of rows.filter((s) => s.id !== existing?.id && s.preferred)) {
      await db.from("suppliers").update({ preferred: false, updated_at: nowIso }).eq("id", other.id).eq("company_id", scope.companyId);
    }
  }
  fields.preferred = willBePreferred;
  if (fields.active === false) fields.preferred = false;
  let saved: SupplierRow;
  if (existing) {
    const { data, error } = await db.from("suppliers").update(fields).eq("id", existing.id).eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).select("*");
    if (error) throw error;
    saved = ((data ?? []) as SupplierRow[])[0] ?? { ...existing, ...fields };
  } else {
    if (rows.filter((s) => s.active).length >= 50) return { error: "That's 50 suppliers - remove one first." };
    const { data, error } = await db
      .from("suppliers")
      .insert({ organization_id: scope.organizationId, company_id: scope.companyId, active: true, created_at: nowIso, ...fields })
      .select("*")
      .single();
    if (error) throw error;
    saved = data as SupplierRow;
  }
  return { supplier: saved, created: !existing };
}

/** Remove a supplier (soft: past POs keep its name). */
export async function removeSupplier(admin: AdminClient, scope: Scope, id: string, nowMs: number): Promise<boolean> {
  const { data } = await (admin as Db)
    .from("suppliers")
    .update({ active: false, preferred: false, updated_at: new Date(nowMs).toISOString() })
    .eq("id", id)
    .eq("organization_id", scope.organizationId)
    .eq("company_id", scope.companyId)
    .select("id");
  return ((data ?? []) as unknown[]).length > 0;
}

export interface RecipeLineInput {
  label: string;
  qtyPerUnit: number;
  unit?: string | null;
  estUnitCostCents?: number | null;
  supplierId?: string | null;
}

/** Replace a catalog item's recipe (empty list clears it). */
export async function saveRecipe(admin: AdminClient, scope: Scope, catalogItemId: string, lines: RecipeLineInput[], nowMs: number): Promise<{ lines: MaterialRecipeRow[] } | { error: string }> {
  const db = admin as Db;
  const { data: item, error } = await db.from("service_catalog_items").select("id").eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).eq("id", catalogItemId).maybeSingle();
  if (error) throw error;
  if (!item) return { error: "That service isn't on your price list." };
  if (lines.length > 30) return { error: "Up to 30 materials per service." };
  const supplierIds = [...new Set(lines.map((l) => l.supplierId).filter((id): id is string => Boolean(id)))];
  if (supplierIds.length) {
    const { data: sup } = await db.from("suppliers").select("id").eq("company_id", scope.companyId).in("id", supplierIds);
    if (((sup ?? []) as unknown[]).length !== supplierIds.length) return { error: "Pick a supplier from your list." };
  }
  const clean = [];
  const seen = new Set<string>();
  for (const [i, l] of lines.entries()) {
    const label = cleanText(l.label, 80);
    if (!label) return { error: `Line ${i + 1} needs a name.` };
    if (!(typeof l.qtyPerUnit === "number" && l.qtyPerUnit > 0 && l.qtyPerUnit <= 10_000)) return { error: `${label}: the amount per unit must be more than 0.` };
    const cost = l.estUnitCostCents;
    if (cost != null && !(Number.isInteger(cost) && cost >= 0 && cost <= 5_000_000)) return { error: `${label}: the cost looks off.` };
    const key = `${label.toLowerCase()}|${(l.unit ?? "").toLowerCase()}`;
    if (seen.has(key)) return { error: `${label} is listed twice.` };
    seen.add(key);
    clean.push({
      organization_id: scope.organizationId,
      company_id: scope.companyId,
      service_catalog_item_id: catalogItemId,
      label,
      qty_per_unit: Math.round(l.qtyPerUnit * 1000) / 1000,
      unit: cleanText(l.unit, 20),
      supplier_id: l.supplierId ?? null,
      est_unit_cost_cents: cost ?? null,
      sort_order: i,
      created_at: new Date(nowMs).toISOString(),
      updated_at: new Date(nowMs).toISOString(),
    });
  }
  const del = await db.from("material_recipes").delete().eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).eq("service_catalog_item_id", catalogItemId);
  if (del.error) throw del.error;
  if (clean.length === 0) return { lines: [] };
  const { data, error: insErr } = await db.from("material_recipes").insert(clean).select("*");
  if (insErr) throw insErr;
  return { lines: (data ?? []) as MaterialRecipeRow[] };
}
