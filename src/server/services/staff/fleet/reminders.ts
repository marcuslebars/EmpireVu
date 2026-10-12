/**
 * fleet:reminders (every 15 min) — the owner's fleet heads-up, modelled on the compliance expiry
 * chase: stages, claims, ONE combined owner text, released on failure, 09:00–20:00 local.
 *
 *   What's due     vehicle service by date or by projected km (and "what's the odometer at?" when
 *                  the last reading is > 30 days old); plate sticker and safety inspection 30 / 7
 *                  days before and on the day; equipment service; rentals the afternoon before
 *                  they're due back, the morning of, and every morning while overdue.
 *   Claims         fleet_reminders: one row per (subject, stage key) — the key carries the cycle
 *                  (last service, the due date) so a renewed sticker or a logged service starts
 *                  fresh — taken with a unique insert BEFORE the text and deleted if it fails.
 *   One text a day the day's text is claimed too (`daily:<date>:morning`); a second, afternoon
 *                  text (from 15:00) only carries rentals due back tomorrow / later today. Items
 *                  that become due after the day's text wait for tomorrow's.
 *
 * Only companies with Fleet and its reminders on, active, with a verified owner cell. Fleet rows
 * only exist where Fleet was on, so house orgs are never touched unless they opted in.
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { sendOwnerSms } from "@/server/services/owner-channel/common";
import { localParts } from "./dates";
import type { Db, EquipmentRow, ReminderSubject, RentalRow, ServiceItemRow, VehicleRow } from "./db-types";
import { dateStage, equipmentDue, equipmentLine, lowerFirst, plateLine, projectedKm, rentalLine, rentalStage, safetyLine, serviceDue, serviceLine } from "./due";
import { loadServiceItems } from "./records";
import { loadFleetCompanies, type FleetCompany } from "./settings";

export const SEND_START_HOUR = 9;
export const SEND_END_HOUR = 20;
export const AFTERNOON_HOUR = 15;
const MAX_LINES = 6;
const PAGE = 1000;

export type Slot = "morning" | "afternoon" | "any";

export interface Candidate {
  subjectType: ReminderSubject;
  subjectId: string;
  key: string;
  line: string;
  /** morning: the day's text only; afternoon: needs 15:00+; any: either. */
  slot: Slot;
  /** Lower first. */
  rank: number;
  hint?: string;
}

export interface FleetSnapshot {
  vehicles: VehicleRow[];
  items: ServiceItemRow[];
  equipment: EquipmentRow[];
  rentals: RentalRow[];
}

const quote = (s: string) => `"${s}"`;

