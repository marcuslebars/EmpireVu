/**
 * Fleet's owner-by-text tools (scoped to the ONE company the owner's phone resolved to —
 * state.scope; names from the model are only matched inside it). Record keeping only: nothing
 * here texts a customer or moves money, so there's no approval kind.
 *
 *   fleet_status          vehicles, equipment, rentals, vehicle insurance (Compliance's), what's due
 *   log_odometer          "truck 2 at 84,200" (or an hour meter: "mini-ex at 412 hours")
 *   log_service           "oil change done on truck 2 at 84,200" / "mower serviced"
 *   set_service_schedule  "oil change every 8,000 km or 6 months on truck 2"
 *   add_vehicle           add / update / retire a vehicle (plate sticker, safety, VIN, driver)
 *   add_fleet_equipment   add / update / retire equipment (named so it can't clash with
 *                         installed-equipment tools elsewhere)
 *   add_rental / rental_returned
 *   equipment_out / equipment_back
 *
 * Never throw (return { error }).
 */
import type { ToolRunState } from "@/server/services/owner-channel/tools";
import type { RoleOwnerTool } from "@/server/services/staff/types";
import { zonedInstant } from "@/server/services/booking-windows";
import { addDays, fmtNum, isValidDateString, localDateOf, money, parseClock, prettyDate, shortDate, timeLabel } from "./dates";
import { num, type VehicleRow } from "./db-types";
import { equipmentDue, equipmentLine, nextDueWords, rentalDays, rentalName, serviceDue } from "./due";
import {
  equipmentBack,
  equipmentOut,
  findJob,
  loadCrew,
  loadEquipment,
  loadOpenRentals,
  loadServiceItems,
  loadVehicles,
  logEquipmentHours,
  logEquipmentService,
  logOdometer,
  logVehicleService,
  matchEquipment,
  matchRental,
  matchServiceItem,
  pickByName,
  pickCrew,
  returnRental,
  saveEquipment,
  saveRental,
  saveServiceItem,
  saveVehicle,
  vehicleDescription,
  vehicleNames,
} from "./records";
import { loadFleetCompany, type FleetCompany } from "./settings";
import { fleetStatus } from "./status";

const OFF = "Fleet is off for this business (Settings > AI front desk > Fleet & equipment).";
type Input = Record<string, unknown>;
type Out = Record<string, unknown>;

function str(value: unknown, max = 120): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

/** A number from the model: 84200, "84,200", "84.2k". */
export function number(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const t = value.trim().toLowerCase().replace(/,/g, "").replace(/\s*(km|kms|hours|hrs|h)$/, "");
  const k = /^(\d+(?:\.\d+)?)k$/.exec(t);
  if (k) return Number(k[1]) * 1000;
  return /^\d+(?:\.\d+)?$/.test(t) ? Number(t) : null;
}

const int = (v: unknown) => {
  const n = number(v);
  return n == null ? null : Math.round(n);
};
const cents = (v: unknown) => {
  const n = typeof v === "string" ? number(v.replace(/^\$/, "")) : number(v);
  return n == null ? null : Math.round(n * 100);
};
const date = (v: unknown): string | null | "bad" => (v === undefined || v === null || v === "" ? null : isValidDateString(v) ? v : "bad");

async function companyFor(state: ToolRunState): Promise<FleetCompany | { error: string }> {
  const company = await loadFleetCompany(state.admin, state.scope);
  if (!company) return { error: "Business not found." };
  if (!company.settings.enabled) return { error: OFF };
  return company;
}

function guard(run: (state: ToolRunState, input: Input, company: FleetCompany) => Promise<Out>) {
  return async (state: ToolRunState, input: Input): Promise<Out> => {
    try {
      const company = await companyFor(state);
      if ("error" in company) return company;
      return await run(state, input ?? {}, company);
    } catch (err) {
      console.error("[fleet] owner tool failed:", err instanceof Error ? err.message : err);
      return { error: "Something went wrong - try again in a minute." };
    }
  };
}

