/**
 * Lines for the Office manager's 07:00 briefing (integration wires this in; read-only). Never
 * throws; [] when Customer care is off for the company.
 *
 *   "2 unhappy customers waiting (Dana Jones 2/5)"
 *   "Warranty visit for Dana today"
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { CONTACT_COLUMNS, type CareCaseRow, type CareContact, type Db } from "./db-types";
import { careWorks, loadCareCompany } from "./settings";
import { customerName, firstNameOf } from "./texts";
import { addDays, zonedInstant } from "./time";

const MAX_ITEMS = 3;

export async function briefingItems(admin: AdminClient, scope: { organizationId: string; companyId: string }, localDate: string): Promise<string[]> {
  try {
    const company = await loadCareCompany(admin, scope.organizationId, scope.companyId);
    if (!company || !careWorks(company)) return [];
    const db = admin as Db;
    const { data: cases, error } = await db
      .from("care_cases")
      .select("*")
      .eq("organization_id", scope.organizationId)
      .eq("company_id", scope.companyId)
      .eq("status", "open")
      .order("created_at", { ascending: true })
      .limit(200);
    if (error) throw error;
    // Waiting on the owner: open, and the owner hasn't chosen what to do yet.
    const waiting = ((cases ?? []) as CareCaseRow[]).filter((c) => !c.followup_decided_at);
    const dayStart = zonedInstant(localDate, "00:00", company.timeZone).toISOString();
    const dayEnd = zonedInstant(addDays(localDate, 1), "00:00", company.timeZone).toISOString();
    const { data: links, error: e2 } = await db.from("care_case_bookings").select("booking_id, kind").eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).order("created_at", { ascending: false }).limit(200);
    if (e2) throw e2;
    const kindOf = new Map(((links ?? []) as Array<{ booking_id: string; kind: string }>).map((l) => [l.booking_id, l.kind]));
    const ids = [...kindOf.keys()];
    const { data: todays, error: e3 } = ids.length
      ? await db.from("bookings").select("id, contact_id, scheduled_for, status").eq("organization_id", scope.organizationId).in("id", ids).gte("scheduled_for", dayStart).lt("scheduled_for", dayEnd).in("status", ["pending", "confirmed"])
      : { data: [], error: null };
    if (e3) throw e3;
    const visits = (todays ?? []) as Array<{ id: string; contact_id: string | null }>;
    const contactIds = [...new Set([...waiting.map((c) => c.contact_id), ...visits.map((v) => v.contact_id)].filter((v): v is string => !!v))];
    const { data: contacts } = contactIds.length ? await db.from("contacts").select(CONTACT_COLUMNS).eq("organization_id", scope.organizationId).in("id", contactIds) : { data: [] };
    const byId = new Map(((contacts ?? []) as CareContact[]).map((c) => [c.id, c]));
    const items: string[] = [];
    const unhappy = waiting.filter((c) => c.kind === "complaint");
    if (unhappy.length) {
      const worst = unhappy.slice().sort((a, b) => (a.rating ?? 6) - (b.rating ?? 6))[0];
      const who = customerName(worst.contact_id ? (byId.get(worst.contact_id) ?? null) : null);
      items.push(`${unhappy.length} unhappy customer${unhappy.length === 1 ? "" : "s"} waiting (${who}${worst.rating != null ? ` ${worst.rating}/5` : ""})`);
    }
    const claims = waiting.filter((c) => c.kind === "warranty");
    if (claims.length) {
      const who = customerName(claims[0].contact_id ? (byId.get(claims[0].contact_id) ?? null) : null);
      items.push(claims.length === 1 ? `Warranty question from ${who} waiting on you` : `${claims.length} warranty questions waiting on you`);
    }
    for (const v of visits) {
      const contact = v.contact_id ? (byId.get(v.contact_id) ?? null) : null;
      const who = firstNameOf(contact) ?? customerName(contact);
      items.push(`${kindOf.get(v.id) === "warranty" ? "Warranty" : "Callback"} visit for ${who} today`);
    }
    return items.slice(0, MAX_ITEMS);
  } catch (err) {
    console.error("[customer-care] briefing items failed:", err instanceof Error ? err.message : err);
    return [];
  }
}
