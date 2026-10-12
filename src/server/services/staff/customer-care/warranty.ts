/**
 * Warranty: the default workmanship warranty (settings), per price-list item overrides
 * (warranty_terms), one job_warranties row per completed job, and installed equipment with its
 * manufacturer warranty. The SMS agent's check_warranty reads these as FACTS only: whether the
 * owner covers something is always the owner's call (warranty_claim).
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import type { CareBooking, Db, InstalledEquipmentRow, JobWarrantyRow, WarrantyTermRow } from "./db-types";
import type { CareCompany } from "./settings";
import { addMonths, localDate } from "./time";

type Scope = { organizationId: string; companyId: string };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The price-list items a job was sold with: the booking's own item + its quote's services. */
export async function catalogItemsOfJob(admin: AdminClient, scope: Scope, booking: Pick<CareBooking, "service_item_id" | "quote_id">): Promise<string[]> {
  const ids = new Set<string>();
  if (booking.service_item_id) ids.add(booking.service_item_id);
  if (booking.quote_id) {
    const db = admin as Db;
    const { data: quote, error } = await db.from("quotes").select("id, company_id, input_snapshot").eq("organization_id", scope.organizationId).eq("id", booking.quote_id).maybeSingle();
    if (error) throw error;
    const q = quote as { company_id: string | null; input_snapshot: unknown } | null;
    if (q && (!q.company_id || q.company_id === scope.companyId)) {
      const keys = (Array.isArray(record(q.input_snapshot).services) ? (record(q.input_snapshot).services as unknown[]) : [])
        .map((s) => record(s).serviceId)
        .filter((k): k is string => typeof k === "string" && k.length > 0)
        .slice(0, 50);
      if (keys.length) {
        const { data: items, error: e2 } = await db.from("service_catalog_items").select("id, service_key").eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).in("service_key", keys);
        if (e2) throw e2;
        for (const i of (items ?? []) as Array<{ id: string }>) ids.add(i.id);
      }
    }
  }
  return [...ids];
}

export interface WarrantyTermChoice {
  months: number;
  terms: string | null;
  source: "default" | "item";
}

/** The job's workmanship warranty: the longest override among its items, else the company default. PURE. */
export function chooseTerm(defaults: { months: number; terms: string | null }, overrides: Array<Pick<WarrantyTermRow, "months" | "terms_text">>): WarrantyTermChoice {
  if (overrides.length === 0) return { months: defaults.months, terms: defaults.terms, source: "default" };
  const best = overrides.slice().sort((a, b) => b.months - a.months)[0];
  return { months: best.months, terms: best.terms_text ?? defaults.terms, source: "item" };
}

export async function loadTerms(admin: AdminClient, scope: Scope, catalogItemIds?: string[]): Promise<WarrantyTermRow[]> {
  let q = (admin as Db).from("warranty_terms").select("*").eq("organization_id", scope.organizationId).eq("company_id", scope.companyId);
  if (catalogItemIds) {
    if (catalogItemIds.length === 0) return [];
    q = q.in("service_catalog_item_id", catalogItemIds);
  }
  const { data, error } = await q.limit(1000);
  if (error) throw error;
  return (data ?? []) as WarrantyTermRow[];
}

/**
 * A completed job's warranty row (once per booking; a repeat or a racing worker is a no-op).
 * No row when the job's term is 0 months. Returns the row (new or existing) or null.
 */
export async function ensureJobWarranty(admin: AdminClient, company: CareCompany, booking: CareBooking, jobLabel: string | null): Promise<JobWarrantyRow | null> {
  const scope = { organizationId: company.organizationId, companyId: company.companyId };
  const db = admin as Db;
  const { data: existing, error: e0 } = await db.from("job_warranties").select("*").eq("organization_id", scope.organizationId).eq("booking_id", booking.id).maybeSingle();
  if (e0) throw e0;
  if (existing) return existing as JobWarrantyRow;
  const items = await catalogItemsOfJob(admin, scope, booking);
  const term = chooseTerm(company.settings.warranty, await loadTerms(admin, scope, items));
  if (term.months <= 0) return null;
  const doneMs = Date.parse(booking.completed_at ?? booking.scheduled_for);
  const startsOn = localDate(new Date(Number.isFinite(doneMs) ? doneMs : Date.now()), company.timeZone);
  const { data, error } = await db
    .from("job_warranties")
    .insert({
      organization_id: scope.organizationId,
      company_id: scope.companyId,
      contact_id: booking.contact_id,
      booking_id: booking.id,
      job_label: jobLabel,
      starts_on: startsOn,
      ends_on: addMonths(startsOn, term.months),
      months: term.months,
      terms_text: term.terms,
      source: term.source,
    })
    .select("*")
    .single();
  if (error) {
    if ((error as { code?: string }).code === "23505") return null;
    throw error;
  }
  return data as JobWarrantyRow;
}

export interface CustomerWarranties {
  jobs: JobWarrantyRow[];
  equipment: InstalledEquipmentRow[];
}

/** A customer's job warranties (newest first) and active installed equipment. */
export async function warrantiesFor(admin: AdminClient, scope: Scope, contactIds: string[]): Promise<CustomerWarranties> {
  if (contactIds.length === 0) return { jobs: [], equipment: [] };
  const db = admin as Db;
  const [{ data: jobs, error: e1 }, { data: equipment, error: e2 }] = await Promise.all([
    db.from("job_warranties").select("*").eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).in("contact_id", contactIds).order("starts_on", { ascending: false }).limit(50),
    db.from("installed_equipment").select("*").eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).in("contact_id", contactIds).eq("active", true).limit(50),
  ]);
  if (e1) throw e1;
  if (e2) throw e2;
  return { jobs: (jobs ?? []) as JobWarrantyRow[], equipment: (equipment ?? []) as InstalledEquipmentRow[] };
}

/** Words of the job label / equipment that the customer's words mention ("roof", "furnace"). PURE. */
export function mentions(words: string, label: string | null | undefined): boolean {
  if (!label) return false;
  const text = words.toLowerCase();
  return label
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4)
    .some((w) => text.includes(w.replace(/s$/, "")));
}