/** One vehicle by the owner's words (the only one when there's just one and no words). */
async function vehicleFor(state: ToolRunState, company: FleetCompany, ref: string | null): Promise<VehicleRow | Out> {
  const all = await loadVehicles(state.admin, company);
  if (all.length === 0) return { error: 'No vehicles yet. Add one first, e.g. "add truck 2, 2019 F-150".' };
  if (!ref) return all.length === 1 ? all[0] : { ok: false, ask_owner: `Which vehicle? ${all.map((v) => v.name).join(", ")}` };
  const hits = pickByName(all, ref, vehicleNames);
  if (hits.length === 1) return hits[0];
  if (hits.length === 0) return { error: `No vehicle matches "${ref}". You have: ${all.map((v) => v.name).join(", ")}.` };
  return { ok: false, ask_owner: `Which one? ${hits.map((v) => v.name).join(", ")}` };
}

const isVehicle = (v: unknown): v is VehicleRow => Boolean(v && typeof v === "object" && "odometer_km" in (v as object));

async function equipmentFor(state: ToolRunState, company: FleetCompany, ref: string | null) {
  const all = await loadEquipment(state.admin, company);
  if (!ref) return { out: { error: "Which equipment? Pass its name as `equipment`." } as Out };
  const hits = matchEquipment(all, ref);
  if (hits.length === 1) return { eq: hits[0] };
  if (hits.length === 0) return { out: { error: `No equipment matches "${ref}". You have: ${all.map((e) => e.name).join(", ") || "none yet"}.` } as Out };
  return { out: { ok: false, ask_owner: `Which one? ${hits.map((e) => e.name).join(", ")}` } as Out };
}

// ── Tools ─────────────────────────────────────────────────────────────────────────────

async function statusTool(state: ToolRunState, input: Input, company: FleetCompany): Promise<Out> {
  return fleetStatus(state.admin, company, state.nowMs, str(input.vehicle));
}

async function odometerTool(state: ToolRunState, input: Input, company: FleetCompany): Promise<Out> {
  const eqRef = str(input.equipment);
  if (eqRef) {
    const hours = number(input.hours ?? input.km);
    if (hours == null) return { error: "How many hours? Pass `hours`." };
    const found = await equipmentFor(state, company, eqRef);
    if (!found.eq) return found.out;
    const saved = await logEquipmentHours(state.admin, company, found.eq, hours, state.nowMs, "owner_sms");
    if ("error" in saved) return saved;
    const due = equipmentDue(saved, localDateOf(state.nowMs, company.timeZone));
    return { ok: true, tell_owner: `${found.eq.name}: ${fmtNum(hours)} hours logged.${due.state === "due" || due.state === "overdue" ? ` ${equipmentLine(found.eq.name, due)}.` : ""}` };
  }
  const km = int(input.km);
  if (km == null) return { error: "What's the reading? Pass `km` (a number)." };
  const v = await vehicleFor(state, company, str(input.vehicle));
  if (!isVehicle(v)) return v;
  const logged = await logOdometer(state.admin, company, v, km, state.nowMs, { source: "owner_sms", correct: input.correct === true });
  if ("error" in logged) return logged;
  if ("ask" in logged) return { ok: false, ask_owner: logged.ask };
  if ("duplicate" in logged) return { ok: true, tell_owner: `Already logged.` };
  return { ok: true, tell_owner: `${v.name}: ${fmtNum(km)} km logged.${await nextServiceNote(state, company, logged.vehicle)}` };
}

async function nextServiceNote(state: ToolRunState, company: FleetCompany, v: VehicleRow): Promise<string> {
  const today = localDateOf(state.nowMs, company.timeZone);
  const items = await loadServiceItems(state.admin, company, [v.id]);
  const dues = items.map((i) => ({ i, d: serviceDue(i, v, today, state.nowMs) })).filter((x) => x.d.state !== "unknown");
  if (dues.length === 0) return items.length ? "" : ` Text me a service schedule ("oil change every 8,000 km on ${v.name.toLowerCase()}") to get reminders.`;
  dues.sort((a, b) => (a.d.kmLeft ?? Infinity) - (b.d.kmLeft ?? Infinity) || (a.d.daysLeft ?? Infinity) - (b.d.daysLeft ?? Infinity));
  const { i, d } = dues[0];
  return ` ${i.label} ${nextDueWords(d)}.`;
}

