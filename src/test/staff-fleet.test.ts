/**
 * Fleet & equipment (docs/ai-staff.md → "Fleet & equipment") against the in-memory fake DB with
 * real services underneath (sendOwnerSms → deliverMessage, the owner channel's
 * handleOwnerInboundSms / runOwnerTool, the registry). Only the outside world is faked: Twilio
 * (sendSms), the MMS fetch and the odometer reader.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "@/test/helpers/fake-supabase";

const sendSms = vi.fn((..._a: unknown[]) => Promise.resolve({ sid: `SM${Math.random().toString(36).slice(2, 8)}` }));
const runOwnerCommandAgent = vi.fn((..._a: unknown[]) => Promise.resolve({ reply: "agent reply", actions: [], rounds: 1, confirmationId: null }));
vi.mock("@/server/outbound/sms", () => ({ sendSms: (...a: unknown[]) => sendSms(...a) }));
vi.mock("@/server/outbound/email", () => ({ sendEmail: vi.fn(() => Promise.resolve({ id: "re_1" })) }));
vi.mock("@/server/services/usage", () => ({ recordUsageSafe: vi.fn(), recordAiUsageSafe: vi.fn() }));
vi.mock("@/server/services/push/activity", () => ({ notifyActivityEvent: vi.fn() }));
vi.mock("@/server/services/workflow-engine/dispatch", () => ({ emitActivityEventAndDispatch: vi.fn(() => Promise.resolve({ activityEvent: {}, workflowEventJob: null })) }));
vi.mock("@/server/services/owner-channel/agent", () => ({ runOwnerCommandAgent: (...a: unknown[]) => runOwnerCommandAgent(...a) }));

import { handleOwnerInboundSms } from "@/server/services/owner-channel/entry";
import { runOwnerTool, type ToolRunState } from "@/server/services/owner-channel/tools";
import { activeRolesFor, ownerMediaHandlersFor, roleOwnerTools, runStaffSweeps, resetStaffSweepClock, staffRoles } from "@/server/services/staff/registry";
import { fleetRole } from "@/server/services/staff/fleet";
import { briefingItems } from "@/server/services/staff/fleet/briefing-items";
import { addMonths, daysBetween, parseClock, timeLabel } from "@/server/services/staff/fleet/dates";
import {
  avgKmPerDay,
  dateStage,
  equipmentDue,
  equipmentLine,
  plateLine,
  projectedKm,
  rentalBriefingLine,
  rentalDays,
  rentalLine,
  rentalStage,
  safetyLine,
  serviceDue,
  serviceLine,
} from "@/server/services/staff/fleet/due";
import { cleanOdometerReading, handleFleetMedia, isReadingText, kmInWords, resetFleetMediaDeps, setFleetMediaDeps, vehicleNamedIn, type OdometerReading } from "@/server/services/staff/fleet/media";
import { number } from "@/server/services/staff/fleet/owner-tools";
import { pickByName } from "@/server/services/staff/fleet/records";
import { collectCandidates, composeText, rentalReminderWords, sweepFleetReminders } from "@/server/services/staff/fleet/reminders";
import { fleetActiveFor, mergeFleetSettings, readFleetSettings } from "@/server/services/staff/fleet/settings";
import { getFleetView, runFleetAction } from "@/server/services/staff/fleet/view";
import type { VehicleRow } from "@/server/services/staff/fleet/db-types";

const TZ = "America/Toronto";
const ORG = "11111111-1111-4111-8111-111111111111";
const CO = "22222222-2222-4222-8222-222222222222";
const HOUSE_ORG = "33333333-3333-4333-8333-333333333333";
const HOUSE_CO = "44444444-4444-4444-8444-444444444444";
const OWNER = "+17055559999";
const HOUSE_OWNER = "+17055558888";
const PLATFORM = "+16475550000";
const MIKE = "d0000000-0000-4000-8000-000000000001";
const JONES = "c0000000-0000-4000-8000-000000000001";
const JOB = "b0000000-0000-4000-8000-000000000001";
const TRUCK1 = "a1000000-0000-4000-8000-000000000001";
const TRUCK2 = "a1000000-0000-4000-8000-000000000002";
const OIL = "a2000000-0000-4000-8000-000000000001";
const MINIEX = "a3000000-0000-4000-8000-000000000001";
const RENTAL = "a4000000-0000-4000-8000-000000000001";
const COMPACTOR = "a4000000-0000-4000-8000-000000000002";
const HOUR = 3_600_000;
const DAY = 86_400_000;

// Mon Oct 12 2026, 10:00 in Toronto (EDT, UTC-4).
const NOW = Date.parse("2026-10-12T14:00:00Z");
const PHOTO = [{ url: "https://api.twilio.com/2010-04-01/Accounts/AC1/Messages/MM1/Media/ME1", contentType: "image/jpeg" }];

let db: FakeDb;
let reading: OdometerReading | null;
const readOdometer = vi.fn((_input: unknown) => Promise.resolve(reading));
const fetchImages = vi.fn((_media: unknown) => Promise.resolve([{ mediaType: "image/jpeg" as const, base64: "AAAA", bytes: 3 }]));

function company(over: Record<string, unknown> = {}) {
  return {
    id: CO, organization_id: ORG, name: "Northshore Roofing", brand_from_name: null, timezone: TZ, ai_settings: {}, stage: "active",
    owner_phone_e164: OWNER, owner_phone_verified_at: "2026-10-01T00:00:00Z", owner_email: "dana@northshore.test", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
    ...over,
  };
}

function vehicle(over: Partial<VehicleRow> = {}): VehicleRow & Record<string, unknown> {
  return {
    id: TRUCK1, organization_id: ORG, company_id: CO, name: "Truck 1", year: 2019, make: "Ford", model: "F-150", plate: "ABCD 123", vin: null, profile_id: null,
    odometer_km: null, odometer_at: null, avg_km_per_day: null, plate_sticker_due: null, safety_inspection_required: false, safety_inspection_due: null, notes: null, active: true,
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function seed(): FakeDb {
  return createFakeDb(
    {
      organizations: [
        { id: ORG, platform_brand: "crankleads", name: "Northshore" },
        { id: HOUSE_ORG, platform_brand: "empirevu", name: "A1 Group" },
      ],
      companies: [company(), company({ id: HOUSE_CO, organization_id: HOUSE_ORG, name: "A1 Marine Care", owner_phone_e164: HOUSE_OWNER })],
      organization_memberships: [
        { organization_id: ORG, profile_id: "p-owner", role: "owner" },
        { organization_id: ORG, profile_id: MIKE, role: "member" },
        { organization_id: HOUSE_ORG, profile_id: "p-house", role: "owner" },
      ],
      profiles: [
        { id: "p-owner", full_name: "Dana Whitfield", email: "dana@northshore.test" },
        { id: MIKE, full_name: "Mike Dunn", email: "mike@northshore.test" },
        { id: "p-house", full_name: "Al Marine", email: "al@a1.test" },
      ],
      contacts: [{ id: JONES, organization_id: ORG, company_id: CO, first_name: "Dana", last_name: "Jones", phone: "+17055550123" }],
      bookings: [{ id: JOB, organization_id: ORG, company_id: CO, title: "Roof replacement", contact_id: JONES, scheduled_for: "2026-10-14T13:00:00Z", status: "confirmed" }],
      vehicles: [],
      vehicle_service_items: [],
      equipment: [],
      rentals: [],
      fleet_log: [],
      fleet_reminders: [],
      compliance_documents: [],
      owner_approvals: [],
      owner_command_log: [],
      message_log: [],
      sms_conversations: [],
      platform_sms_opt_outs: [],
    },
    {
      owner_command_log: [["provider_ref"]],
      fleet_reminders: [["company_id", "subject_type", "subject_id", "reminder_key"]],
    },
  );
}

const rows = (table: string) => db.tables[table] as Array<Record<string, unknown>>;
const smsTo = (to: string) => sendSms.mock.calls.map((c) => c[0] as { to: string; body: string; from?: string }).filter((m) => m.to === to);
const ownerTexts = () => smsTo(OWNER).map((m) => m.body);
const scope = { organizationId: ORG, companyId: CO };

function ownerState(nowMs = Date.now()): ToolRunState {
  return { admin: db.client, scope: { organizationId: ORG, companyId: CO, companyName: "Northshore Roofing", timeZone: TZ }, ownerPhone: OWNER, nowMs, confirmation: null, actions: [] };
}
const tool = (name: string, input: Record<string, unknown>, nowMs?: number) => runOwnerTool(ownerState(nowMs), name, input);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  process.env.PLATFORM_SMS_NUMBER = PLATFORM;
  sendSms.mockClear();
  runOwnerCommandAgent.mockClear();
  readOdometer.mockClear();
  fetchImages.mockClear();
  reading = { isOdometer: true, km: 84_200, miles: false };
  db = seed();
  setFleetMediaDeps({ readOdometer, fetchImages });
  resetStaffSweepClock();
});

afterEach(() => {
  vi.useRealTimers();
  resetFleetMediaDeps();
});

// ── Pure parts ───────────────────────────────────────────────────────────────────────

describe("dates and numbers", () => {
  it("months, days, clocks", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2026-10-12", 6)).toBe("2027-04-12");
    expect(daysBetween("2026-10-12", "2026-10-19")).toBe(7);
    expect(daysBetween("2026-10-12", "2026-10-10")).toBe(-2);
    expect(parseClock("5pm")).toBe("17:00");
    expect(parseClock("5:30 pm")).toBe("17:30");
    expect(parseClock("12am")).toBe("00:00");
    expect(parseClock("noon")).toBe("12:00");
    expect(parseClock("17:00")).toBe("17:00");
    expect(parseClock("25:00")).toBeNull();
    expect(timeLabel(Date.parse("2026-10-12T21:00:00Z"), TZ)).toBe("5pm");
    expect(timeLabel(Date.parse("2026-10-12T21:30:00Z"), TZ)).toBe("5:30pm");
    expect(number("84,200")).toBe(84_200);
    expect(number("84.2k")).toBe(84_200);
    expect(number("412 hours")).toBe(412);
    expect(number("lots")).toBeNull();
  });

  it("matches names the way owners type them", () => {
    const vs = [vehicle(), vehicle({ id: TRUCK2, name: "Truck 2", plate: "XYZ 789", model: "Transit", make: "Ford" })];
    const names = (v: VehicleRow) => [v.name, v.plate, v.model];
    expect(pickByName(vs, "truck 2", names).map((v) => v.id)).toEqual([TRUCK2]);
    expect(pickByName(vs, "Truck #2", names).map((v) => v.id)).toEqual([TRUCK2]);
    expect(pickByName(vs, "truck2", names).map((v) => v.id)).toEqual([TRUCK2]);
    expect(pickByName(vs, "the transit", names).map((v) => v.id)).toEqual([TRUCK2]);
    expect(pickByName(vs, "f150", names).map((v) => v.id)).toEqual([TRUCK1]);
    expect(pickByName(vs, "truck", names)).toHaveLength(2);
    expect(pickByName(vs, "truck 3", names)).toHaveLength(0);
  });
});

describe("what's due (pure)", () => {
  it("average km/day from readings, and the projected odometer", () => {
    const at = (d: number) => NOW - d * DAY;
    expect(avgKmPerDay([{ km: 80_000, atMs: at(40) }, { km: 82_000, atMs: at(20) }, { km: 84_000, atMs: at(0) }], NOW)).toBe(100);
    expect(avgKmPerDay([{ km: 80_000, atMs: at(3) }, { km: 80_500, atMs: at(0) }], NOW)).toBeNull(); // < 7 days apart
    expect(avgKmPerDay([{ km: 84_000, atMs: at(20) }, { km: 80_000, atMs: at(0) }], NOW)).toBeNull(); // went backwards
    expect(avgKmPerDay([{ km: 10_000, atMs: at(10) }, { km: 90_000, atMs: at(0) }], NOW)).toBeNull(); // 8,000 km/day: a typo
    const p = projectedKm({ odometer_km: 84_000, odometer_at: new Date(NOW - 10 * DAY).toISOString(), avg_km_per_day: "60" }, NOW);
    expect(p).toEqual({ km: 84_600, stale: false, daysOld: 10 });
    expect(projectedKm({ odometer_km: 84_000, odometer_at: new Date(NOW - 40 * DAY).toISOString(), avg_km_per_day: null }, NOW).stale).toBe(true);
  });

  it("service due by km (projected) and by date; the brief's wording", () => {
    const truck = vehicle({ name: "Truck 2", odometer_km: 84_200, odometer_at: new Date(NOW).toISOString(), avg_km_per_day: 50 });
    const byKm = serviceDue({ every_km: 8_500, every_months: null, last_done_km: 76_100, last_done_on: null }, truck, "2026-10-12", NOW);
    expect(byKm).toMatchObject({ state: "due", reason: "km", kmSince: 8_100, kmLeft: 400 });
    expect(serviceLine("Truck 2", "Oil change", byKm)).toBe("Truck 2 oil change due (about 8,100 km since last)");
    const over = serviceDue({ every_km: 8_000, every_months: null, last_done_km: 76_000, last_done_on: null }, truck, "2026-10-12", NOW);
    expect(over.state).toBe("overdue");
    expect(serviceLine("Truck 2", "Oil change", over)).toBe("Truck 2 oil change overdue (about 8,200 km since last)");
    const ok = serviceDue({ every_km: 8_000, every_months: 6, last_done_km: 80_000, last_done_on: "2026-09-01" }, truck, "2026-10-12", NOW);
    expect(ok.state).toBe("ok");
    const byDate = serviceDue({ every_km: null, every_months: 6, last_done_km: null, last_done_on: "2026-04-15" }, truck, "2026-10-12", NOW);
    expect(byDate).toMatchObject({ state: "due", reason: "date", dueOn: "2026-10-15", daysLeft: 3 });
    expect(serviceLine("Truck 2", "Tire rotation", byDate)).toBe("Truck 2 tire rotation due Oct 15");
    expect(serviceDue({ every_km: 8_000, every_months: null, last_done_km: null, last_done_on: null }, truck, "2026-10-12", NOW).state).toBe("unknown");
    // A stale reading still projects, and says it's a guess.
    const stale = vehicle({ odometer_km: 84_200, odometer_at: new Date(NOW - 45 * DAY).toISOString(), avg_km_per_day: 0 });
    expect(serviceLine("Truck 1", "Oil change", serviceDue({ every_km: 8_500, every_months: null, last_done_km: 76_100, last_done_on: null }, stale, "2026-10-12", NOW))).toContain("a guess - text me the km");
  });

  it("plate sticker and safety stages: 30, 7, the day (caught up 3 days)", () => {
    expect(dateStage("2026-11-11", "2026-10-12")).toBe(30);
    expect(dateStage("2026-11-12", "2026-10-12")).toBeNull();
    expect(dateStage("2026-10-19", "2026-10-12")).toBe(7);
    expect(dateStage("2026-10-12", "2026-10-12")).toBe(0);
    expect(dateStage("2026-10-09", "2026-10-12")).toBe(0);
    expect(dateStage("2026-10-08", "2026-10-12")).toBeNull();
    expect(plateLine("Truck 1", "2026-10-19", "2026-10-12")).toBe("Truck 1 plate sticker expires in 7 days");
    expect(plateLine("Truck 1", "2026-10-12", "2026-10-12")).toBe("Truck 1 plate sticker expires today");
    expect(plateLine("Truck 1", "2026-10-10", "2026-10-12")).toBe("Truck 1 plate sticker expired Oct 10");
    expect(safetyLine("Truck 1", "2026-11-11", "2026-10-12")).toBe("Truck 1 safety inspection due in 30 days");
  });

  it("equipment service by hours and by months", () => {
    const due = equipmentDue({ service_every_hours: "250", service_every_months: null, last_serviced_on: null, last_serviced_hours: "150", hours: "390" }, "2026-10-12");
    expect(due).toMatchObject({ state: "due", reason: "hours", hoursLeft: 10, hoursSince: 240 });
    expect(equipmentLine("Mini-ex", due)).toBe("Mini-ex service due (240 hours since last)");
    const late = equipmentDue({ service_every_hours: null, service_every_months: 12, last_serviced_on: "2025-10-01", last_serviced_hours: null, hours: null }, "2026-10-12");
    expect(equipmentLine("Mower", late)).toBe("Mower service overdue since Oct 1");
  });

  it("rentals: the afternoon before, the morning of, overdue (the brief's wording)", () => {
    const r = { item: "mini-ex", vendor: "Sunbelt", due_back_at: "2026-10-12T21:00:00Z", returned_at: null, rate_cents_per_day: 38_000 };
    const day = rentalStage(r, NOW, TZ)!;
    expect(day).toEqual({ stage: "day" });
    expect(rentalLine(r, day, TZ)).toBe("Rental: Sunbelt mini-ex due back today 5pm - $380/day after");
    expect(rentalBriefingLine(r, day, TZ)).toBe("Rental mini-ex due back today 5pm (Sunbelt)");
    expect(rentalStage(r, NOW - DAY, TZ)).toEqual({ stage: "before" });
    expect(rentalLine(r, { stage: "before" }, TZ)).toBe("Rental: Sunbelt mini-ex due back tomorrow 5pm");
    expect(rentalStage(r, NOW - 2 * DAY, TZ)).toBeNull();
    const late = rentalStage(r, NOW + 2 * DAY, TZ)!;
    expect(late).toEqual({ stage: "overdue", daysLate: 2 });
    expect(rentalLine(r, late, TZ)).toBe("Rental: Sunbelt mini-ex was due back Oct 12 (2 days late, about $760 extra)");
    expect(rentalLine(r, rentalStage(r, NOW + 8 * HOUR, TZ)!, TZ)).toBe("Rental: Sunbelt mini-ex was due back today 5pm - $380/day after");
    expect(rentalStage({ ...r, returned_at: "2026-10-12T15:00:00Z" }, NOW, TZ)).toBeNull();
    expect(rentalDays("2026-10-09T12:00:00Z", Date.parse("2026-10-12T14:00:00Z"))).toBe(3);
    expect(rentalDays("2026-10-12T12:00:00Z", Date.parse("2026-10-12T14:00:00Z"))).toBe(1);
  });
});

// ── Settings, registry, house orgs ─────────────────────────────────────────────────────

describe("settings and the registry", () => {
  it("on by default for CrankLeads, off for house orgs; merge touches only `fleet`", () => {
    expect(readFleetSettings({}, { crankleads: true })).toMatchObject({ enabled: true, reminders: true, enabledIsDefault: true });
    expect(readFleetSettings({}, { crankleads: false })).toMatchObject({ enabled: false, defaultEnabled: false });
    expect(readFleetSettings({ fleet: { enabled: true, reminders: false } }, { crankleads: false })).toMatchObject({ enabled: true, reminders: false });
    expect(mergeFleetSettings({ sms_agent: { x: 1 }, fleet: { reminders: false } }, { enabled: false })).toEqual({ sms_agent: { x: 1 }, fleet: { reminders: false, enabled: false } });
  });

  it("activeFor: CrankLeads yes, A1 no; fleet is last in line for owner photos", async () => {
    expect(await fleetActiveFor(db.client, scope)).toBe(true);
    expect(await fleetActiveFor(db.client, { organizationId: HOUSE_ORG, companyId: HOUSE_CO })).toBe(false);
    expect(await fleetActiveFor(db.client, { organizationId: HOUSE_ORG, companyId: CO })).toBe(false); // not that org's company
    expect((await activeRolesFor(db.client, scope)).some((r) => r.role === "fleet")).toBe(true);
    expect((await activeRolesFor(db.client, { organizationId: HOUSE_ORG, companyId: HOUSE_CO })).some((r) => r.role === "fleet")).toBe(false);
    expect(staffRoles().at(-1)).toBe(fleetRole);
    const handlers = await ownerMediaHandlersFor(db.client, scope);
    expect(handlers.at(-1)?.role).toBe("fleet");
    expect((await ownerMediaHandlersFor(db.client, { organizationId: HOUSE_ORG, companyId: HOUSE_CO })).some((h) => h.role === "fleet")).toBe(false);
    expect(Object.keys(fleetRole.approvalExecutors)).toEqual([]);
    expect(roleOwnerTools().map((t) => t.tool.name)).toEqual(expect.arrayContaining(["fleet_status", "log_odometer", "log_service", "set_service_schedule", "add_vehicle", "add_fleet_equipment", "add_rental", "rental_returned", "equipment_out", "equipment_back"]));
  });

  it("an owner tool for a company with Fleet off says so", async () => {
    db.tables.companies[0].ai_settings = { fleet: { enabled: false } };
    expect(await tool("fleet_status", {})).toEqual({ error: expect.stringContaining("Fleet is off") });
    expect(rows("vehicles")).toHaveLength(0);
  });
});

// ── Owner tools ─────────────────────────────────────────────────────────────────────

describe("owner tools", () => {
  it("add_vehicle → set_service_schedule → log_odometer → log_service → fleet_status", async () => {
    const added = await tool("add_vehicle", { name: "Truck 2", year: 2019, make: "Ford", model: "F-150", plate: "abcd 123", plate_sticker_due: "2027-03-31", odometer_km: 76_100, driver: "Mike" });
    expect(added.tell_owner).toBe('Added Truck 2 (2019 Ford F-150, plate ABCD 123). On file: plate sticker Mar 31, 2027, 76,100 km. Text me a service schedule like "oil change every 8,000 km on truck 2".');
    expect(rows("vehicles")[0]).toMatchObject({ organization_id: ORG, company_id: CO, plate: "ABCD 123", profile_id: MIKE, odometer_km: 76_100 });
    expect(rows("fleet_log")).toEqual([expect.objectContaining({ kind: "odometer", reading: 76_100, vehicle_id: rows("vehicles")[0].id })]);
    // Same name again updates, never duplicates.
    await tool("add_vehicle", { name: "truck 2", vin: "1ftfw1e50kfa12345" });
    expect(rows("vehicles")).toHaveLength(1);
    expect(rows("vehicles")[0].vin).toBe("1FTFW1E50KFA12345");
    expect(await tool("add_vehicle", { name: "Truck 3", driver: "Zed" })).toEqual({ error: 'No one called "Zed" on your team.' });

    const sched = await tool("set_service_schedule", { vehicle: "truck 2", service: "Oil change", every_km: 8000, every_months: 6 });
    expect(sched.tell_owner).toBe("Truck 2 oil change: every 8,000 km or 6 months. Counting from: 76,100 km, Oct 12, 2026.");

    // 30 days later: a reading; then a lower one is questioned, then corrected.
    const later = NOW + 30 * DAY;
    const odo = await tool("log_odometer", { vehicle: "truck 2", km: "83,900" }, later);
    expect(odo.tell_owner).toBe("Truck 2: 83,900 km logged. Oil change due in about 200 km or by Apr 12.");
    expect(rows("vehicles")[0]).toMatchObject({ odometer_km: 83_900, avg_km_per_day: 260 });
    const lower = await tool("log_odometer", { vehicle: "truck 2", km: 38_900 }, later + HOUR);
    expect(lower).toEqual({ ok: false, ask_owner: expect.stringContaining("was at 83,900 km on Nov 11, 2026 - 38,900 is lower") });
    expect((await tool("log_odometer", { vehicle: "truck 2", km: 839_000 }, later + HOUR)).ask_owner).toContain("755,100 km more");
    const fixed = await tool("log_odometer", { vehicle: "truck 2", km: 83_850, correct: true }, later + HOUR);
    expect(fixed.ok).toBe(true);

    const done = await tool("log_service", { vehicle: "truck 2", service: "oil change", km: 84_200 }, later + 2 * HOUR);
    expect(done.tell_owner).toBe("Logged: Truck 2 oil change at 84,200 km (Nov 11, 2026). Next one due in about 8,000 km or by May 11.");
    expect(rows("vehicle_service_items")[0]).toMatchObject({ last_done_km: 84_200, last_done_on: "2026-11-11" });
    expect(rows("vehicles")[0].odometer_km).toBe(84_200);
    // A service with no schedule is still logged, with the offer.
    const wipers = await tool("log_service", { vehicle: "truck 2", service: "wiper blades" }, later + 2 * HOUR);
    expect(wipers.tell_owner).toContain('Want reminders? Text me "wiper blades every 8,000 km on truck 2"');
    expect(rows("fleet_log").filter((l) => l.kind === "service")).toHaveLength(2);

    const status = await tool("fleet_status", {}, later + 3 * HOUR);
    expect(status).toMatchObject({
      ok: true,
      vehicles: [expect.objectContaining({ name: "Truck 2", driver: "Mike Dunn", plate_sticker: "expires Mar 31, 2027", services: ["Oil change (every 8,000 km / every 6 mo): due in about 8,000 km or by May 11"] })],
      vehicle_insurance: expect.stringContaining("none on file"),
    });
  });

  it("one vehicle: no name needed; unknown names list what they have", async () => {
    db.tables.vehicles.push(vehicle());
    expect((await tool("log_odometer", { km: 50_000 })).tell_owner).toContain("Truck 1: 50,000 km logged.");
    expect(await tool("log_odometer", { vehicle: "the van", km: 50_100 })).toEqual({ error: 'No vehicle matches "the van". You have: Truck 1.' });
  });

  it("equipment: add, out to a job with crew, back with hours, serviced; hour meter readings", async () => {
    const added = await tool("add_fleet_equipment", { name: "Mini-ex", serial: "KX040-1234", value: 42000, service_every_hours: 250, hours: 150 });
    expect(added.tell_owner).toBe("Added Mini-ex (serial KX040-1234), worth $42,000. Service every 250 hours - I'll remind you.");
    expect(rows("equipment")[0]).toMatchObject({ last_serviced_hours: 150, value_cents: 4_200_000, status: "available" });
    const out = await tool("equipment_out", { equipment: "mini ex", job: "Jones", crew: "Mike" });
    expect(out.tell_owner).toBe("Mini-ex out - Jones job with Mike.");
    expect(rows("equipment")[0]).toMatchObject({ status: "out", booking_id: JOB, out_profile_id: MIKE });
    const back = await tool("equipment_back", { equipment: "mini-ex", hours: 392 });
    expect(back.tell_owner).toBe("Mini-ex back at 392 hours. Mini-ex service due (242 hours since last).");
    expect(rows("equipment")[0]).toMatchObject({ status: "available", booking_id: null, hours: 392 });
    const svc = await tool("log_service", { equipment: "mini-ex", hours: 395 });
    expect(svc.tell_owner).toBe("Logged: Mini-ex service at 395 hours (Oct 12, 2026). Next service due in 250 hours.");
    const meter = await tool("log_odometer", { equipment: "mini-ex", hours: 400 });
    expect(meter.tell_owner).toBe("Mini-ex: 400 hours logged.");
    expect(rows("fleet_log").map((l) => l.kind)).toEqual(["check_out", "check_in", "service", "hours"]);
    expect(await tool("equipment_out", { equipment: "mini-ex", job: "Nobody" })).toEqual({ error: expect.stringContaining('No job matches "Nobody"') });
  });

  it("rentals: add (5pm guessed), returned with the cost", async () => {
    const added = await tool("add_rental", { item: "mini-ex", vendor: "Sunbelt", vendor_phone: "705-555-0100", rate_per_day: 380, due_back_date: "2026-10-14", job: "Jones" });
    expect(added.tell_owner).toBe("Rental saved: Sunbelt mini-ex for Jones due back Oct 14 5pm (I guessed 5pm - tell me if it's different), $380/day. I'll remind you the afternoon before and that morning. If it's late I'll remind you each morning until it's back.");
    expect(rows("rentals")[0]).toMatchObject({ vendor_phone: "+17055550100", booking_id: JOB, due_back_at: "2026-10-14T21:00:00.000Z", rate_cents_per_day: 38_000, created_via: "owner_sms" });
    await tool("add_rental", { item: "plate compactor", vendor: "Wacker", due_back_date: "2026-10-13", due_back_time: "8am" });
    expect(await tool("rental_returned", {})).toEqual({ error: "Which one? Wacker plate compactor, Sunbelt mini-ex" });
    const back = await tool("rental_returned", { rental: "sunbelt" }, NOW + 3 * DAY);
    expect(back.tell_owner).toBe("Marked the Sunbelt mini-ex returned (Oct 15). 3 days at $380/day = about $1,140. It was due Oct 14 - check the bill for late days.");
    expect((await tool("rental_returned", { rental: "sunbelt" })).error).toContain("No open rental matches");
    expect(rows("fleet_log").map((l) => l.kind)).toEqual(["rental_out", "rental_out", "rental_returned"]);
  });
});

// ── The reminder sweep ─────────────────────────────────────────────────────────────────

function seedFleet() {
  db.tables.vehicles.push(
    vehicle({ plate_sticker_due: "2026-10-19" }),
    vehicle({ id: TRUCK2, name: "Truck 2", plate: "XYZ 789", odometer_km: 84_200, odometer_at: new Date(NOW - DAY).toISOString(), avg_km_per_day: 0 }),
  );
  db.tables.vehicle_service_items.push({ id: OIL, organization_id: ORG, company_id: CO, vehicle_id: TRUCK2, label: "Oil change", every_km: 8_500, every_months: null, last_done_km: 76_100, last_done_on: "2026-05-01", active: true, notes: null });
  db.tables.rentals.push(
    { id: RENTAL, organization_id: ORG, company_id: CO, item: "mini-ex", vendor: "Sunbelt", due_back_at: "2026-10-12T21:00:00Z", rate_cents_per_day: 38_000, returned_at: null, out_at: "2026-10-09T12:00:00Z" },
    { id: COMPACTOR, organization_id: ORG, company_id: CO, item: "plate compactor", vendor: "Wacker", due_back_at: "2026-10-13T12:00:00Z", rate_cents_per_day: null, returned_at: null, out_at: "2026-10-11T12:00:00Z" },
  );
  // A1 has a vehicle with a sticker due too, but Fleet is off there.
  db.tables.vehicles.push(vehicle({ id: "a1000000-0000-4000-8000-0000000000aa", organization_id: HOUSE_ORG, company_id: HOUSE_CO, name: "Boat trailer", plate_sticker_due: "2026-10-19" }));
}

describe("fleet:reminders", () => {
  it("one combined morning text, nothing twice, an afternoon text for tomorrow's rentals, overdue every morning", async () => {
    seedFleet();
    await sweepFleetReminders(db.client, NOW);
    expect(ownerTexts()).toEqual([
      'CrankLeads: Fleet heads-up: Rental: Sunbelt mini-ex due back today 5pm - $380/day after; Truck 1 plate sticker expires in 7 days; Truck 2 oil change due (about 8,100 km since last). Text me "mini-ex returned" when it\'s back.',
    ]);
    expect(smsTo(OWNER)[0].from).toBe(PLATFORM);
    expect(smsTo(HOUSE_OWNER)).toHaveLength(0);
    expect(rows("fleet_reminders").map((r) => r.reminder_key)).toEqual(["daily:2026-10-12:morning", "day:2026-10-12T21:00:00Z", "plate:2026-10-19:7", "svc:2026-05-01/76100:due"]);

    await sweepFleetReminders(db.client, NOW + 15 * 60_000);
    expect(ownerTexts()).toHaveLength(1);

    // 15:30: the compactor due back tomorrow 8am gets the afternoon text.
    await sweepFleetReminders(db.client, NOW + 5.5 * HOUR);
    expect(ownerTexts().at(-1)).toBe("CrankLeads: Fleet heads-up: Rental: Wacker plate compactor due back tomorrow 8am.");
    await sweepFleetReminders(db.client, NOW + 6 * HOUR);
    expect(ownerTexts()).toHaveLength(2);

    // Next morning: both rentals overdue (the mini-ex by a day); nothing already said is repeated.
    await sweepFleetReminders(db.client, NOW + DAY);
    expect(ownerTexts().at(-1)).toBe(
      'CrankLeads: Fleet heads-up: Rental: Sunbelt mini-ex was due back Oct 12 (1 day late, about $380 extra); Rental: Wacker plate compactor was due back today 8am. Text me "mini-ex returned" when it\'s back.',
    );
    // Returned → no more.
    db.tables.rentals.forEach((r) => (r.returned_at = new Date(NOW + DAY).toISOString()));
    await sweepFleetReminders(db.client, NOW + 2 * DAY);
    expect(ownerTexts()).toHaveLength(3);
  });

  it("only 09:00–20:00 local, only with reminders on and a verified cell", async () => {
    seedFleet();
    await sweepFleetReminders(db.client, Date.parse("2026-10-12T12:30:00Z")); // 8:30am
    await sweepFleetReminders(db.client, Date.parse("2026-10-13T00:30:00Z")); // 8:30pm
    expect(sendSms).not.toHaveBeenCalled();
    db.tables.companies[0].ai_settings = { fleet: { reminders: false } };
    await sweepFleetReminders(db.client, NOW);
    db.tables.companies[0].ai_settings = {};
    db.tables.companies[0].owner_phone_verified_at = null;
    await sweepFleetReminders(db.client, NOW);
    expect(sendSms).not.toHaveBeenCalled();
    expect(rows("fleet_reminders")).toHaveLength(0);
  });

  it("A1 opted in gets its own text; a house org left alone gets nothing", async () => {
    seedFleet();
    db.tables.companies[1].ai_settings = { fleet: { enabled: true } };
    await sweepFleetReminders(db.client, NOW);
    expect(smsTo(HOUSE_OWNER).map((m) => m.body)).toEqual(["Fleet heads-up: Boat trailer plate sticker expires in 7 days."]);
  });

  it("a failed text gives every claim back, and the next sweep sends it", async () => {
    seedFleet();
    sendSms.mockImplementationOnce(() => Promise.reject(new Error("twilio down")));
    await sweepFleetReminders(db.client, NOW);
    expect(rows("fleet_reminders")).toHaveLength(0);
    await sweepFleetReminders(db.client, NOW + 15 * 60_000);
    expect(ownerTexts()).toHaveLength(2);
    expect(ownerTexts().at(-1)).toContain("Truck 1 plate sticker expires in 7 days");
  });

  it("asks for an odometer reading when the last one is over 30 days old (once per 30 days)", async () => {
    db.tables.vehicles.push(vehicle({ odometer_km: 60_000, odometer_at: "2026-08-20T12:00:00Z", avg_km_per_day: 0 }));
    db.tables.vehicle_service_items.push({ id: OIL, organization_id: ORG, company_id: CO, vehicle_id: TRUCK1, label: "Oil change", every_km: 8_000, every_months: null, last_done_km: 58_000, last_done_on: null, active: true });
    await sweepFleetReminders(db.client, NOW);
    expect(ownerTexts()).toEqual(['CrankLeads: Fleet heads-up: Truck 1: what\'s the odometer at? Text me "truck 1 at 60,000".']);
    await sweepFleetReminders(db.client, NOW + DAY);
    expect(ownerTexts()).toHaveLength(1);
  });

  it("runs through runStaffSweeps and caps the text at 6 lines", async () => {
    for (let i = 0; i < 8; i++) db.tables.vehicles.push(vehicle({ id: `a1000000-0000-4000-8000-00000000010${i}`, name: `Truck ${i + 3}`, plate_sticker_due: "2026-10-19" }));
    await runStaffSweeps(db.client, NOW);
    expect(ownerTexts().find((t) => t.includes("Fleet heads-up"))).toContain('(+2 more - text "fleet" for the list)');
    const candidates = collectCandidates({ vehicles: db.tables.vehicles as never, items: [], equipment: [], rentals: [] }, NOW, TZ);
    expect(composeText(candidates.slice(0, 1))).toBe("Fleet heads-up: Truck 10 plate sticker expires in 7 days.");
  });
});

// ── The odometer photo (ownerMedia) ───────────────────────────────────────────────────

describe("odometer photos", () => {
  let sid = 0;
  const text = (from: string, body: string, media = PHOTO) => handleOwnerInboundSms(db.client, { from, to: PLATFORM, body, media, providerRef: `SMf${++sid}`, viaPlatformNumber: true, companyId: null });

  beforeEach(() => {
    // The other roles' media fetches (tax clerk, compliance) must never reach the network here.
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("no network in tests"))));
    db.tables.vehicles.push(vehicle(), vehicle({ id: TRUCK2, name: "Truck 2", plate: "XYZ 789", odometer_km: 80_000, odometer_at: "2026-09-12T12:00:00Z" }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("pure parts: which vehicle, a number in the words, the reader's answer", () => {
    const vs = db.tables.vehicles as unknown as VehicleRow[];
    expect(vehicleNamedIn("truck 2 km", vs)?.id).toBe(TRUCK2);
    expect(vehicleNamedIn("TRUCK #2 odometer", vs)?.id).toBe(TRUCK2);
    expect(vehicleNamedIn("truck km", vs)).toBeNull();
    expect(vehicleNamedIn("xyz 789 km", vs)?.id).toBe(TRUCK2);
    expect(kmInWords("truck 2 at 84,200 km", vs[1])).toBe(84_200);
    expect(kmInWords("truck 2 84200km", vs[1])).toBe(84_200);
    expect(kmInWords("truck 2 84.2k", vs[1])).toBe(84_200);
    expect(kmInWords("truck 2 km", vs[1])).toBeNull();
    expect(kmInWords("truck 2 84,200 or 85,000 km", vs[1])).toBeNull();
    expect(cleanOdometerReading({ is_odometer: true, reading: 84_213, unit: "km" })).toEqual({ isOdometer: true, km: 84_213, miles: false });
    expect(cleanOdometerReading({ is_odometer: true, reading: "84,213", unit: "mi" })).toEqual({ isOdometer: true, km: 84_213, miles: true });
    expect(cleanOdometerReading({ is_odometer: true, reading: 1.5 })).toEqual({ isOdometer: true, km: null, miles: false });
    expect(cleanOdometerReading({ is_odometer: false, reading: 5 })).toEqual({ isOdometer: false, km: null, miles: false });
    expect(cleanOdometerReading("nope")).toBeNull();
  });

  it("'truck 2 km' + photo → read off the photo and logged; the agent never runs", async () => {
    await text(OWNER, "truck 2 km");
    expect(ownerTexts().at(-1)).toBe("CrankLeads: Truck 2: 84,200 km logged (read off the photo - tell me if it's wrong).");
    expect(smsTo(OWNER).at(-1)?.from).toBe(PLATFORM);
    expect(rows("owner_command_log").at(-1)).toMatchObject({ intent: "fleet_odometer" });
    expect(rows("fleet_log")).toEqual([expect.objectContaining({ vehicle_id: TRUCK2, kind: "odometer", reading: 84_200, source: "owner_photo", source_key: `sms:${rows("owner_command_log").at(-1)?.id}` })]);
    expect(rows("vehicles")[1].odometer_km).toBe(84_200);
    expect(runOwnerCommandAgent).not.toHaveBeenCalled();
  });

  it("a number in the words wins and the photo isn't read", async () => {
    await text(OWNER, "truck 2 odometer 84,350");
    expect(ownerTexts().at(-1)).toBe("CrankLeads: Truck 2: 84,350 km logged.");
    expect(readOdometer).not.toHaveBeenCalled();
  });

  it("unreadable photo: claimed (the words were clear) but nothing logged", async () => {
    reading = { isOdometer: true, km: null, miles: false };
    await text(OWNER, "truck 2 km");
    expect(ownerTexts().at(-1)).toBe('CrankLeads: Got the photo for Truck 2, but I couldn\'t read the odometer - text me the km like "truck 2 at 84,200".');
    expect(rows("fleet_log")).toHaveLength(0);
  });

  it("not claimed: a bare photo, a fuel receipt, no vehicle named, words without km — old behaviour", async () => {
    await text(OWNER, "");
    expect(ownerTexts().at(-1)).toContain("Got the picture");
    await text(OWNER, "gas for truck 2 84,200 km");
    await text(OWNER, "the truck is at the shop");
    await text(OWNER, "truck 2 needs tires");
    expect(runOwnerCommandAgent).toHaveBeenCalledTimes(3);
    expect(readOdometer).not.toHaveBeenCalled();
    expect(rows("fleet_log")).toHaveLength(0);
  });

  it("A1 Marine Care (house org): exactly as before", async () => {
    db.tables.vehicles.push(vehicle({ id: "a1000000-0000-4000-8000-0000000000aa", organization_id: HOUSE_ORG, company_id: HOUSE_CO, name: "Truck 2" }));
    await text(HOUSE_OWNER, "truck 2 km");
    expect(runOwnerCommandAgent).toHaveBeenCalledTimes(1);
    expect(readOdometer).not.toHaveBeenCalled();
    expect(rows("fleet_log")).toHaveLength(0);
    await text(HOUSE_OWNER, "");
    expect(smsTo(HOUSE_OWNER).at(-1)?.body).toContain("Got the picture");
  });

  it("idempotent on the log id; a lower reading is questioned; never throws", async () => {
    const input = { scope: { organizationId: ORG, companyId: CO, companyName: "Northshore Roofing", timeZone: TZ }, ownerPhone: OWNER, body: "truck 2 km", media: PHOTO, logId: "log-9", nowMs: NOW };
    expect((await handleFleetMedia(db.client, input))?.reply).toContain("84,200 km logged");
    expect((await handleFleetMedia(db.client, input))?.reply).toBe("Got it - Truck 2 is already logged.");
    reading = { isOdometer: true, km: 70_000, miles: false };
    expect((await handleFleetMedia(db.client, { ...input, logId: "log-10" }))?.reply).toContain("70,000 is lower");
    db.failNext("vehicles", "select");
    expect(await fleetRole.ownerMedia!.run(db.client, { ...input, logId: "log-11" })).toBeNull();
  });
});

// ── Briefing items, Settings view ──────────────────────────────────────────────────────

describe("briefing items", () => {
  it("the brief's lines, most urgent first; [] for house orgs, Fleet off, or a failed read", async () => {
    seedFleet();
    expect(await briefingItems(db.client, scope, "2026-10-12")).toEqual(["Rental mini-ex due back today 5pm (Sunbelt)", "Truck 1 plate sticker expires in 7 days", "Truck 2 oil change due (about 8,100 km since last)"]);
    expect(await briefingItems(db.client, scope, "2026-10-13")).toEqual([
      "Rental mini-ex overdue since Oct 12 (Sunbelt)",
      "Rental plate compactor due back today 8am (Wacker)",
      "Truck 1 plate sticker expires in 6 days",
      "Truck 2 oil change due (about 8,100 km since last)",
    ]);
    expect(await briefingItems(db.client, { organizationId: HOUSE_ORG, companyId: HOUSE_CO }, "2026-10-12")).toEqual([]);
    db.failNext("vehicles", "select");
    expect(await briefingItems(db.client, scope, "2026-10-12")).toEqual([]);
    db.tables.companies[0].ai_settings = { fleet: { enabled: false } };
    expect(await briefingItems(db.client, scope, "2026-10-12")).toEqual([]);
    expect(await briefingItems(db.client, scope, "not-a-date")).toEqual([]);
  });
});

describe("Settings view and actions", () => {
  it("shows vehicles, schedules, equipment, rentals and Compliance's vehicle insurance; actions write scoped rows", async () => {
    seedFleet();
    db.tables.compliance_documents.push({ organization_id: ORG, company_id: CO, kind: "vehicle_insurance", issuer: "Intact", title: null, expires_on: "2027-03-31", status: "current" });
    const view = (await getFleetView(db.client, scope, { manager: true }, NOW))!;
    expect(view.vehicles.map((v) => [v.name, v.plateTone])).toEqual([["Truck 1", "soon"], ["Truck 2", null]]);
    expect(view.vehicles[1].services[0]).toMatchObject({ label: "Oil change", tone: "soon", words: "Oil change (every 8,500 km): due in about 400 km" });
    expect(view.vehicleInsurance).toEqual([{ issuer: "Intact", title: null, expiresOn: "2027-03-31", status: "current" }]);
    expect(view.rentals.map((r) => r.tone)).toEqual(["soon", "soon"]);
    expect(view.attention).toHaveLength(4);

    expect(await runFleetAction(db.client, scope, { action: "save_vehicle", vehicle: { name: "Trailer", plateStickerDue: "2027-05-31" } }, NOW)).toEqual({ ok: true });
    expect(await runFleetAction(db.client, scope, { action: "save_vehicle", vehicle: { name: "Trailer 2", plateStickerDue: "May 31" } }, NOW)).toEqual({ error: "The plate sticker date must be a date like 2027-03-31." });
    expect(await runFleetAction(db.client, scope, { action: "save_service_item", vehicleId: TRUCK1, item: { label: "Tires", everyMonths: 6, lastDoneOn: "2026-05-01" } }, NOW)).toEqual({ ok: true });
    expect(await runFleetAction(db.client, scope, { action: "save_service_item", vehicleId: TRUCK1, item: { label: "Brakes" } }, NOW)).toEqual({ error: "How often? Give every N km and/or every N months." });
    expect(await runFleetAction(db.client, scope, { action: "service_done", vehicleId: TRUCK2, label: "Oil change" }, NOW)).toEqual({ ok: true });
    expect(db.tables.vehicle_service_items.find((i) => i.id === OIL)).toMatchObject({ last_done_on: "2026-10-12", last_done_km: 84_200 });
    expect(await runFleetAction(db.client, scope, { action: "save_equipment", equipment: { name: "Mower", serviceEveryMonths: 12, lastServicedOn: "2025-10-01" } }, NOW)).toEqual({ ok: true });
    const mower = db.tables.equipment[0];
    expect(await runFleetAction(db.client, scope, { action: "equipment_status", equipmentId: mower.id as string, status: "in_shop" }, NOW)).toEqual({ ok: true });
    expect(mower.status).toBe("in_shop");
    expect(await runFleetAction(db.client, scope, { action: "save_rental", rental: { item: "Lift", vendor: "Sunbelt", dueBackLocal: "2026-10-15T17:00", rateCentsPerDay: 25_000 } }, NOW)).toEqual({ ok: true });
    expect(db.tables.rentals.at(-1)).toMatchObject({ due_back_at: "2026-10-15T21:00:00.000Z", created_via: "settings", organization_id: ORG, company_id: CO });
    expect(await runFleetAction(db.client, scope, { action: "save_rental", rental: { item: "Lift", dueBackLocal: "tomorrow" } }, NOW)).toEqual({ error: "The due-back time looks off." });
    expect(await runFleetAction(db.client, scope, { action: "return_rental", rentalId: RENTAL }, NOW)).toEqual({ ok: true });
    expect(await runFleetAction(db.client, scope, { action: "return_rental", rentalId: RENTAL }, NOW)).toEqual({ error: "That rental isn't out." });
    // Another org's company: nothing.
    expect(await runFleetAction(db.client, { organizationId: HOUSE_ORG, companyId: CO }, { action: "return_rental", rentalId: COMPACTOR }, NOW)).toBeNull();
    expect(db.tables.rentals.find((r) => r.id === COMPACTOR)?.returned_at).toBeNull();
  });
});

// ── Review fixes ─────────────────────────────────────────────────────────────────────

describe("review: the odometer photo only claims readings", () => {
  let sid = 100;
  const text = (from: string, body: string) => handleOwnerInboundSms(db.client, { from, to: PLATFORM, body, media: PHOTO, providerRef: `SMr${++sid}`, viaPlatformNumber: true, companyId: null });

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("no network in tests"))));
    db.tables.vehicles.push(vehicle(), vehicle({ id: TRUCK2, name: "Truck 2", plate: "XYZ 789", odometer_km: 80_000, odometer_at: "2026-09-12T12:00:00Z" }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("the words decide: readings yes; stickers, services, flats and the like no", () => {
    const t2 = db.tables.vehicles[1] as unknown as VehicleRow;
    for (const yes of ["truck 2 km", "truck 2 odometer", "truck 2 at 84,200", "truck 2 odo 84,200", "truck 2 84,200 km on it", "truck 2 reads 84200", "here's truck 2's odometer"]) expect([yes, isReadingText(yes, t2)]).toEqual([yes, true]);
    for (const no of ["truck 2 next oil change at 92,000 km", "oil change done on truck 2 at 84,200 km", "photo of truck 2, flat tire 5 km from the Smith job", "truck 2 brakes at 84,200 km", "truck 2 sticker", "truck 2 accident damage", "truck 2 inspection due at 90,000 km", "truck 2 looking good"])
      expect([no, isReadingText(no, t2)]).toEqual([no, false]);
  });

  it("a service sticker photo ('next oil change at 92,000 km') is not logged as a reading", async () => {
    await text(OWNER, "truck 2 next oil change at 92,000 km");
    expect(rows("fleet_log")).toHaveLength(0);
    expect(runOwnerCommandAgent).toHaveBeenCalledTimes(1);
  });

  it("'oil change done on truck 2 at 84,200 km' with a photo reaches the owner agent (log_service runs there)", async () => {
    await text(OWNER, "oil change done on truck 2 at 84,200 km");
    expect(runOwnerCommandAgent).toHaveBeenCalledTimes(1);
    expect(String((runOwnerCommandAgent.mock.calls[0] as unknown[])[1] ?? JSON.stringify(runOwnerCommandAgent.mock.calls[0]))).toContain("oil change done on truck 2");
    expect(rows("fleet_log")).toHaveLength(0);
    expect(readOdometer).not.toHaveBeenCalled();
  });

  it("'photo of the truck, flat tire 5 km from the Smith job' is not claimed", async () => {
    await text(OWNER, "photo of truck 2, flat tire 5 km from the Smith job");
    expect(runOwnerCommandAgent).toHaveBeenCalledTimes(1);
    expect(rows("fleet_log")).toHaveLength(0);
  });

  it("the reader says it isn't an odometer → not claimed (the words go to the agent)", async () => {
    reading = { isOdometer: false, km: null, miles: false };
    await text(OWNER, "truck 2 km");
    expect(readOdometer).toHaveBeenCalledTimes(1);
    expect(runOwnerCommandAgent).toHaveBeenCalledTimes(1); // words with a photo nobody claims go to the agent, as before
    expect(rows("fleet_log")).toHaveLength(0);
  });

  it("an owner with two businesses is told which one got the reading", async () => {
    db.tables.companies.push(company({ id: "55555555-5555-4555-8555-555555555555", name: "Northshore Landscaping" }));
    const input = { scope: { organizationId: ORG, companyId: CO, companyName: "Northshore Roofing", timeZone: TZ }, ownerPhone: OWNER, body: "truck 2 at 84,200", media: PHOTO, logId: "log-two", nowMs: NOW };
    expect((await handleFleetMedia(db.client, input))?.reply).toBe("Northshore Roofing: Truck 2: 84,200 km logged.");
  });
});

describe("review: readings, schedules, retired vehicles, Settings", () => {
  it("a new km schedule counts from the PROJECTED km and asks for a reading when the last one is stale", async () => {
    db.tables.vehicles.push(vehicle({ id: TRUCK2, name: "Truck 2", odometer_km: 80_000, odometer_at: new Date(NOW - 40 * DAY).toISOString(), avg_km_per_day: 50 }));
    const out = await tool("set_service_schedule", { vehicle: "truck 2", service: "oil change", every_km: 8000 });
    expect(rows("vehicle_service_items")[0].last_done_km).toBe(82_000);
    expect(out.tell_owner).toBe('Truck 2 oil change: every 8,000 km. Counting from: about 82,000 km. Your last reading is over 30 days old - what\'s the odometer at now? Text me "truck 2 at 82,000".');
  });

  it("no reading at all: the schedule waits for one, the sweep asks, and the first reading starts the count", async () => {
    db.tables.vehicles.push(vehicle({ id: TRUCK2, name: "Truck 2" }));
    const out = await tool("set_service_schedule", { vehicle: "truck 2", service: "oil change", every_km: 8000 });
    expect(out.tell_owner).toContain("What's the odometer at now?");
    await sweepFleetReminders(db.client, NOW);
    expect(ownerTexts().at(-1)).toContain("Truck 2: what's the odometer at?");
    await tool("log_odometer", { vehicle: "truck 2", km: 84_200 });
    expect(rows("vehicle_service_items")[0].last_done_km).toBe(84_200);
  });

  it("a reading never wipes a good average; a correction below every reading does", async () => {
    db.tables.vehicles.push(vehicle({ id: TRUCK2, name: "Truck 2", odometer_km: 80_000, odometer_at: new Date(NOW - 400 * DAY).toISOString(), avg_km_per_day: 55 }));
    await tool("log_odometer", { vehicle: "truck 2", km: 84_200 });
    expect(rows("vehicles")[0].avg_km_per_day).toBe(55);
    await tool("log_odometer", { vehicle: "truck 2", km: 70_000, correct: true }, NOW + HOUR);
    expect(rows("vehicles")[0].avg_km_per_day).toBeNull();
  });

  it("a lower hour-meter reading is asked about; a rental can't be due before it went out", async () => {
    await tool("add_fleet_equipment", { name: "Mini-ex", hours: 400 });
    expect((await tool("log_odometer", { equipment: "mini-ex", hours: 300 })).ask_owner).toContain("hour meter was at 400 - 300 is lower");
    expect((await tool("log_odometer", { equipment: "mini-ex", hours: 300, correct: true })).ok).toBe(true);
    expect(await tool("add_rental", { item: "lift", due_back_date: "2026-10-12", due_back_time: "8am" })).toEqual({ error: "The due-back time has to be after it went out." });
  });

  it("a rental due back the same day says what will really happen", async () => {
    // 10:00, the morning text already went: only the afternoon text (if due after 3pm) is left.
    db.tables.fleet_reminders.push({ id: "c1", organization_id: ORG, company_id: CO, subject_type: "company", subject_id: CO, reminder_key: "daily:2026-10-12:morning", local_date: "2026-10-12" });
    expect((await tool("add_rental", { item: "lift", due_back_date: "2026-10-12", due_back_time: "5pm" })).tell_owner).toContain("I'll remind you this afternoon.");
    expect((await tool("add_rental", { item: "saw", due_back_date: "2026-10-12", due_back_time: "1pm" })).tell_owner).toContain("It's due back too soon for a reminder from me.");
    const at = (iso: string) => Date.parse(iso);
    expect(rentalReminderWords(at("2026-10-13T12:00:00Z"), NOW, TZ, { morning: true, afternoon: false })).toBe("I'll remind you this afternoon. If it's late I'll remind you each morning until it's back.");
    expect(rentalReminderWords(at("2026-10-15T21:00:00Z"), NOW, TZ, { morning: true, afternoon: true })).toBe("I'll remind you the afternoon before and that morning. If it's late I'll remind you each morning until it's back.");
    expect(rentalReminderWords(at("2026-10-12T13:00:00Z"), NOW, TZ, { morning: true, afternoon: true })).toBe("It's already past due - I'll remind you each morning until it's back.");
  });

  it("a rental due back before 9am tomorrow still gets its line after both of today's texts", async () => {
    db.tables.fleet_reminders.push(
      { id: "c1", organization_id: ORG, company_id: CO, subject_type: "company", subject_id: CO, reminder_key: "daily:2026-10-12:morning", local_date: "2026-10-12" },
      { id: "c2", organization_id: ORG, company_id: CO, subject_type: "company", subject_id: CO, reminder_key: "daily:2026-10-12:afternoon", local_date: "2026-10-12" },
    );
    db.tables.rentals.push({ id: COMPACTOR, organization_id: ORG, company_id: CO, item: "plate compactor", vendor: "Wacker", due_back_at: "2026-10-13T11:30:00Z", rate_cents_per_day: null, returned_at: null, out_at: "2026-10-11T12:00:00Z" });
    await sweepFleetReminders(db.client, NOW + 6 * HOUR); // 4pm
    expect(ownerTexts()).toEqual(["CrankLeads: Fleet heads-up: Rental: Wacker plate compactor due back tomorrow 7:30am."]);
  });

  it("re-adding a retired vehicle offers to bring it back (history kept); Settings shows it", async () => {
    db.tables.vehicles.push(vehicle({ id: TRUCK2, name: "Truck 2", active: false, odometer_km: 90_000 }));
    expect(await tool("add_vehicle", { name: "truck 2" })).toMatchObject({ ok: false, ask_owner: "Truck 2 is retired. Bring it back to keep its history, or use another name. Want me to bring it back?" });
    expect(rows("vehicles")).toHaveLength(1);
    expect((await getFleetView(db.client, scope, { manager: true }, NOW))!.retiredVehicles).toEqual([{ id: TRUCK2, name: "Truck 2", description: "2019 Ford F-150, plate ABCD 123" }]);
    expect((await tool("add_vehicle", { name: "truck 2", reactivate: true })).tell_owner).toContain("Updated Truck 2");
    expect(rows("vehicles")).toEqual([expect.objectContaining({ id: TRUCK2, active: true, odometer_km: 90_000 })]);
  });

  it("members don't get Compliance's vehicle insurance; Settings refuses changes while Fleet is off; tools refuse a paused business", async () => {
    db.tables.compliance_documents.push({ organization_id: ORG, company_id: CO, kind: "vehicle_insurance", issuer: "Intact", title: null, expires_on: "2027-03-31", status: "current" });
    expect((await getFleetView(db.client, scope, { manager: false }, NOW))!.vehicleInsurance).toBeNull();
    expect((await getFleetView(db.client, scope, { manager: true }, NOW))!.vehicleInsurance).toHaveLength(1);
    db.tables.companies[0].ai_settings = { fleet: { enabled: false } };
    expect(await runFleetAction(db.client, scope, { action: "save_vehicle", vehicle: { name: "Van" } }, NOW)).toEqual({ error: "Fleet & equipment is off for this business. Turn it on first." });
    expect(rows("vehicles")).toHaveLength(0);
    db.tables.companies[0].ai_settings = {};
    db.tables.companies[0].stage = "paused";
    expect(await tool("fleet_status", {})).toEqual({ error: "This business is paused or archived." });
  });
});

describe("review: the sweep writes nothing when nothing is new, and prunes old claims", () => {
  it("a repeat pass makes no inserts or deletes; claims older than 90 days go", async () => {
    seedFleet();
    db.tables.fleet_reminders.push({ id: "old", organization_id: ORG, company_id: CO, subject_type: "vehicle", subject_id: TRUCK1, reminder_key: "plate:2026-05-01:7", local_date: "2026-06-01" });
    await sweepFleetReminders(db.client, NOW);
    expect(rows("fleet_reminders").some((r) => r.id === "old")).toBe(false);
    const before = db.queries.length;
    await sweepFleetReminders(db.client, NOW + 15 * 60_000);
    await sweepFleetReminders(db.client, NOW + 5.6 * HOUR); // 15:36: the afternoon check, still nothing new besides the compactor
    const writes = db.queries.slice(before).filter((q) => q.table === "fleet_reminders" && (q.op === "insert" || (q.op === "delete" && !q.filters.some((f) => f.column === "local_date"))));
    // Only the afternoon text's claims (slot + the compactor) were written.
    expect(writes.map((q) => q.op)).toEqual(["insert", "insert"]);
    await sweepFleetReminders(db.client, NOW + 6 * HOUR);
    const later = db.queries.slice(before).filter((q) => q.table === "fleet_reminders" && (q.op === "insert" || (q.op === "delete" && !q.filters.some((f) => f.column === "local_date"))));
    expect(later).toHaveLength(2);
  });
});
