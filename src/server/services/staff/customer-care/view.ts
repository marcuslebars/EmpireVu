/**
 * Settings → AI front desk → Customer care & warranty (docs/ai-staff.md): the settings, the
 * numbers (check-ins, ratings, open cases), per-service warranty overrides, installed equipment and
 * — for owners/admins — the open cases. Writes: updateAiSettings (only ai_settings.customer_care),
 * warranty_terms, installed_equipment, resolving a case. All service role, scoped to the company.
 */
import { updateAiSettings } from "@/server/services/front-desk/ai-settings-write";
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { CONTACT_COLUMNS, type CareCaseRow, type CareContact, type Db, type InstalledEquipmentRow, type WarrantyTermRow } from "./db-types";
import { appendNote } from "./cases";
import { findContacts } from "./owner-tools";
import { loadCareCompany, mergeCustomerCareSettings, MAX_WARRANTY_MONTHS, type CustomerCareSettings, type CustomerCareSettingsPatch } from "./settings";
import { customerName, equipmentName } from "./texts";
import { localDate } from "./time";

type Scope = { organizationId: string; companyId: string };

export interface CareCaseView {
  id: string;
  customer: string;
  phone: string | null;
  kind: CareCaseRow["kind"];
  status: CareCaseRow["status"];
  rating: number | null;
  summary: string | null;
  job: string | null;
  opened: string;
  stage: string | null;
}

export interface CustomerCareView {
  companyId: string;
  companyName: string;
  /** False for house orgs that haven't switched it on (the switch is still shown). */
  settings: CustomerCareSettings;
  smsAgentOn: boolean;
  ownerPhoneOnFile: boolean;
  stats: { checkinsSent30: number; answered30: number; averageRating: number | null; ratings30: number; openCases: number };
  /** Owners/admins only (null for members). */
  cases: CareCaseView[] | null;
  catalog: Array<{ id: string; label: string; months: number | null; terms: string | null }>;
  equipment: Array<{ id: string; customer: string; name: string; serial: string | null; installedOn: string | null; warrantyEnds: string | null }>;
}

const STAGE: Record<string, string> = { offered: "times texted", booking: "booking", booked: "visit booked", owner_calls: "you're calling" };

export async function getCustomerCareView(admin: AdminClient, scope: Scope, opts: { manager: boolean }): Promise<CustomerCareView | null> {
  const company = await loadCareCompany(admin, scope.organizationId, scope.companyId);
  if (!company) return null;
  const db = admin as Db;
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const [{ data: checkins, error: e1 }, { data: cases, error: e2 }, { data: items, error: e3 }, { data: terms, error: e4 }, { data: equipment, error: e5 }] = await Promise.all([
    db.from("care_checkins").select("rating, answered_at").eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).eq("status", "sent").gte("sent_at", since).limit(5000),
    db.from("care_cases").select("*").eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).in("status", ["open", "scheduled"]).order("created_at", { ascending: false }).limit(100),
    db.from("service_catalog_items").select("id, label, sort_order").eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).eq("active", true).order("sort_order", { ascending: true }).limit(500),
    db.from("warranty_terms").select("*").eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).limit(1000),
    db.from("installed_equipment").select("*").eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).eq("active", true).order("created_at", { ascending: false }).limit(100),
  ]);
  for (const e of [e1, e2, e3, e4, e5]) if (e) throw e;
  const sent = (checkins ?? []) as Array<{ rating: number | null; answered_at: string | null }>;
  const rated = sent.filter((c) => typeof c.rating === "number") as Array<{ rating: number }>;
  const open = (cases ?? []) as CareCaseRow[];
  const gear = (equipment ?? []) as InstalledEquipmentRow[];
  const contactIds = [...new Set([...open.map((c) => c.contact_id), ...gear.map((g) => g.contact_id)].filter((v): v is string => !!v))];
  const { data: contacts } = contactIds.length ? await db.from("contacts").select(CONTACT_COLUMNS).eq("organization_id", scope.organizationId).in("id", contactIds) : { data: [] };
  const byId = new Map(((contacts ?? []) as CareContact[]).map((c) => [c.id, c]));
  const termBy = new Map(((terms ?? []) as WarrantyTermRow[]).map((t) => [t.service_catalog_item_id, t]));
  return {
    companyId: company.companyId,
    companyName: company.name,
    settings: company.settings,
    smsAgentOn: company.smsAgentOn,
    ownerPhoneOnFile: Boolean(company.ownerPhone),
    stats: {
      checkinsSent30: sent.length,
      answered30: sent.filter((c) => c.answered_at).length,
      averageRating: rated.length ? Math.round((rated.reduce((s, c) => s + c.rating, 0) / rated.length) * 10) / 10 : null,
      ratings30: rated.length,
      openCases: open.length,
    },
    cases: opts.manager
      ? open.map((c) => {
          const contact = c.contact_id ? (byId.get(c.contact_id) ?? null) : null;
          return {
            id: c.id,
            customer: customerName(contact),
            phone: contact?.phone ?? null,
            kind: c.kind,
            status: c.status,
            rating: c.rating,
            summary: c.summary,
            job: c.job_label,
            opened: localDate(new Date(c.created_at), company.timeZone),
            stage: c.visit_stage ? (STAGE[c.visit_stage] ?? c.visit_stage) : c.followup_decided_at ? null : "waiting on you",
          };
        })
      : null,
    catalog: ((items ?? []) as Array<{ id: string; label: string }>).map((i) => {
      const t = termBy.get(i.id);
      return { id: i.id, label: i.label, months: t ? t.months : null, terms: t?.terms_text ?? null };
    }),
    equipment: gear.map((g) => ({
      id: g.id,
      customer: customerName(g.contact_id ? (byId.get(g.contact_id) ?? null) : null),
      name: equipmentName(g),
      serial: g.serial,
      installedOn: g.installed_on,
      warrantyEnds: g.manufacturer_warranty_ends,
    })),
  };
}