async function serviceTool(state: ToolRunState, input: Input, company: FleetCompany): Promise<Out> {
  const label = str(input.service, 60) ?? (str(input.equipment) ? "service" : null);
  const day = date(input.date);
  if (day === "bad") return { error: "date must be YYYY-MM-DD." };
  const eqRef = str(input.equipment);
  if (eqRef) {
    const found = await equipmentFor(state, company, eqRef);
    if (!found.eq) return found.out;
    const done = await logEquipmentService(state.admin, company, found.eq, { label, hours: number(input.hours), date: day }, state.nowMs, "owner_sms");
    return "error" in done ? done : { ok: true, tell_owner: done.message };
  }
  if (!label) return { error: "Which service (e.g. oil change)? Pass `service`." };
  const v = await vehicleFor(state, company, str(input.vehicle));
  if (!isVehicle(v)) return v;
  const done = await logVehicleService(
    state.admin,
    company,
    v,
    { label, km: int(input.km), date: day, everyKm: input.every_km === undefined ? undefined : int(input.every_km), everyMonths: input.every_months === undefined ? undefined : int(input.every_months) },
    state.nowMs,
    "owner_sms",
  );
  return "error" in done ? done : { ok: true, tell_owner: done.message };
}

async function scheduleTool(state: ToolRunState, input: Input, company: FleetCompany): Promise<Out> {
  const label = str(input.service, 60);
  if (!label) return { error: "Which service (e.g. oil change)? Pass `service`." };
  const v = await vehicleFor(state, company, str(input.vehicle));
  if (!isVehicle(v)) return v;
  const items = await loadServiceItems(state.admin, company, [v.id]);
  const hits = matchServiceItem(items, label);
  if (hits.length > 1) return { ok: false, ask_owner: `Which one? ${hits.map((h) => h.label).join(", ")}` };
  if (input.remove === true) {
    if (!hits[0]) return { error: `${v.name} has no "${label}" schedule.` };
    const saved = await saveServiceItem(state.admin, company, v, { id: hits[0].id, active: false });
    return "error" in saved ? saved : { ok: true, tell_owner: `Stopped the ${hits[0].label.toLowerCase()} reminders for ${v.name}.` };
  }
  const lastOn = date(input.last_done_date);
  if (lastOn === "bad") return { error: "last_done_date must be YYYY-MM-DD." };
  const everyKm = input.every_km === undefined ? undefined : int(input.every_km);
  const everyMonths = input.every_months === undefined ? undefined : int(input.every_months);
  const lastKm = input.last_done_km === undefined ? undefined : int(input.last_done_km);
  const isNew = !hits[0];
  const saved = await saveServiceItem(state.admin, company, v, {
    id: hits[0]?.id,
    label: hits[0] ? undefined : label,
    everyKm,
    everyMonths,
    lastDoneKm: lastKm,
    lastDoneOn: lastOn ?? undefined,
  });
  if ("error" in saved) return saved;
  let item = saved.item;
  // A brand-new schedule with no history starts counting from today's reading / today.
  if (isNew && item.last_done_on == null && item.last_done_km == null) {
    const start = await saveServiceItem(state.admin, company, v, { id: item.id, lastDoneOn: item.every_months ? localDateOf(state.nowMs, company.timeZone) : undefined, lastDoneKm: item.every_km ? v.odometer_km : undefined });
    if (!("error" in start)) item = start.item;
  }
  const every = [item.every_km ? `${fmtNum(item.every_km)} km` : null, item.every_months ? `${item.every_months} months` : null].filter(Boolean).join(" or ");
  const from = item.last_done_on || item.last_done_km != null ? ` Last done: ${[item.last_done_km != null ? `${fmtNum(item.last_done_km)} km` : null, item.last_done_on ? prettyDate(item.last_done_on) : null].filter(Boolean).join(", ")}.` : "";
  const noKm = item.every_km && item.last_done_km == null ? ` Text me the km it was last done at (or the odometer now) so I can count km.` : "";
  return { ok: true, tell_owner: `${v.name} ${item.label.toLowerCase()}: every ${every}.${from}${noKm}` };
}