/** Everything due for one company right now, with its claim key and line. PURE. */
export function collectCandidates(snapshot: FleetSnapshot, nowMs: number, timeZone: string): Candidate[] {
  const today = localParts(nowMs, timeZone).date;
  const out: Candidate[] = [];
  for (const r of snapshot.rentals) {
    const stage = rentalStage(r, nowMs, timeZone);
    if (!stage) continue;
    const back = quote(`${r.item.trim().toLowerCase()} returned`);
    if (stage.stage === "overdue") out.push({ subjectType: "rental", subjectId: r.id, key: `overdue:${today}`, line: rentalLine(r, stage, timeZone), slot: "morning", rank: 0, hint: `Text me ${back} when it's back.` });
    else if (stage.stage === "day") out.push({ subjectType: "rental", subjectId: r.id, key: `day:${r.due_back_at}`, line: rentalLine(r, stage, timeZone), slot: "any", rank: 1, hint: `Text me ${back} when it's back.` });
    else out.push({ subjectType: "rental", subjectId: r.id, key: `before:${r.due_back_at}`, line: rentalLine(r, stage, timeZone), slot: "afternoon", rank: 2 });
  }
  const itemsBy = new Map<string, ServiceItemRow[]>();
  for (const i of snapshot.items) if (i.active) itemsBy.set(i.vehicle_id, [...(itemsBy.get(i.vehicle_id) ?? []), i]);
  for (const v of snapshot.vehicles) {
    if (!v.active) continue;
    if (v.plate_sticker_due) {
      const stage = dateStage(v.plate_sticker_due, today);
      if (stage !== null) out.push({ subjectType: "vehicle", subjectId: v.id, key: `plate:${v.plate_sticker_due}:${stage}`, line: plateLine(v.name, v.plate_sticker_due, today), slot: "morning", rank: 10 + stage });
    }
    if (v.safety_inspection_required && v.safety_inspection_due) {
      const stage = dateStage(v.safety_inspection_due, today);
      if (stage !== null) out.push({ subjectType: "vehicle", subjectId: v.id, key: `safety:${v.safety_inspection_due}:${stage}`, line: safetyLine(v.name, v.safety_inspection_due, today), slot: "morning", rank: 10 + stage });
    }
    const items = itemsBy.get(v.id) ?? [];
    for (const item of items) {
      const due = serviceDue(item, v, today, nowMs);
      if (due.state !== "due" && due.state !== "overdue") continue;
      const cycle = `${item.last_done_on ?? "-"}/${item.last_done_km ?? "-"}`;
      out.push({
        subjectType: "service_item",
        subjectId: item.id,
        key: `svc:${cycle}:${due.state}`,
        line: serviceLine(v.name, item.label, due),
        slot: "morning",
        rank: due.state === "overdue" ? 5 : 20,
        hint: `Text me ${quote(`${lowerFirst(item.label)} done on ${v.name.toLowerCase()} at`)} and the km when it's done.`,
      });
    }
    // Km-based schedules need readings: ask when the last one is over 30 days old (every 30 days).
    if (items.some((i) => i.every_km && i.last_done_km != null)) {
      const p = projectedKm(v, nowMs);
      const anchorMs = v.odometer_at ? Date.parse(v.odometer_at) : Date.parse(v.created_at);
      const daysOld = Math.floor((nowMs - anchorMs) / 86_400_000);
      if (p.stale && daysOld >= 30) {
        const example = `${v.name.toLowerCase()} at ${(p.km != null ? Math.round(p.km / 100) * 100 : 84_200).toLocaleString("en-CA")}`;
        out.push({ subjectType: "vehicle", subjectId: v.id, key: `odo:${v.odometer_at?.slice(0, 10) ?? "none"}:${Math.floor(daysOld / 30)}`, line: `${v.name}: what's the odometer at? Text me ${quote(example)}`, slot: "morning", rank: 40 });
      }
    }
  }
  for (const e of snapshot.equipment) {
    if (e.status === "retired") continue;
    const due = equipmentDue(e, today);
    if (due.state !== "due" && due.state !== "overdue") continue;
    const cycle = `${e.last_serviced_on ?? "-"}/${e.last_serviced_hours ?? "-"}`;
    out.push({ subjectType: "equipment", subjectId: e.id, key: `eqsvc:${cycle}:${due.state}`, line: equipmentLine(e.name, due), slot: "morning", rank: due.state === "overdue" ? 6 : 21, hint: `Text me ${quote(`${e.name.toLowerCase()} serviced`)} when it's done.` });
  }
  return out.sort((a, b) => a.rank - b.rank || a.line.localeCompare(b.line));
}

/** The one owner text. PURE. */
export function composeText(claimed: Candidate[]): string {
  const shown = claimed.slice(0, MAX_LINES);
  const more = claimed.length > shown.length ? ` (+${claimed.length - shown.length} more - text "fleet" for the list)` : "";
  const hint = claimed.find((c) => c.hint)?.hint;
  return `Fleet heads-up: ${shown.map((c) => c.line).join("; ")}.${more}${hint ? ` ${hint}` : ""}`;
}

async function claim(admin: AdminClient, company: FleetCompany, subjectType: ReminderSubject, subjectId: string, key: string, localDate: string): Promise<string | null> {
  const { data, error } = await (admin as Db)
    .from("fleet_reminders")
    .insert({ organization_id: company.organizationId, company_id: company.companyId, subject_type: subjectType, subject_id: subjectId, reminder_key: key, local_date: localDate })
    .select("id")
    .single();
  if (error) {
    if (error.code === "23505") return null;
    throw error;
  }
  return (data as { id: string }).id;
}