/** Owner/admin: merge ONLY ai_settings.customer_care. */
export async function updateCustomerCareSettings(admin: AdminClient, scope: Scope, patch: CustomerCareSettingsPatch): Promise<CustomerCareView | null> {
  const written = await updateAiSettings(admin, scope, (current) => mergeCustomerCareSettings(current, patch));
  if (!written) return null;
  return getCustomerCareView(admin, scope, { manager: true });
}

/** A price-list item's warranty override; months null removes it (back to the default). */
export async function saveWarrantyTerm(admin: AdminClient, scope: Scope, input: { catalogItemId: string; months: number | null; terms?: string | null }): Promise<{ ok: true } | { error: string }> {
  const db = admin as Db;
  const { data: item } = await db.from("service_catalog_items").select("id").eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).eq("id", input.catalogItemId).maybeSingle();
  if (!item) return { error: "That service isn't on this price list." };
  if (input.months == null) {
    await db.from("warranty_terms").delete().eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).eq("service_catalog_item_id", input.catalogItemId);
    return { ok: true };
  }
  if (!Number.isInteger(input.months) || input.months < 0 || input.months > MAX_WARRANTY_MONTHS) return { error: "Months must be 0 to 600." };
  const terms = input.terms ? input.terms.replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 500) || null : null;
  const { error } = await db
    .from("warranty_terms")
    .upsert(
      { organization_id: scope.organizationId, company_id: scope.companyId, service_catalog_item_id: input.catalogItemId, months: input.months, terms_text: terms },
      { onConflict: "company_id,service_catalog_item_id" },
    );
  if (error) throw error;
  return { ok: true };
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export interface EquipmentInput {
  customer: string;
  make?: string | null;
  model?: string | null;
  serial?: string | null;
  installedOn?: string | null;
  warrantyEnds?: string | null;
  notes?: string | null;
}

export async function saveEquipment(admin: AdminClient, scope: Scope, input: EquipmentInput): Promise<{ ok: true } | { error: string }> {
  const company = await loadCareCompany(admin, scope.organizationId, scope.companyId);
  if (!company) return { error: "Company not found." };
  const clean = (v: string | null | undefined, max: number) => (v && v.trim() ? v.replace(/[<>]/g, "").trim().slice(0, max) : null);
  const make = clean(input.make, 80);
  const model = clean(input.model, 80);
  if (!make && !model) return { error: "Enter the make or model." };
  for (const d of [input.installedOn, input.warrantyEnds]) if (d && !YMD.test(d)) return { error: "Dates must be YYYY-MM-DD." };
  const contacts = await findContacts(admin, company, input.customer);
  if (contacts.length === 0) return { error: "No customer by that name or number." };
  if (contacts.length > 1) return { error: `More than one customer matches "${input.customer}" - add their last name or phone number.` };
  const { error } = await (admin as Db).from("installed_equipment").insert({
    organization_id: scope.organizationId,
    company_id: scope.companyId,
    contact_id: contacts[0].id,
    make,
    model,
    serial: clean(input.serial, 80),
    installed_on: input.installedOn || null,
    manufacturer_warranty_ends: input.warrantyEnds || null,
    notes: clean(input.notes, 500),
    active: true,
  });
  if (error) throw error;
  return { ok: true };
}

export async function removeEquipment(admin: AdminClient, scope: Scope, equipmentId: string): Promise<boolean> {
  const { data } = await (admin as Db).from("installed_equipment").update({ active: false }).eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).eq("id", equipmentId).select("id");
  return ((data ?? []) as unknown[]).length > 0;
}

export async function resolveCaseById(admin: AdminClient, scope: Scope, caseId: string, outcome: "resolved" | "closed", nowMs: number): Promise<boolean> {
  const db = admin as Db;
  const { data } = await db.from("care_cases").select("*").eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).eq("id", caseId).maybeSingle();
  const row = data as CareCaseRow | null;
  if (!row || (row.status !== "open" && row.status !== "scheduled")) return false;
  await db
    .from("care_cases")
    .update({ status: outcome, resolved_at: new Date(nowMs).toISOString(), notes: appendNote(row.notes, `Marked ${outcome} in Settings.`) })
    .eq("id", row.id)
    .eq("organization_id", scope.organizationId)
    .in("status", ["open", "scheduled"]);
  if (row.approval_ids?.length) await db.from("owner_approvals").update({ status: "superseded" }).in("id", row.approval_ids).eq("organization_id", scope.organizationId).eq("status", "pending");
  return true;
}

export { equipmentName };