async function vehicleTool(state: ToolRunState, input: Input, company: FleetCompany): Promise<Out> {
  const name = str(input.name, 60);
  if (!name) return { error: "Pass the vehicle's name (e.g. Truck 2) as `name`." };
  const sticker = date(input.plate_sticker_due);
  const safety = date(input.safety_inspection_due);
  if (sticker === "bad" || safety === "bad") return { error: "Dates must be YYYY-MM-DD." };
  let profileId: string | null | undefined;
  const driver = str(input.driver, 80);
  if (driver) {
    const crew = pickCrew(await loadCrew(state.admin, company.organizationId), driver);
    if (!crew) return { error: `No one called "${driver}" on your team.` };
    profileId = crew.profileId;
  }
  const saved = await saveVehicle(
    state.admin,
    company,
    {
      name,
      year: input.year === undefined ? undefined : int(input.year),
      make: input.make === undefined ? undefined : str(input.make, 40),
      model: input.model === undefined ? undefined : str(input.model, 60),
      plate: input.plate === undefined ? undefined : str(input.plate, 12),
      vin: input.vin === undefined ? undefined : str(input.vin, 20),
      plateStickerDue: sticker ?? undefined,
      safetyInspectionDue: safety ?? undefined,
      safetyInspectionRequired: typeof input.safety_inspection_required === "boolean" ? input.safety_inspection_required : undefined,
      odometerKm: input.odometer_km === undefined ? undefined : int(input.odometer_km),
      profileId,
      notes: input.notes === undefined ? undefined : str(input.notes, 500),
      active: input.retire === true ? false : undefined,
    },
    state.nowMs,
    "owner_sms",
  );
  if ("error" in saved) return saved;
  const v = saved.vehicle;
  if (!v.active) return { ok: true, tell_owner: `${v.name} retired - no more reminders for it.` };
  const desc = vehicleDescription(v);
  const bits: string[] = [];
  if (v.plate_sticker_due) bits.push(`plate sticker ${prettyDate(v.plate_sticker_due)}`);
  if (v.safety_inspection_required && v.safety_inspection_due) bits.push(`safety ${prettyDate(v.safety_inspection_due)}`);
  if (v.odometer_km != null) bits.push(`${fmtNum(v.odometer_km)} km`);
  const remind = bits.length ? ` On file: ${bits.join(", ")}.` : "";
  const next = saved.created && !v.plate_sticker_due ? ` When's the plate sticker due? I'll remind you 30 and 7 days before.` : "";
  const sched = saved.created ? ` Text me a service schedule like "oil change every 8,000 km on ${v.name.toLowerCase()}".` : "";
  return { ok: true, tell_owner: `${saved.created ? "Added" : "Updated"} ${v.name}${desc ? ` (${desc})` : ""}.${remind}${saved.odometerNote ? ` ${saved.odometerNote}` : ""}${next}${sched}` };
}

async function equipmentTool(state: ToolRunState, input: Input, company: FleetCompany): Promise<Out> {
  const name = str(input.name, 60);
  if (!name) return { error: "Pass the equipment's name as `name`." };
  const last = date(input.last_serviced_date);
  if (last === "bad") return { error: "Dates must be YYYY-MM-DD." };
  const saved = await saveEquipment(state.admin, company, {
    name,
    serial: input.serial === undefined ? undefined : str(input.serial, 60),
    valueCents: input.value === undefined ? undefined : cents(input.value),
    location: input.location === undefined ? undefined : str(input.location, 120),
    serviceEveryHours: input.service_every_hours === undefined ? undefined : number(input.service_every_hours),
    serviceEveryMonths: input.service_every_months === undefined ? undefined : int(input.service_every_months),
    lastServicedOn: last ?? undefined,
    hours: input.hours === undefined ? undefined : number(input.hours),
    notes: input.notes === undefined ? undefined : str(input.notes, 500),
    status: input.retire === true ? "retired" : undefined,
  });
  if ("error" in saved) return saved;
  const e = saved.equipment;
  if (e.status === "retired") return { ok: true, tell_owner: `${e.name} retired.` };
  const every = [num(e.service_every_hours) ? `${fmtNum(num(e.service_every_hours) as number)} hours` : null, e.service_every_months ? `${e.service_every_months} months` : null].filter(Boolean).join(" or ");
  return {
    ok: true,
    tell_owner: `${saved.created ? "Added" : "Updated"} ${e.name}${e.serial ? ` (serial ${e.serial})` : ""}${e.value_cents ? `, worth ${money(e.value_cents)}` : ""}.${every ? ` Service every ${every} - I'll remind you.` : saved.created ? " Tell me how often it needs servicing (every N hours or months) for reminders." : ""}`,
  };
}

