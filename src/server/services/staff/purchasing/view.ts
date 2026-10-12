/**
 * Settings → AI front desk → Purchasing (docs/ai-staff.md → "Purchasing"): the settings, the
 * suppliers (owners/admins only — account numbers), the recipe editor's price list, and recent
 * orders. Writes go through updateAiSettings (only ai_settings.purchasing) and tracking.ts.
 */
import { isAIConfigured } from "@/server/ai/claude";
import { updateAiSettings } from "@/server/services/front-desk/ai-settings-write";
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { localDate } from "@/server/services/booking-windows";
import type { Db, Fulfilment, MaterialRecipeRow, PurchaseOrderRow, SupplierRow } from "./db-types";
import { dayLabel, lineText } from "./format";
import { jobName, loadSuppliers, ownerReplyEmail, toJobs, BOOKING_COLUMNS } from "./orders";
import { loadPurchasingCompany, mergePurchasingSettings, type PurchasingSettings, type PurchasingSettingsPatch } from "./settings";

type Scope = { organizationId: string; companyId: string };

export interface SupplierView {
  id: string;
  name: string;
  branch: string | null;
  email: string | null;
  phone: string | null;
  accountNumber: string | null;
  preferred: boolean;
  notes: string | null;
}

export interface RecipeLineView {
  label: string;
  qtyPerUnit: number;
  unit: string | null;
  estUnitCostCents: number | null;
  supplierId: string | null;
}

export interface CatalogItemView {
  id: string;
  label: string;
  unitLabel: string | null;
  recipe: RecipeLineView[];
}

export interface OrderView {
  id: string;
  poNumber: string;
  status: string;
  job: string | null;
  jobDay: string | null;
  supplier: string | null;
  fulfilment: Fulfilment;
  neededBy: string | null;
  estTotalCents: number;
  estimate: boolean;
  items: string[];
}

export interface PurchasingView {
  companyId: string;
  companyName: string;
  settings: PurchasingSettings;
  ownerPhoneOnFile: boolean;
  replyToEmail: string | null;
  aiAvailable: boolean;
  /** Owners/admins only (null for members). */
  suppliers: SupplierView[] | null;
  catalog: CatalogItemView[];
  orders: OrderView[];
}

export function supplierView(s: SupplierRow): SupplierView {
  return { id: s.id, name: s.name, branch: s.branch, email: s.email, phone: s.phone, accountNumber: s.account_number, preferred: s.preferred, notes: s.notes };
}

export async function getPurchasingView(admin: AdminClient, scope: Scope, opts: { manager: boolean }): Promise<PurchasingView | null> {
  const company = await loadPurchasingCompany(admin, scope.organizationId, scope.companyId);
  if (!company) return null;
  const db = admin as Db;
  const [{ data: items, error: e1 }, { data: recipes, error: e2 }, { data: pos, error: e3 }] = await Promise.all([
    db.from("service_catalog_items").select("id, label, unit_label, sort_order").eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).eq("active", true).order("sort_order", { ascending: true }).limit(500),
    db.from("material_recipes").select("*").eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).order("sort_order", { ascending: true }).limit(5000),
    db.from("purchase_orders").select("*").eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).order("created_at", { ascending: false }).limit(10),
  ]);
  if (e1) throw e1;
  if (e2) throw e2;
  if (e3) throw e3;
  const byItem = new Map<string, RecipeLineView[]>();
  for (const r of (recipes ?? []) as MaterialRecipeRow[]) {
    byItem.set(r.service_catalog_item_id, [
      ...(byItem.get(r.service_catalog_item_id) ?? []),
      { label: r.label, qtyPerUnit: Number(r.qty_per_unit), unit: r.unit, estUnitCostCents: r.est_unit_cost_cents, supplierId: r.supplier_id },
    ]);
  }
  const orders = (pos ?? []) as PurchaseOrderRow[];
  const bookingIds = [...new Set(orders.map((p) => p.booking_id).filter((id): id is string => Boolean(id)))];
  const { data: bookings } = bookingIds.length
    ? await db.from("bookings").select(BOOKING_COLUMNS).eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).in("id", bookingIds)
    : { data: [] };
  const jobs = new Map((await toJobs(admin, scope.organizationId, (bookings ?? []) as never)).map((j) => [j.bookingId, j]));
  return {
    companyId: company.companyId,
    companyName: company.name,
    settings: company.settings,
    ownerPhoneOnFile: Boolean(company.ownerPhone),
    replyToEmail: opts.manager ? await ownerReplyEmail(admin, company) : null,
    aiAvailable: isAIConfigured(),
    suppliers: opts.manager ? (await loadSuppliers(admin, scope)).map(supplierView) : null,
    catalog: ((items ?? []) as Array<{ id: string; label: string; unit_label: string | null }>).map((i) => ({ id: i.id, label: i.label, unitLabel: i.unit_label, recipe: byItem.get(i.id) ?? [] })),
    orders: orders.map((p) => {
      const job = p.booking_id ? jobs.get(p.booking_id) : undefined;
      return {
        id: p.id,
        poNumber: p.po_number,
        status: p.status,
        job: job ? jobName(job) : p.job_label ?? null,
        jobDay: job ? dayLabel(localDate(new Date(job.scheduledFor), company.timeZone)) : null,
        supplier: p.supplier_name,
        fulfilment: p.fulfilment,
        neededBy: p.needed_by,
        estTotalCents: p.est_total_cents,
        estimate: p.lines.some((l) => l.source === "ai"),
        items: p.lines.map(lineText),
      };
    }),
  };
}

/** Owner/admin: merge ONLY ai_settings.purchasing. */
export async function updatePurchasingSettings(admin: AdminClient, scope: Scope, patch: PurchasingSettingsPatch): Promise<PurchasingView | null> {
  const written = await updateAiSettings(admin, scope, (current) => mergePurchasingSettings(current, patch));
  if (!written) return null;
  return getPurchasingView(admin, scope, { manager: true });
}