async function release(admin: AdminClient, ids: string[]): Promise<void> {
  if (ids.length) await (admin as Db).from("fleet_reminders").delete().in("id", ids);
}

/** One company's pass. Returns 1 when a text went out. */
export async function remindCompany(admin: AdminClient, company: FleetCompany, snapshot: FleetSnapshot, nowMs: number): Promise<number> {
  if (!company.settings.enabled || !company.settings.reminders || !company.active || !company.ownerPhone) return 0;
  const local = localParts(nowMs, company.timeZone);
  if (local.hour < SEND_START_HOUR || local.hour >= SEND_END_HOUR) return 0;
  const afternoon = local.hour >= AFTERNOON_HOUR;
  const candidates = collectCandidates(snapshot, nowMs, company.timeZone).filter((c) => c.slot !== "afternoon" || afternoon);
  if (candidates.length === 0) return 0;

  let slotId = await claim(admin, company, "company", company.companyId, `daily:${local.date}:morning`, local.date);
  let use = candidates;
  if (!slotId) {
    if (!afternoon) return 0;
    use = candidates.filter((c) => c.slot !== "morning");
    if (use.length === 0) return 0;
    slotId = await claim(admin, company, "company", company.companyId, `daily:${local.date}:afternoon`, local.date);
    if (!slotId) return 0;
  }
  const claimed: Candidate[] = [];
  const ids: string[] = [slotId];
  try {
    for (const c of use) {
      const id = await claim(admin, company, c.subjectType, c.subjectId, c.key, local.date);
      if (!id) continue;
      ids.push(id);
      claimed.push(c);
    }
  } catch (err) {
    await release(admin, ids);
    throw err;
  }
  if (claimed.length === 0) {
    await release(admin, ids);
    return 0;
  }
  const sent = await sendOwnerSms(admin, { to: company.ownerPhone, body: composeText(claimed), organizationId: company.organizationId, companyId: company.companyId, platformBrand: company.platformBrand });
  if (sent.status === "failed") {
    await release(admin, ids);
    return 0;
  }
  return sent.status === "sent" ? 1 : 0;
}

async function paged<T>(admin: AdminClient, table: string, build: (q: Db) => Db): Promise<T[]> {
  const out: T[] = [];
  for (let page = 0; page < 50; page++) {
    const { data, error } = await build((admin as Db).from(table).select("*"))
      .order("id", { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

export async function sweepFleetReminders(admin: AdminClient, nowMs: number): Promise<{ texted: number }> {
  const vehicles = await paged<VehicleRow>(admin, "vehicles", (q) => q.eq("active", true));
  const equipment = await paged<EquipmentRow>(admin, "equipment", (q) => q.in("status", ["available", "out", "in_shop"]));
  // Open rentals due back within 3 days (or already overdue).
  const rentals = await paged<RentalRow>(admin, "rentals", (q) => q.is("returned_at", null).lte("due_back_at", new Date(nowMs + 3 * 86_400_000).toISOString()));
  const companyIds = [...new Set([...vehicles, ...equipment, ...rentals].map((r) => r.company_id))];
  if (companyIds.length === 0) return { texted: 0 };
  const companies = await loadFleetCompanies(admin, companyIds);
  let texted = 0;
  for (const company of companies) {
    if (!company.settings.enabled || !company.settings.reminders || !company.active || !company.ownerPhone) continue;
    try {
      const own = <T extends { company_id: string; organization_id: string }>(rows: T[]) => rows.filter((r) => r.company_id === company.companyId && r.organization_id === company.organizationId);
      const companyVehicles = own(vehicles);
      const items = companyVehicles.length ? await loadServiceItems(admin, company, companyVehicles.map((v) => v.id)) : [];
      texted += await remindCompany(admin, company, { vehicles: companyVehicles, items, equipment: own(equipment), rentals: own(rentals) }, nowMs);
    } catch (err) {
      console.error("[fleet] reminders failed for", company.companyId, err instanceof Error ? err.message : err);
    }
  }
  return { texted };
}