async function rentalTool(state: ToolRunState, input: Input, company: FleetCompany): Promise<Out> {
  const item = str(input.item, 80);
  if (!item) return { error: "What was rented? Pass `item`." };
  const dueDate = date(input.due_back_date);
  const outDate = date(input.out_date);
  if (dueDate === "bad" || outDate === "bad") return { error: "Dates must be YYYY-MM-DD." };
  const clockRaw = str(input.due_back_time, 20);
  const clock = clockRaw ? parseClock(clockRaw) : null;
  if (clockRaw && !clock) return { error: 'due_back_time like "5pm" or "17:00".' };
  const today = localDateOf(state.nowMs, company.timeZone);
  if (dueDate && dueDate < addDays(today, -1)) return { error: "The due-back date is in the past." };
  const dueBackAtMs = dueDate ? zonedInstant(dueDate, clock ?? "17:00", company.timeZone).getTime() : null;
  const outAtMs = outDate && outDate !== today ? zonedInstant(outDate, "08:00", company.timeZone).getTime() : state.nowMs;
  const jobRef = str(input.job);
  const job = jobRef ? await findJob(state.admin, company, jobRef, state.nowMs) : null;
  if (jobRef && !job) return { error: `No job matches "${jobRef}" (last 2 weeks or next 2 months). Leave job out to save it without one.` };
  const rate = input.rate_per_day === undefined ? undefined : cents(input.rate_per_day);
  const saved = await saveRental(
    state.admin,
    company,
    { item, vendor: str(input.vendor, 80), vendorPhone: str(input.vendor_phone, 30), bookingId: job?.bookingId ?? null, outAtMs, dueBackAtMs, rateCentsPerDay: rate ?? null, notes: str(input.notes, 500) },
    state.nowMs,
    "owner_sms",
  );
  if ("error" in saved) return saved;
  const r = saved.rental;
  const due = r.due_back_at ? ` due back ${shortDate(localDateOf(Date.parse(r.due_back_at), company.timeZone))} ${timeLabel(Date.parse(r.due_back_at), company.timeZone)}${clock ? "" : " (I guessed 5pm - tell me if it's different)"}` : "";
  const remind = r.due_back_at ? " I'll remind you the afternoon before and that morning." : ' No due-back date, so no reminders - tell me when it\'s due back.';
  return { ok: true, tell_owner: `Rental saved: ${rentalName(r)}${job ? ` for ${job.label}` : ""}${due}${r.rate_cents_per_day ? `, ${money(r.rate_cents_per_day)}/day` : ""}.${remind}` };
}

async function returnedTool(state: ToolRunState, input: Input, company: FleetCompany): Promise<Out> {
  const open = await loadOpenRentals(state.admin, company);
  if (open.length === 0) return { error: "No rentals out right now." };
  const ref = str(input.rental);
  const hits = ref ? matchRental(open, ref) : open.length === 1 ? open : [];
  if (hits.length === 0) return { error: ref ? `No open rental matches "${ref}". Out now: ${open.map(rentalName).join(", ")}.` : `Which one? ${open.map(rentalName).join(", ")}` };
  if (hits.length > 1) return { ok: false, ask_owner: `Which one? ${hits.map(rentalName).join(", ")}` };
  const day = date(input.returned_date);
  if (day === "bad") return { error: "returned_date must be YYYY-MM-DD." };
  const today = localDateOf(state.nowMs, company.timeZone);
  const atMs = day && day !== today ? zonedInstant(day, "12:00", company.timeZone).getTime() : state.nowMs;
  const r = hits[0];
  const done = await returnRental(state.admin, company, r, atMs, "owner_sms");
  if (!done) return { ok: true, tell_owner: `${rentalName(r)} was already marked returned.` };
  const days = rentalDays(r.out_at, atMs);
  const cost = days && r.rate_cents_per_day ? ` ${days} ${days === 1 ? "day" : "days"} at ${money(r.rate_cents_per_day)}/day = about ${money(days * r.rate_cents_per_day)}.` : "";
  const late = r.due_back_at && atMs > Date.parse(r.due_back_at) + 3_600_000 ? ` It was due ${shortDate(localDateOf(Date.parse(r.due_back_at), company.timeZone))} - check the bill for late days.` : "";
  return { ok: true, tell_owner: `Marked the ${rentalName(r)} returned (${shortDate(localDateOf(atMs, company.timeZone))}).${cost}${late}` };
}

async function outTool(state: ToolRunState, input: Input, company: FleetCompany): Promise<Out> {
  const found = await equipmentFor(state, company, str(input.equipment));
  if (!found.eq) return found.out;
  const eq = found.eq;
  if (eq.status === "in_shop") return { ok: false, ask_owner: `${eq.name} is marked in the shop. Is it fixed? Say "${eq.name.toLowerCase()} back" first, or log the service.` };
  const jobRef = str(input.job);
  const job = jobRef ? await findJob(state.admin, company, jobRef, state.nowMs) : null;
  if (jobRef && !job) return { error: `No job matches "${jobRef}". Pass location instead (e.g. "Smith site").` };
  let profileId: string | null = null;
  const who = str(input.crew, 80);
  if (who) {
    const crew = pickCrew(await loadCrew(state.admin, company.organizationId), who);
    if (!crew) return { error: `No one called "${who}" on your team.` };
    profileId = crew.profileId;
  }
  const was = eq.status === "out" ? ` (it was already out${eq.location ? ` - ${eq.location}` : ""})` : "";
  const updated = await equipmentOut(state.admin, company, eq, { job, profileId, location: str(input.location) }, state.nowMs, "owner_sms");
  return { ok: true, tell_owner: `${eq.name} out${updated.location ? ` - ${updated.location}` : ""}${who ? ` with ${who}` : ""}.${was}` };
}

async function backTool(state: ToolRunState, input: Input, company: FleetCompany): Promise<Out> {
  const found = await equipmentFor(state, company, str(input.equipment));
  if (!found.eq) return found.out;
  const eq = found.eq;
  const hours = input.hours === undefined ? null : number(input.hours);
  const back = await equipmentBack(state.admin, company, eq, { hours, inShop: input.in_shop === true, location: str(input.location), note: str(input.note, 500) }, state.nowMs, "owner_sms");
  if ("error" in back) return back;
  const due = equipmentDue(back, localDateOf(state.nowMs, company.timeZone));
  const dueNote = due.state === "due" || due.state === "overdue" ? ` ${equipmentLine(eq.name, due)}.` : "";
  return { ok: true, tell_owner: `${eq.name} ${input.in_shop === true ? "in the shop" : "back"}${hours != null ? ` at ${fmtNum(hours)} hours` : ""}.${dueNote}` };
}

export function fleetOwnerTools(): RoleOwnerTool[] {
  return [
    {
      tool: {
        name: "fleet_status",
        description:
          "The business's vehicles (odometer, plate sticker, safety inspection, service schedule and what's due), equipment (in / out / in the shop, service due), rentals out (due back, rate), vehicle insurance as Compliance has it, and what needs attention. Optional `vehicle` (name words) for one vehicle.",
        input_schema: { type: "object", properties: { vehicle: { type: "string" } } },
      },
      run: guard(statusTool),
    },
    {
      tool: {
        name: "log_odometer",
        description:
          'Record an odometer reading: "truck 2 at 84,200" → vehicle "truck 2", km 84200. For equipment with an hour meter ("mini-ex at 412 hours") pass equipment + hours instead. A reading lower than the last one (or a huge jump) comes back as ask_owner; when the owner confirms, call again with correct: true.',
        input_schema: { type: "object", properties: { vehicle: { type: "string" }, km: { type: "number" }, equipment: { type: "string" }, hours: { type: "number" }, correct: { type: "boolean" } } },
      },
      run: guard(odometerTool),
    },
    {
      tool: {
        name: "log_service",
        description:
          'Record maintenance done: "oil change done on truck 2 at 84,200" → vehicle, service "oil change", km. date (YYYY-MM-DD) defaults to today. Matches the vehicle\'s service schedule and resets it; every_km / every_months set the schedule at the same time. For equipment ("mower serviced at 412 hours") pass equipment (+ hours).',
        input_schema: {
          type: "object",
          properties: { vehicle: { type: "string" }, equipment: { type: "string" }, service: { type: "string" }, km: { type: "number" }, hours: { type: "number" }, date: { type: "string" }, every_km: { type: "number" }, every_months: { type: "number" } },
        },
      },
      run: guard(serviceTool),
    },
    {
      tool: {
        name: "set_service_schedule",
        description:
          'Set how often a vehicle needs a service, for reminders: "oil change every 8,000 km or 6 months on truck 2". Optional last_done_km / last_done_date (YYYY-MM-DD). remove: true stops that schedule.',
        input_schema: {
          type: "object",
          properties: { vehicle: { type: "string" }, service: { type: "string" }, every_km: { type: "number" }, every_months: { type: "number" }, last_done_km: { type: "number" }, last_done_date: { type: "string" }, remove: { type: "boolean" } },
          required: ["service"],
        },
      },
      run: guard(scheduleTool),
    },
    {
      tool: {
        name: "add_vehicle",
        description:
          "Add or update a vehicle (matched by name, e.g. \"Truck 2\"): year, make, model, plate, vin, plate_sticker_due (YYYY-MM-DD; Ontario stickers still need renewing), safety_inspection_due (for commercial vehicles that need the annual inspection), odometer_km, driver (crew member's name), notes. retire: true stops tracking it.",
        input_schema: {
          type: "object",
          properties: {
            name: { type: "string" },
            year: { type: "number" },
            make: { type: "string" },
            model: { type: "string" },
            plate: { type: "string" },
            vin: { type: "string" },
            plate_sticker_due: { type: "string" },
            safety_inspection_due: { type: "string" },
            safety_inspection_required: { type: "boolean" },
            odometer_km: { type: "number" },
            driver: { type: "string" },
            notes: { type: "string" },
            retire: { type: "boolean" },
          },
          required: ["name"],
        },
      },
      run: guard(vehicleTool),
    },
    {
      tool: {
        name: "add_fleet_equipment",
        description:
          "Add or update the business's own equipment / tools (matched by name, e.g. \"Mini-ex\", \"Mower 2\"): serial, value (dollars), service_every_hours and/or service_every_months, last_serviced_date (YYYY-MM-DD), hours (meter now), location, notes. retire: true stops tracking it. Not for equipment installed at a customer's.",
        input_schema: {
          type: "object",
          properties: {
            name: { type: "string" },
            serial: { type: "string" },
            value: { type: "number" },
            service_every_hours: { type: "number" },
            service_every_months: { type: "number" },
            last_serviced_date: { type: "string" },
            hours: { type: "number" },
            location: { type: "string" },
            notes: { type: "string" },
            retire: { type: "boolean" },
          },
          required: ["name"],
        },
      },
      run: guard(equipmentTool),
    },
    {
      tool: {
        name: "add_rental",
        description:
          'Record rented equipment: "rented a mini-ex from Sunbelt, $380 a day, back Thursday 5pm, for the Jones job" → item, vendor, rate_per_day (dollars), due_back_date (YYYY-MM-DD), due_back_time ("5pm"), job (customer name). Optional vendor_phone, out_date. Reminders go out the afternoon before and the morning it\'s due.',
        input_schema: {
          type: "object",
          properties: {
            item: { type: "string" },
            vendor: { type: "string" },
            vendor_phone: { type: "string" },
            rate_per_day: { type: "number" },
            due_back_date: { type: "string" },
            due_back_time: { type: "string" },
            out_date: { type: "string" },
            job: { type: "string" },
            notes: { type: "string" },
          },
          required: ["item"],
        },
      },
      run: guard(rentalTool),
    },
    {
      tool: {
        name: "rental_returned",
        description: 'Mark a rental returned: "mini-ex is back" / "returned the Sunbelt rental". rental = item or vendor words; returned_date (YYYY-MM-DD) defaults to now. Replies with the days × rate.',
        input_schema: { type: "object", properties: { rental: { type: "string" }, returned_date: { type: "string" } } },
      },
      run: guard(returnedTool),
    },
    {
      tool: {
        name: "equipment_out",
        description: 'The business\'s equipment goes out: "mini-ex out to the Jones job with Mike" → equipment, job (customer name), crew. Or location ("Smith site").',
        input_schema: { type: "object", properties: { equipment: { type: "string" }, job: { type: "string" }, crew: { type: "string" }, location: { type: "string" } }, required: ["equipment"] },
      },
      run: guard(outTool),
    },
    {
      tool: {
        name: "equipment_back",
        description: 'Equipment is back: "mini-ex back, 412 hours" → equipment, hours (meter). in_shop: true when it went for repair ("mower is in the shop"). Optional note.',
        input_schema: { type: "object", properties: { equipment: { type: "string" }, hours: { type: "number" }, in_shop: { type: "boolean" }, location: { type: "string" }, note: { type: "string" } }, required: ["equipment"] },
      },
      run: guard(backTool),
    },
  ];
}
