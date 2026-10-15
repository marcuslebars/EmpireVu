/**
 * The Dispatcher (docs/ai-staff.md → "Dispatcher"), against the in-memory fake DB with real
 * services underneath (deliverMessage, rescheduleBooking, the owner channel's decideApproval).
 * Only the outside world is faked: Twilio (sendSms), the weather provider and the geocoder.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "@/test/helpers/fake-supabase";

const sendSms = vi.fn((..._a: unknown[]) => Promise.resolve({ sid: `SM${Math.random().toString(36).slice(2, 8)}` }));
const dispatch = vi.fn((..._a: unknown[]) => Promise.resolve({ activityEvent: {}, workflowEventJob: null }));
vi.mock("@/server/outbound/sms", () => ({ sendSms: (...a: unknown[]) => sendSms(...a) }));
vi.mock("@/server/outbound/email", () => ({ sendEmail: vi.fn(() => Promise.resolve({ id: "re_1" })) }));
vi.mock("@/server/services/usage", () => ({ recordUsageSafe: vi.fn(), recordAiUsageSafe: vi.fn() }));
vi.mock("@/server/services/push/activity", () => ({ notifyActivityEvent: vi.fn() }));
vi.mock("@/server/services/workflow-engine/dispatch", () => ({ emitActivityEventAndDispatch: (...a: unknown[]) => dispatch(...a) }));

import { decideApproval } from "@/server/services/owner-channel/approvals";
import { runOwnerTool, type ToolRunState } from "@/server/services/owner-channel/tools";
import { markEnRoute } from "@/server/services/crew/service";
import { roleApprovalExecutor } from "@/server/services/staff/registry";
import { dispatcherRole } from "@/server/services/staff/dispatcher";
import { loadDispatchCompanies, loadDispatchCompany, type DispatchCompany } from "@/server/services/staff/dispatcher/company";
import { crewFingerprint, crewPassForDay, crewScheduleText, sweepCrewTexts } from "@/server/services/staff/dispatcher/crew-schedule";
import { executeFillGap, resetGapEventMemory, sweepFillGap } from "@/server/services/staff/dispatcher/fill-gap";
import { ensureCompanyLocation, locationQueries, parsePlacesLocation, placesGeocoder, type Geocoder } from "@/server/services/staff/dispatcher/geocode";
import { normalizeCellPhone, setMemberPhone } from "@/server/services/staff/dispatcher/member-phone";
import { flushQueuedMessages } from "@/server/services/staff/dispatcher/messages";
import { applyMoves, buildMoveSummary, checkMovedStillValid, movedCustomerText, type PlannedMove } from "@/server/services/staff/dispatcher/moves";
import { etaPhrase, onOurWayText, sweepOnOurWay } from "@/server/services/staff/dispatcher/on-our-way";
import { defaultWeatherSensitivity, dispatcherActiveFor, isWeatherSensitiveJob, mergeDispatchSettings, readDispatchSettings } from "@/server/services/staff/dispatcher/settings";
import { localDayRange, shortLabel, withinLocalHours } from "@/server/services/staff/dispatcher/time";
import {
  assessWindow,
  clearWeatherMemoryCache,
  getCompanyForecast,
  weatherConfigured,
  defaultWeatherProvider,
  openMeteoUrl,
  parseOpenMeteo,
  type Forecast,
  type WeatherProvider,
} from "@/server/services/staff/dispatcher/weather";
import { runWeatherCheck, sweepWeather } from "@/server/services/staff/dispatcher/weather-sweep";

const TZ = "America/Toronto";
const ORG = "11111111-1111-4111-8111-111111111111";
const CO = "22222222-2222-4222-8222-222222222222";
const HOUSE_ORG = "33333333-3333-4333-8333-333333333333";
const HOUSE_CO = "44444444-4444-4444-8444-444444444444";
const OWNER = "+17055559999";
const B_SAM = "a0000000-0000-4000-8000-000000000001";
const B_JO = "a0000000-0000-4000-8000-000000000002";
const B_KIM = "a0000000-0000-4000-8000-000000000003";
const B_LEE = "a0000000-0000-4000-8000-000000000004";
const C_SAM = "c0000000-0000-4000-8000-000000000001";
const C_JO = "c0000000-0000-4000-8000-000000000002";
const C_KIM = "c0000000-0000-4000-8000-000000000003";
const C_LEE = "c0000000-0000-4000-8000-000000000004";
const P_MIKE = "d0000000-0000-4000-8000-000000000001";
const P_ANA = "d0000000-0000-4000-8000-000000000002";
const HOUR = 3_600_000;

// Wed Oct 14 2026, 15:05 in Toronto (EDT, UTC-4).
const NOW = Date.parse("2026-10-14T19:05:00Z");

let db: FakeDb;

function hourly(): Record<string, unknown> {
  return { enabled: true, startHour: 9, endHour: 17, workingDays: [1, 2, 3, 4, 5, 6], slotMinutes: 60, minNoticeHours: 2, horizonDays: 14 };
}

function company(over: Record<string, unknown> = {}) {
  return {
    id: CO, organization_id: ORG, name: "Northshore Roofing", brand_from_name: null, timezone: TZ, ai_settings: {}, stage: "active",
    industry_pack: { id: "roofing", version: 1, appliedAt: "2026-09-01", recipes: [] },
    latitude: 44.75, longitude: -79.89, location_checked_at: null, location_source: "google_place", google_place_id: "ChIJplace", business_address: "1 King St, Midland, ON",
    service_area: "Midland", quote_public_base_url: "https://app.crankleads.test", owner_phone_e164: OWNER, owner_phone_verified_at: "2026-10-01T00:00:00Z",
    booking_policy: null, online_booking_settings: hourly(), visit_settings: { allowReschedule: true, allowCancel: true, cutoffHours: 12 }, updated_at: "2026-10-01T00:00:00Z",
    ...over,
  };
}

function contact(id: string, first: string, last: string, phone: string, over: Record<string, unknown> = {}) {
  return {
    id, organization_id: ORG, company_id: CO, first_name: first, last_name: last, phone, email: null,
    sms_opt_out_at: null, email_opt_out_at: null, sms_consent_at: "2026-10-01T00:00:00Z", consent_source: "inbound_sms", ...over,
  };
}

function booking(id: string, contactId: string | null, title: string, at: string, minutes: number, over: Record<string, unknown> = {}) {
  return {
    id, organization_id: ORG, company_id: CO, contact_id: contactId, title, scheduled_for: at, duration_minutes: minutes, status: "confirmed",
    window_key: null, location: "12 Bay St, Midland, ON L4R 1A1", en_route_at: null, started_at: null, completed_at: null, manage_token: `tok-${id.slice(-1)}`,
    service_item_id: null, recurring_job_id: null, ...over,
  };
}

function seed(): FakeDb {
  return createFakeDb(
    {
      organizations: [
        { id: ORG, platform_brand: "crankleads", plan: "close", slug: "northshore" },
        { id: HOUSE_ORG, platform_brand: "empirevu", plan: "internal", slug: "a1-group" },
      ],
      companies: [
        company(),
        company({ id: HOUSE_CO, organization_id: HOUSE_ORG, name: "A1 Marine Care", industry_pack: { id: "marine", version: 1, appliedAt: "", recipes: [] }, owner_phone_e164: "+17055558888" }),
      ],
      crankleads_purchases: [{ company_id: CO, business_type: "Roofing" }],
      contacts: [
        // Sam's inquiry consent is old (implied consent expired) — transactional texts about his own visit still go.
        contact(C_SAM, "Sam", "Lee", "+17055550101", { sms_consent_at: "2025-01-01T00:00:00Z" }),
        contact(C_JO, "Jo", "Park", "+17055550102"),
        contact(C_KIM, "Kim", "Ng", "+17055550103"),
        contact(C_LEE, "Lee", "Moss", "+17055550104"),
      ],
      bookings: [
        booking(B_SAM, C_SAM, "Roof repair", "2026-10-15T13:00:00Z", 120), // Thu 9:00
        booking(B_JO, C_JO, "Gutter cleaning", "2026-10-15T17:00:00Z", 60), // Thu 13:00
        booking(B_KIM, C_KIM, "Shingle patch", "2026-10-16T14:00:00Z", 60), // Fri 10:00
      ],
      booking_assignments: [],
      tasks: [],
      organization_memberships: [
        { organization_id: ORG, profile_id: P_MIKE, role: "member", phone_e164: "+17055550201" },
        { organization_id: ORG, profile_id: P_ANA, role: "member", phone_e164: null },
        { organization_id: ORG, profile_id: "p-owner", role: "owner", phone_e164: null },
      ],
      profiles: [
        { id: P_MIKE, full_name: "Mike Dunn", email: "mike@example.test" },
        { id: P_ANA, full_name: "Ana Ruiz", email: "ana@example.test" },
        { id: "p-owner", full_name: "Dana Whitfield", email: "dana@example.test" },
      ],
      owner_approvals: [],
      message_log: [],
      dispatch_messages: [],
      dispatch_runs: [],
      dispatch_weather_cache: [],
      activity_events: [],
      workflows: [],
      workflow_runs: [],
      service_catalog_items: [],
      voice_numbers: [{ organization_id: ORG, company_id: CO, provider: "twilio", active: true, phone_e164: "+17055550111", mode: "missed_call_catcher" }],
      platform_sms_opt_outs: [],
    },
    {
      owner_approvals: [["company_id", "short_code"]],
      dispatch_messages: [["company_id", "kind", "dedupe_key"]],
      dispatch_runs: [["company_id", "kind", "run_key"]],
    },
  );
}

/** Hourly forecast for 8 days from Oct 13; `rainyDays` (local dates) get heavy rain all day. */
function forecastWith(rainyDays: string[], over: (localDay: string, hour: number) => Partial<{ windKmh: number; tempC: number }> = () => ({})): Forecast {
  const start = Date.parse("2026-10-13T00:00:00Z");
  const hours = [];
  for (let t = start; t < start + 8 * 24 * HOUR; t += HOUR) {
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t));
    const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", hour: "numeric" }).format(new Date(t)));
    const rainy = rainyDays.includes(day);
    hours.push({ timeMs: t, precipProbability: rainy ? 90 : 10, precipMm: rainy ? 2.5 : 0, windKmh: 15, tempC: 12, ...over(day, hour) });
  }
  return { latitude: 44.75, longitude: -79.89, fetchedAtMs: start, hours };
}

function fakeProvider(forecast: Forecast): WeatherProvider & { calls: number } {
  const p = {
    name: "fake",
    calls: 0,
    async forecast() {
      p.calls++;
      return forecast;
    },
  };
  return p;
}

const notifyNoop = { notify: vi.fn(async () => ({ notified: true })), now: () => new Date(Date.now()) };

async function doneForYou(): Promise<DispatchCompany> {
  return (await loadDispatchCompany(db.client, ORG, CO)) as DispatchCompany;
}

const texts = () => sendSms.mock.calls.map((c) => c[0] as { to: string; body: string; from?: string });
const textsTo = (phone: string) => texts().filter((t) => t.to === phone);
const approvals = () => db.tables.owner_approvals as Array<Record<string, unknown>>;
const messages = () => db.tables.dispatch_messages as Array<Record<string, unknown>>;
const bookingRow = (id: string) => (db.tables.bookings as Array<Record<string, unknown>>).find((b) => b.id === id) as Record<string, unknown>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  sendSms.mockClear();
  dispatch.mockClear();
  notifyNoop.notify.mockClear();
  clearWeatherMemoryCache();
  resetGapEventMemory();
  db = seed();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── Settings ─────────────────────────────────────────────────────────────────

describe("settings", () => {
  it("every switch defaults on for done-for-you and off for house orgs; explicit choices win", () => {
    const dfySettings = readDispatchSettings({}, { doneForYou: true, industryPack: { id: "roofing", version: 1 } });
    expect([dfySettings.weather.enabled, dfySettings.onOurWay.enabled, dfySettings.crewTexts.enabled, dfySettings.fillGap.enabled]).toEqual([true, true, true, true]);
    expect(dfySettings.weather.thresholds).toEqual({ rainProbability: 60, rainMm: 2, windKmh: 50, minTempC: -25, maxTempC: 35 });
    expect(dfySettings.crewTexts.time).toBe("18:00");
    expect(dfySettings.customerHours).toEqual({ from: "09:00", until: "20:00" });
    const house = readDispatchSettings({}, { doneForYou: false });
    expect([house.weather.enabled, house.onOurWay.enabled, house.crewTexts.enabled, house.fillGap.enabled]).toEqual([false, false, false, false]);
    // Crew texts go out until 21:00, so 21:00 or later isn't a valid send time.
    expect(readDispatchSettings({ dispatch: { crew_texts: { time: "21:30" } } }, { doneForYou: true }).crewTexts.time).toBe("18:00");
    expect(readDispatchSettings({ dispatch: { crew_texts: { time: "20:30" } } }, { doneForYou: true }).crewTexts.time).toBe("20:30");
    const optedIn = readDispatchSettings({ dispatch: { on_our_way: { enabled: true }, crew_texts: { time: "17:00" } } }, { doneForYou: false });
    expect(optedIn.onOurWay.enabled).toBe(true);
    expect(optedIn.crewTexts).toEqual({ enabled: false, time: "17:00" });
    expect(readDispatchSettings({ dispatch: { weather: { enabled: false, rain_probability: 999 } } }, { doneForYou: true }).weather).toMatchObject({ enabled: false, thresholds: { rainProbability: 60 } });
  });

  it("weather sensitivity defaults by trade: outdoor → all jobs, indoor and snow removal → none", () => {
    expect(defaultWeatherSensitivity({ industryPack: { id: "roofing", version: 1 } })).toBe("all");
    expect(defaultWeatherSensitivity({ industryPack: { id: "landscaping", version: 1 } })).toBe("all");
    expect(defaultWeatherSensitivity({ industryPack: { id: "property-maintenance-snow", version: 1 } })).toBe("none");
    expect(defaultWeatherSensitivity({ industryPack: { id: "hvac-plumbing", version: 1 } })).toBe("none");
    expect(defaultWeatherSensitivity({ hints: ["Bayview Paving & Sealcoating"] })).toBe("all");
    expect(defaultWeatherSensitivity({ hints: ["Georgian Bay Pressure Washing"] })).toBe("all");
    expect(defaultWeatherSensitivity({ hints: ["Northern Fence & Deck"] })).toBe("all");
    expect(defaultWeatherSensitivity({ hints: ["Midland Snow Removal"] })).toBe("none");
    expect(defaultWeatherSensitivity({ hints: ["Acme Services", "Other"] })).toBe("none");
    expect(isWeatherSensitiveJob(["deck_stain"], { serviceKey: "deck_stain", title: "x" })).toBe(true);
    expect(isWeatherSensitiveJob(["deck_stain"], { serviceKey: null, title: "Deck staining - back yard" }, new Map([["deck_stain", "Deck staining"]]))).toBe(true);
    expect(isWeatherSensitiveJob(["deck_stain"], { serviceKey: "furnace", title: "Furnace tune-up" })).toBe(false);
  });

  it("a patch only touches ai_settings.dispatch (other sections kept)", () => {
    const next = mergeDispatchSettings(
      { sms_agent: { enabled: true }, dispatch: { fill_gap: { enabled: false } } },
      { weather: { enabled: true, sensitive: ["deck_stain"], rainMm: 3 }, crewTexts: { time: "19:00" } },
    );
    expect(next.sms_agent).toEqual({ enabled: true });
    expect(next.dispatch).toEqual({ fill_gap: { enabled: false }, weather: { enabled: true, sensitive: ["deck_stain"], rain_mm: 3 }, crew_texts: { time: "19:00" }, any_on: true });
    expect((mergeDispatchSettings(next, { weather: { sensitive: null } }).dispatch as Record<string, Record<string, unknown>>).weather.sensitive).toBeUndefined();
  });
});

// ── Time ─────────────────────────────────────────────────────────────────────

describe("time (America/Toronto, DST)", () => {
  it("local days are 23h / 25h across DST and hours are checked in local time", () => {
    const fallBack = localDayRange("2026-11-01", TZ);
    expect(fallBack.from.toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(fallBack.to.toISOString()).toBe("2026-11-02T05:00:00.000Z");
    const springForward = localDayRange("2026-03-08", TZ);
    expect((springForward.to.getTime() - springForward.from.getTime()) / HOUR).toBe(23);
    // 08:59 EDT is outside 09:00–20:00; 09:00 inside; 20:00 outside.
    expect(withinLocalHours(Date.parse("2026-10-15T12:59:00Z"), TZ, "09:00", "20:00")).toBe(false);
    expect(withinLocalHours(Date.parse("2026-10-15T13:00:00Z"), TZ, "09:00", "20:00")).toBe(true);
    expect(withinLocalHours(Date.parse("2026-10-16T00:00:00Z"), TZ, "09:00", "20:00")).toBe(false);
    // After the clocks go back, 09:00 local is 14:00Z.
    expect(withinLocalHours(Date.parse("2026-11-02T13:30:00Z"), TZ, "09:00", "20:00")).toBe(false);
    expect(withinLocalHours(Date.parse("2026-11-02T14:00:00Z"), TZ, "09:00", "20:00")).toBe(true);
    expect(shortLabel("2026-10-15T13:00:00Z", TZ)).toBe("Thu 9am");
    expect(shortLabel("2026-10-15T17:30:00Z", TZ)).toBe("Thu 1:30pm");
    // Next week's Thursday carries its date.
    expect(shortLabel("2026-10-15T13:00:00Z", TZ, NOW)).toBe("Thu 9am");
    expect(shortLabel("2026-10-22T13:00:00Z", TZ, NOW)).toBe("Thu Oct 22 9am");
  });
});

// ── Geocoding ────────────────────────────────────────────────────────────────

describe("geocoding (Places API New, behind a seam)", () => {
  it("uses the Google listing first, falls back to the address, stores it once; a miss is retried after 7 days", async () => {
    db.tables.companies[0].latitude = null;
    db.tables.companies[0].longitude = null;
    const geo: Geocoder & { place: ReturnType<typeof vi.fn>; search: ReturnType<typeof vi.fn> } = {
      place: vi.fn(async () => null),
      search: vi.fn(async (q: string) => (q.startsWith("1 King") ? { latitude: 44.7, longitude: -79.9 } : null)),
      placeLocation(id) {
        return this.place(id);
      },
      searchLocation(q) {
        return this.search(q);
      },
    };
    const co = await doneForYou();
    expect(await ensureCompanyLocation(db.client, co, { geocoder: geo, nowMs: NOW })).toEqual({ latitude: 44.7, longitude: -79.9 });
    expect(geo.place).toHaveBeenCalledWith("ChIJplace");
    expect(db.tables.companies[0]).toMatchObject({ latitude: 44.7, longitude: -79.9, location_source: "text_search" });
    // Stored: no more lookups.
    await ensureCompanyLocation(db.client, await doneForYou(), { geocoder: geo, nowMs: NOW });
    expect(geo.search).toHaveBeenCalledTimes(1);

    // A miss is stamped and not retried for a week.
    db.tables.companies[0].latitude = null;
    db.tables.companies[0].longitude = null;
    geo.search.mockImplementation(async () => null);
    expect(await ensureCompanyLocation(db.client, await doneForYou(), { geocoder: geo, nowMs: NOW })).toBeNull();
    const calls = geo.search.mock.calls.length;
    expect(await ensureCompanyLocation(db.client, await doneForYou(), { geocoder: geo, nowMs: NOW + 86_400_000 })).toBeNull();
    expect(geo.search.mock.calls.length).toBe(calls);
  });

  it("the real geocoder calls Places details with the location field mask (fetch injected)", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ location: { latitude: 44.75, longitude: -79.88 } }), { status: 200 }));
    const geo = placesGeocoder(fetchImpl as never, "test-key");
    expect(await geo?.placeLocation("ChIJabc")).toEqual({ latitude: 44.75, longitude: -79.88 });
    expect(fetchImpl.mock.calls[0][0]).toBe("https://places.googleapis.com/v1/places/ChIJabc");
    expect((fetchImpl.mock.calls[0][1]?.headers as Record<string, string>)["X-Goog-FieldMask"]).toBe("location");
    expect(placesGeocoder(fetchImpl as never, null)).toBeNull();
    expect(parsePlacesLocation({ latitude: 200, longitude: 0 })).toBeNull();
    expect(locationQueries({ businessAddress: null, serviceArea: "Midland, Penetanguishene and Tiny", businessName: "x" })).toEqual(["Midland, Ontario"]);
  });
});

// ── Weather ──────────────────────────────────────────────────────────────────

describe("weather", () => {
  it("parses Open-Meteo (unixtime) and applies the thresholds (rain needs both chance and amount)", () => {
    const t0 = Date.parse("2026-10-15T13:00:00Z") / 1000;
    const json = {
      hourly: {
        time: [t0, t0 + 3600, t0 + 7200],
        precipitation_probability: [70, 80, 40],
        precipitation: [0.5, 1.0, 0],
        wind_speed_10m: [20, 30, 55],
        temperature_2m: [10, 11, 12],
      },
    };
    const f = parseOpenMeteo(json, { latitude: 1, longitude: 2 }, 0);
    expect(f.hours).toHaveLength(3);
    const t = { rainProbability: 60, rainMm: 2, windKmh: 50, minTempC: -25, maxTempC: 35 };
    // 2h job: 80% but only 1.5 mm → not rain; wind 30 → fine.
    expect(assessWindow(f, t0 * 1000, t0 * 1000 + 2 * HOUR, t)).toMatchObject({ atRisk: false, maxProbability: 80, totalMm: 1.5 });
    expect(assessWindow(f, t0 * 1000, t0 * 1000 + 2 * HOUR, { ...t, rainMm: 1.5 })).toMatchObject({ atRisk: true, kinds: ["rain"], reason: "rain 80%, 1.5 mm" });
    expect(assessWindow(f, t0 * 1000 + 2 * HOUR, t0 * 1000 + 3 * HOUR, t)).toMatchObject({ atRisk: true, kinds: ["wind"], reason: "wind 55 km/h" });
    expect(assessWindow(f, t0 * 1000 + 10 * HOUR, t0 * 1000 + 11 * HOUR, t)).toMatchObject({ atRisk: false, covered: false });
    const cold = parseOpenMeteo({ hourly: { time: [t0], temperature_2m: [-27] } }, { latitude: 1, longitude: 2 }, 0);
    expect(assessWindow(cold, t0 * 1000, t0 * 1000 + HOUR, t).kinds).toEqual(["cold"]);
  });

  it("uses the commercial endpoint with OPEN_METEO_API_KEY, else the free one", () => {
    expect(openMeteoUrl({ latitude: 44.75, longitude: -79.89 }, 7, null)).toMatch(/^https:\/\/api\.open-meteo\.com\/v1\/forecast\?.*timeformat=unixtime/);
    const paid = openMeteoUrl({ latitude: 44.75, longitude: -79.89 }, 7, "k123");
    expect(paid).toMatch(/^https:\/\/customer-api\.open-meteo\.com\/v1\/forecast\?/);
    expect(paid).toContain("apikey=k123");
    expect(paid).toContain("hourly=precipitation_probability%2Cprecipitation%2Cwind_speed_10m%2Ctemperature_2m");
    // Environment Canada needs no key: weather runs in production unless switched off.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(weatherConfigured({ NODE_ENV: "production" })).toBe(true);
    expect(weatherConfigured({ NODE_ENV: "production", WEATHER_PROVIDER: "off" })).toBe(false);
    // The free Open-Meteo API is never the default: no key → Environment Canada.
    expect(defaultWeatherProvider({}).name).toBe("environment-canada");
    expect(defaultWeatherProvider({ OPEN_METEO_API_KEY: "k" }).name).toBe("open-meteo-commercial");
    warn.mockRestore();
  });

  it("caches one forecast per company per hour", async () => {
    const provider = fakeProvider(forecastWith([]));
    const co = await doneForYou();
    await getCompanyForecast(db.client, co, { latitude: 44.75, longitude: -79.89 }, { provider, nowMs: NOW });
    clearWeatherMemoryCache(); // another worker: served from the DB row
    await getCompanyForecast(db.client, co, { latitude: 44.75, longitude: -79.89 }, { provider, nowMs: NOW + 10 * 60_000 });
    expect(provider.calls).toBe(1);
    await getCompanyForecast(db.client, co, { latitude: 44.75, longitude: -79.89 }, { provider, nowMs: NOW + HOUR });
    expect(provider.calls).toBe(2);
  });
});

// ── Weather sweep → weather_reschedule → decideApproval ─────────────────────

describe("weather reschedule", () => {
  it("one approval per company per day listing each job old → new time and why; Y (owner channel) moves them and texts each customer", async () => {
    const provider = fakeProvider(forecastWith(["2026-10-15"]));
    const companies = await loadDispatchCompanies(db.client);
    // Before 15:00 local: nothing.
    await sweepWeather(db.client, Date.parse("2026-10-14T18:30:00Z"), companies, { provider, geocoder: null });
    expect(approvals()).toHaveLength(0);

    await sweepWeather(db.client, NOW, companies, { provider, geocoder: null });
    expect(approvals()).toHaveLength(1);
    const row = approvals()[0];
    expect(row).toMatchObject({ kind: "weather_reschedule", status: "pending", requested_by: "dispatcher", short_code: 1 });
    // Sam (2h) can't take Fri 9 or 10 (Kim's at 10) → Fri 11am; Jo → Fri 9am. Thursday is rained out.
    expect(row.summary).toBe(
      'Weather: move these 2 jobs? Sam Lee roof repair Thu 9am to Fri 11am (rain 90%, 5 mm); Jo Park gutter cleaning Thu 1pm to Fri 9am (rain 90%, 2.5 mm). Each customer gets: "Hi Sam, it\'s Northshore Roofing. Rain is in the forecast for your roof repair on Thu Oct 15, so we\'ve moved it to Fri Oct 16, 11:00 a.m. Need a different time? [their booking link]"',
    );
    expect(String(row.summary).length).toBeLessThanOrEqual(500);
    // The owner was texted from the platform number with the code.
    const ownerText = textsTo(OWNER).at(-1);
    expect(ownerText?.body).toContain("#1 Weather: move these 2 jobs?");
    expect(ownerText?.body).toContain("Reply Y 1 to approve, N 1 to skip.");

    // Another worker / a later pass the same day: still one.
    await sweepWeather(db.client, NOW + 20 * 60_000, companies, { provider, geocoder: null });
    expect(approvals()).toHaveLength(1);
    expect(db.tables.dispatch_runs).toHaveLength(1);
    // Nothing moved yet.
    expect(bookingRow(B_SAM).scheduled_for).toBe("2026-10-15T13:00:00Z");

    sendSms.mockClear();
    const decided = await decideApproval(db.client, String(row.id), { approved: true, decidedVia: "sms", decidedBy: OWNER }, { nowMs: NOW + 5 * 60_000 });
    expect(decided.outcome).toBe("done");
    expect(decided.message).toBe("Moved 2 jobs: Sam Lee to Fri 11am, Jo Park to Fri 9am. Customers texted.");
    expect(approvals()[0].status).toBe("executed");
    expect(bookingRow(B_SAM).scheduled_for).toBe("2026-10-16T15:00:00.000Z");
    expect(bookingRow(B_JO).scheduled_for).toBe("2026-10-16T13:00:00.000Z");
    const sam = textsTo("+17055550101");
    expect(sam).toHaveLength(1);
    expect(sam[0].body).toContain("Hi Sam, it's Northshore Roofing. Rain is in the forecast for your roof repair on Thu Oct 15, so we've moved it to Fri Oct 16, 11:00 a.m. Need a different time? https://app.crankleads.test/v/tok-1");
    expect(sam[0].from).toBe("+17055550111"); // the business's own number
    expect(textsTo("+17055550102")[0].body).toContain("Fri Oct 16, 9:00 a.m.");
    // The moves were recorded as normal reschedules.
    expect((db.tables.activity_events as Array<Record<string, unknown>>).filter((e) => e.event_type === "booking.rescheduled")).toHaveLength(2);

    // Idempotent: running the executor again doesn't move or text anyone twice.
    sendSms.mockClear();
    const again = await roleApprovalExecutor("weather_reschedule")!(db.client, approvals()[0] as never, { approved: true, decidedVia: "sms", decidedBy: OWNER });
    expect(again.ok).toBe(true);
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("N moves nothing; the vacated-slot claim means no gap offer for weather moves", async () => {
    const provider = fakeProvider(forecastWith(["2026-10-15"]));
    const out = await runWeatherCheck(db.client, await doneForYou(), NOW, { provider, geocoder: null, approvals: notifyNoop });
    expect(out.status).toBe("asked");
    const res = await decideApproval(db.client, String(approvals()[0].id), { approved: false, decidedVia: "sms", decidedBy: OWNER }, { nowMs: NOW });
    expect(res.message).toBe("OK, nothing moved.");
    expect(bookingRow(B_SAM).scheduled_for).toBe("2026-10-15T13:00:00Z");
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("an owner Y after 21:00 moves the jobs now but holds the 'moved' texts until 07:00; a queued text is re-checked against the booking", async () => {
    const provider = fakeProvider(forecastWith(["2026-10-15"]));
    await runWeatherCheck(db.client, await doneForYou(), NOW, { provider, geocoder: null, approvals: notifyNoop });
    const late = Date.parse("2026-10-15T01:30:00Z"); // Wed 21:30 local
    vi.setSystemTime(late);
    const res = await decideApproval(db.client, String(approvals()[0].id), { approved: true, decidedVia: "sms", decidedBy: OWNER }, { nowMs: late });
    expect(res.message).toContain("Customers get their text at 7:00 a.m.");
    expect(bookingRow(B_SAM).scheduled_for).toBe("2026-10-16T15:00:00.000Z");
    expect(sendSms).not.toHaveBeenCalled();
    // Queued for 07:00 local, and useless after the old start time.
    expect(messages().map((m) => [m.kind, m.status, m.not_before, m.expires_at])).toEqual([
      ["job_moved", "queued", "2026-10-15T11:00:00.000Z", "2026-10-15T13:00:00.000Z"],
      ["job_moved", "queued", "2026-10-15T11:00:00.000Z", "2026-10-15T17:00:00.000Z"],
    ]);
    // Jo moves her visit herself overnight: her queued text is no longer true → skipped.
    bookingRow(B_JO).scheduled_for = "2026-10-20T13:00:00Z";
    const companies = new Map((await loadDispatchCompanies(db.client)).map((c) => [c.companyId, c]));
    const checks = { job_moved: checkMovedStillValid };
    expect(await flushQueuedMessages(db.client, Date.parse("2026-10-15T10:59:00Z"), companies, checks)).toBe(0);
    expect(await flushQueuedMessages(db.client, Date.parse("2026-10-15T11:01:00Z"), companies, checks)).toBe(1);
    expect(await flushQueuedMessages(db.client, Date.parse("2026-10-15T11:02:00Z"), companies, checks)).toBe(0); // no double
    expect(textsTo("+17055550101")).toHaveLength(1);
    expect(textsTo("+17055550102")).toHaveLength(0);
    expect(messages()[1]).toMatchObject({ status: "skipped", reason: "booking_changed" });
  });

  it("a move whose text couldn't go out before the old start time is left as is", async () => {
    const early = booking(B_LEE, C_LEE, "Inspection", "2026-10-15T10:30:00Z", 60); // Thu 06:30 local
    (db.tables.bookings as Array<Record<string, unknown>>).push(early);
    const late = Date.parse("2026-10-15T02:00:00Z"); // Wed 22:00 local: the next text is 07:00 Thu
    const move = (id: string, from: string, to: string, who: string, contactId: string): PlannedMove => ({
      bookingId: id, contactId, who, firstName: who.split(" ")[0], job: "inspection", fromStartsAt: from, toStartsAt: to, toWindowKey: null,
    });
    const approval = {
      id: "ap-x", organization_id: ORG, company_id: CO, short_code: 3,
      payload: { moves: [move(B_LEE, "2026-10-15T10:30:00Z", "2026-10-19T14:00:00.000Z", "Lee Moss", C_LEE), move(B_SAM, "2026-10-15T13:00:00Z", "2026-10-19T15:00:00.000Z", "Sam Lee", C_SAM)] },
    };
    const res = await applyMoves(db.client, approval as never, { approved: true, decidedVia: "sms", decidedBy: OWNER }, "bulk", late);
    expect(res.message).toBe("Moved 1 job: Sam Lee to Mon 11am. Customers get their text at 7:00 a.m. Left as is: Lee Moss (too late to tell them before Thu 6:30am).");
    expect(bookingRow(B_LEE).scheduled_for).toBe("2026-10-15T10:30:00Z");
  });

  it("the queue: switched-off features, stale 'sending' rows and unloaded companies", async () => {
    const companies = new Map((await loadDispatchCompanies(db.client)).map((c) => [c.companyId, c]));
    const row = (over: Record<string, unknown>) => ({
      organization_id: ORG, company_id: CO, booking_id: null, contact_id: C_SAM, profile_id: null, approval_id: null, to_phone: null, body: "Hi Sam", status: "queued",
      reason: null, not_before: new Date(NOW - 60_000).toISOString(), expires_at: null, attempts: 0, updated_at: new Date(NOW - 60_000).toISOString(), ...over,
    });
    (db.tables.dispatch_messages as Array<Record<string, unknown>>).push(
      row({ id: "q1", kind: "job_moved", dedupe_key: "a", payload: { audience: "customer", flavour: "weather" } }),
      row({ id: "q2", kind: "job_moved", dedupe_key: "b", status: "sending", updated_at: new Date(NOW - 30 * 60_000).toISOString(), payload: { audience: "customer", flavour: "bulk" } }),
      row({ id: "q3", kind: "job_moved", dedupe_key: "c", organization_id: HOUSE_ORG, company_id: HOUSE_CO, payload: { audience: "customer", flavour: "bulk" } }),
    );
    db.tables.companies[0].ai_settings = { dispatch: { weather: { enabled: false } } };
    const reloaded = new Map((await loadDispatchCompanies(db.client)).map((c) => [c.companyId, c]));
    expect(await flushQueuedMessages(db.client, NOW, reloaded)).toBe(1); // the reclaimed bulk one
    expect(messages().map((m) => [m.id, m.status, m.reason])).toEqual([
      ["q1", "skipped", "feature_off"],
      ["q2", "sent", null],
      ["q3", "queued", null], // not a loaded company: left alone, never blocks the others
    ]);
    expect(companies.has(HOUSE_CO)).toBe(false);
  });

  it("re-checks at Y: a job moved meanwhile, or a new time that got taken, is left as is", async () => {
    const provider = fakeProvider(forecastWith(["2026-10-15"]));
    await runWeatherCheck(db.client, await doneForYou(), NOW, { provider, geocoder: null, approvals: notifyNoop });
    bookingRow(B_JO).scheduled_for = "2026-10-20T13:00:00Z"; // the customer moved it themselves
    (db.tables.bookings as Array<Record<string, unknown>>).push(booking(B_LEE, C_LEE, "Inspection", "2026-10-16T15:00:00Z", 60)); // Fri 11 taken
    const res = await decideApproval(db.client, String(approvals()[0].id), { approved: true, decidedVia: "sms", decidedBy: OWNER }, { nowMs: NOW });
    expect(res.result?.ok).toBe(false);
    expect(res.message).toBe("Nothing moved: Sam Lee (Fri 11am got taken); Jo Park (already moved).");
    expect(approvals()[0].status).toBe("failed");
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("house orgs (A1) and indoor trades get no weather checks by default", async () => {
    const provider = fakeProvider(forecastWith(["2026-10-15"]));
    db.tables.companies[0].industry_pack = { id: "hvac-plumbing", version: 1, appliedAt: "", recipes: [] };
    db.tables.crankleads_purchases = [];
    const companies = await loadDispatchCompanies(db.client);
    // A house org with nothing switched on isn't even loaded.
    expect(companies.find((c) => c.companyId === HOUSE_CO)).toBeUndefined();
    expect((await loadDispatchCompany(db.client, HOUSE_ORG, HOUSE_CO))?.settings.weather.enabled).toBe(false);
    expect(companies.find((c) => c.companyId === CO)?.settings.weather.sensitive).toBe("none");
    await sweepWeather(db.client, NOW, companies, { provider, geocoder: null });
    expect(approvals()).toHaveLength(0);
    expect(provider.calls).toBe(0);
  });

  it("summaries stay within 500 chars by listing fewer jobs (Y only moves what was shown)", () => {
    const move = (i: number): PlannedMove => ({
      bookingId: `b${i}`, contactId: null, who: `Customer Number${i}`, firstName: "Pat", job: "exterior house painting", fromStartsAt: "2026-10-15T13:00:00Z", toStartsAt: "2026-10-16T13:00:00Z", toWindowKey: null, reason: "rain 90%, 12 mm", customerReason: "Rain is in the forecast",
    });
    const { summary, included } = buildMoveSummary({ flavour: "weather", headline: "Weather: move these 9 jobs?", moves: Array.from({ length: 9 }, (_, i) => move(i)), leftAsIs: [], businessName: "Northshore Roofing", timeZone: TZ });
    expect(summary.length).toBeLessThanOrEqual(500);
    expect(included.length).toBeLessThan(9);
    expect(summary).toContain("more not included");
    expect(movedCustomerText({ flavour: "bulk", businessName: "X", move: move(1), timeZone: TZ, link: null })).toBe(
      "Hi Pat, it's X. We need to move your exterior house painting from Thu Oct 15 to Fri Oct 16, 9:00 a.m. Sorry for the change. Reply here if that time doesn't work.",
    );
  });
});

// ── On our way ───────────────────────────────────────────────────────────────

describe("on our way", () => {
  function enRouteEvent(bookingId: string, meta: Record<string, unknown>, at = NOW - 30_000) {
    bookingRow(bookingId).en_route_at = new Date(at).toISOString();
    (db.tables.activity_events as Array<Record<string, unknown>>).push({
      id: `ev-${bookingId}`, organization_id: ORG, company_id: CO, entity_type: "booking", entity_id: bookingId, event_type: "booking.en_route",
      metadata_json: { bookingId, ...meta }, occurred_at: new Date(at).toISOString(),
    });
  }

  it("markEnRoute carries the ETA on the booking.en_route event", async () => {
    const ctx = { organizationId: ORG, actorProfileId: P_MIKE, supabase: db.client };
    await markEnRoute(ctx as never, B_SAM, { etaMinutes: 25 });
    expect(dispatch.mock.calls[0][1]).toMatchObject({ eventType: "booking.en_route", metadata: { bookingId: B_SAM, by: P_MIKE, etaMinutes: 25 } });
    expect(bookingRow(B_SAM).en_route_at).toBeTruthy();
  });

  it("texts the customer once, with the crew member's name and the ETA", async () => {
    enRouteEvent(B_SAM, { by: P_MIKE, etaMinutes: 20 });
    const companies = new Map((await loadDispatchCompanies(db.client)).map((c) => [c.companyId, c]));
    await sweepOnOurWay(db.client, NOW, companies);
    await sweepOnOurWay(db.client, NOW + 60_000, companies);
    const sam = textsTo("+17055550101");
    expect(sam).toHaveLength(1);
    expect(sam[0].body).toBe("Hi Sam, it's Northshore Roofing. Mike from our crew is on the way for your roof repair and should be there in about 20 minutes. See you soon!\nReply STOP to opt out");
    expect(messages()[0]).toMatchObject({ kind: "on_our_way", status: "sent", dedupe_key: B_SAM });
    expect(etaPhrase(60)).toBe("about an hour");
    expect(etaPhrase(90)).toBe("about 1 hour 30 minutes");
    expect(onOurWayText({ businessName: "X", customerFirstName: "", crewFirstName: null, job: "visit", etaMinutes: null })).toBe("Hi, it's X. Our crew is on the way for your visit now. See you soon!");
  });

  it("never doubles up with the crew-on-the-way automation: if it's active, it texts and we don't", async () => {
    (db.tables.workflows as Array<Record<string, unknown>>).push({
      id: "wf-1", organization_id: ORG, company_id: CO, slug: "crew-on-the-way", status: "active", trigger_event: "booking.en_route",
      definition: { version: 1, conditions: [], actions: [{ type: "send_sms", to: "contact", body: "on the way" }] },
    });
    enRouteEvent(B_SAM, { by: P_MIKE });
    const companies = new Map((await loadDispatchCompanies(db.client)).map((c) => [c.companyId, c]));
    await sweepOnOurWay(db.client, NOW, companies);
    expect(sendSms).not.toHaveBeenCalled();
    // A draft recipe doesn't count.
    (db.tables.workflows as Array<Record<string, unknown>>)[0].status = "draft";
    await sweepOnOurWay(db.client, NOW + 60_000, companies);
    expect(textsTo("+17055550101")).toHaveLength(1);
  });

  it("respects opt-outs and the on-our-way hours; house orgs get nothing by default", async () => {
    (db.tables.contacts as Array<Record<string, unknown>>)[0].sms_opt_out_at = "2026-10-01T00:00:00Z";
    enRouteEvent(B_SAM, {});
    const companies = new Map((await loadDispatchCompanies(db.client)).map((c) => [c.companyId, c]));
    await sweepOnOurWay(db.client, NOW, companies);
    const early = Date.parse("2026-10-15T10:30:00Z"); // 06:30 local
    enRouteEvent(B_JO, {}, early - 30_000);
    await sweepOnOurWay(db.client, early, companies);
    expect(sendSms).not.toHaveBeenCalled();
    expect(messages().map((m) => [m.dedupe_key, m.status, m.reason])).toEqual([
      [B_SAM, "skipped", "opted_out"],
      [B_JO, "skipped", "outside_hours"],
    ]);

    // House org: the event is ignored entirely.
    (db.tables.bookings as Array<Record<string, unknown>>).push(booking("a0000000-0000-4000-8000-000000000009", null, "Shrink wrap", "2026-10-15T13:00:00Z", 60, { organization_id: HOUSE_ORG, company_id: HOUSE_CO, en_route_at: new Date(NOW).toISOString() }));
    (db.tables.activity_events as Array<Record<string, unknown>>).push({ id: "ev-h", organization_id: HOUSE_ORG, company_id: HOUSE_CO, entity_id: "a0000000-0000-4000-8000-000000000009", event_type: "booking.en_route", metadata_json: {}, occurred_at: new Date(NOW).toISOString() });
    await sweepOnOurWay(db.client, NOW + 60_000, companies);
    expect(messages().filter((m) => m.company_id === HOUSE_CO)).toHaveLength(0);
  });
});

// ── Crew schedule texts ──────────────────────────────────────────────────────

describe("crew schedule texts", () => {
  it("18:00 local on the eve of a DST change: tomorrow is the 25-hour local day; members with no phone are skipped; updates only on a change", async () => {
    // Sat Oct 31 2026 → Sun Nov 1 (clocks go back at 02:00).
    const late = "2026-11-02T04:30:00Z"; // Sun Nov 1, 23:30 EST — still "tomorrow"
    const nextDay = "2026-11-02T05:30:00Z"; // Mon Nov 2, 00:30 EST — not
    db.tables.bookings = [
      booking(B_SAM, C_SAM, "Roof repair", "2026-11-01T13:00:00Z", 120), // Sun 08:00 EST
      booking(B_JO, C_JO, "Gutter cleaning", late, 30),
      booking(B_KIM, C_KIM, "Shingle patch", nextDay, 60),
    ];
    db.tables.booking_assignments = [
      { organization_id: ORG, booking_id: B_SAM, profile_id: P_MIKE },
      { organization_id: ORG, booking_id: B_JO, profile_id: P_MIKE },
      { organization_id: ORG, booking_id: B_KIM, profile_id: P_MIKE },
      { organization_id: ORG, booking_id: B_SAM, profile_id: P_ANA },
    ];
    const companies = await loadDispatchCompanies(db.client);
    await sweepCrewTexts(db.client, Date.parse("2026-10-31T21:55:00Z"), companies); // 17:55 EDT
    expect(sendSms).not.toHaveBeenCalled();
    await sweepCrewTexts(db.client, Date.parse("2026-10-31T22:05:00Z"), companies); // 18:05 EDT
    const mike = textsTo("+17055550201");
    expect(mike).toHaveLength(1);
    expect(mike[0].body).toBe(
      "Northshore Roofing - your jobs tomorrow (Sun Nov 1):\n1) 8:00 a.m. - Sam - roof repair - 12 Bay St - https://maps.google.com/?q=12+Bay+St%2C+Midland%2C+ON+L4R+1A1\n2) 11:30 p.m. - Jo - gutter cleaning - 12 Bay St - https://maps.google.com/?q=12+Bay+St%2C+Midland%2C+ON+L4R+1A1",
    );
    expect(texts().every((t) => t.from === "+17055550111")).toBe(true);
    // Ana has no phone: nothing. A second pass: nothing new.
    await sweepCrewTexts(db.client, Date.parse("2026-10-31T22:10:00Z"), companies);
    expect(sendSms).toHaveBeenCalledTimes(1);

    // Jo's job moves to 10am → one update with the new list.
    bookingRow(B_JO).scheduled_for = "2026-11-01T15:00:00Z"; // 10:00 EST
    await sweepCrewTexts(db.client, Date.parse("2026-10-31T23:00:00Z"), companies);
    expect(textsTo("+17055550201")).toHaveLength(2);
    expect(textsTo("+17055550201")[1].body).toContain("Northshore Roofing update - your jobs tomorrow (Sun Nov 1) changed:");
    expect(textsTo("+17055550201")[1].body).toContain("2) 10:00 a.m. - Jo");
    await sweepCrewTexts(db.client, Date.parse("2026-10-31T23:05:00Z"), companies);
    expect(textsTo("+17055550201")).toHaveLength(2);

    // After 21:00 nothing; on the day (from 06:00 EST = 11:00Z) a removal is an update.
    bookingRow(B_SAM).status = "cancelled";
    bookingRow(B_JO).status = "cancelled";
    await sweepCrewTexts(db.client, Date.parse("2026-11-01T02:00:00Z"), companies); // 22:00 EDT Sat
    expect(textsTo("+17055550201")).toHaveLength(2);
    await sweepCrewTexts(db.client, Date.parse("2026-11-01T11:05:00Z"), companies); // 06:05 EST Sun
    expect(textsTo("+17055550201")[2].body).toBe("Northshore Roofing update: you have no more jobs today (Sun Nov 1).");
  });

  it("on the day, heading out, starting, finishing or a no-show never re-texts the crew; a cancelled or added job does", async () => {
    db.tables.bookings = [
      booking(B_SAM, C_SAM, "Roof repair", "2026-10-15T13:00:00Z", 120), // Thu 9:00
      booking(B_JO, C_JO, "Gutter cleaning", "2026-10-15T17:00:00Z", 60), // Thu 13:00
      booking(B_KIM, C_KIM, "Shingle patch", "2026-10-15T19:00:00Z", 60), // Thu 15:00
    ];
    db.tables.booking_assignments = [B_SAM, B_JO, B_KIM].map((b) => ({ organization_id: ORG, booking_id: b, profile_id: P_MIKE }));
    const companies = await loadDispatchCompanies(db.client);
    await sweepCrewTexts(db.client, Date.parse("2026-10-14T22:05:00Z"), companies); // Wed 18:05
    expect(textsTo("+17055550201")).toHaveLength(1);
    // Thursday: Sam's job goes en route, starts and is done; Jo is a no-show — every 5 minutes, nothing.
    bookingRow(B_SAM).en_route_at = "2026-10-15T12:40:00Z";
    await sweepCrewTexts(db.client, Date.parse("2026-10-15T12:45:00Z"), companies);
    bookingRow(B_SAM).started_at = "2026-10-15T13:00:00Z";
    await sweepCrewTexts(db.client, Date.parse("2026-10-15T13:05:00Z"), companies);
    bookingRow(B_SAM).status = "completed";
    bookingRow(B_JO).status = "no_show";
    await sweepCrewTexts(db.client, Date.parse("2026-10-15T18:05:00Z"), companies);
    expect(textsTo("+17055550201")).toHaveLength(1);
    // Kim cancels → one update, listing only what's still to do.
    bookingRow(B_KIM).status = "cancelled";
    (db.tables.bookings as Array<Record<string, unknown>>).push(booking(B_LEE, C_LEE, "Inspection", "2026-10-15T20:00:00Z", 60));
    (db.tables.booking_assignments as Array<Record<string, unknown>>).push({ organization_id: ORG, booking_id: B_LEE, profile_id: P_MIKE });
    await sweepCrewTexts(db.client, Date.parse("2026-10-15T18:10:00Z"), companies);
    const mike = textsTo("+17055550201");
    expect(mike).toHaveLength(2);
    expect(mike[1].body).toMatch(/^Northshore Roofing update - your jobs today \(Thu Oct 15\) changed:\n1\) 4:00 p\.m\. - Lee - inspection/);
    expect(mike[1].body).not.toContain("Sam");
  });

  it("18:00 after the clocks go back is 23:00Z, not 22:00Z", async () => {
    db.tables.bookings = [booking(B_SAM, C_SAM, "Roof repair", "2026-11-02T15:00:00Z", 60)];
    db.tables.booking_assignments = [{ organization_id: ORG, booking_id: B_SAM, profile_id: P_MIKE }];
    const companies = await loadDispatchCompanies(db.client);
    await sweepCrewTexts(db.client, Date.parse("2026-11-01T22:30:00Z"), companies); // 17:30 EST
    expect(sendSms).not.toHaveBeenCalled();
    await sweepCrewTexts(db.client, Date.parse("2026-11-01T23:01:00Z"), companies); // 18:01 EST
    expect(sendSms).toHaveBeenCalledTimes(1);
  });

  it("fingerprints change with time, place or job and text lists cap at 8", () => {
    const job = { bookingId: "b1", startsAt: "2026-10-15T13:00:00Z", title: "Roof", location: "1 A St", customerFirstName: "Sam" };
    expect(crewFingerprint([job])).toBe(crewFingerprint([{ ...job }]));
    expect(crewFingerprint([job])).not.toBe(crewFingerprint([{ ...job, location: "2 B St" }]));
    const many = Array.from({ length: 10 }, (_, i) => ({ ...job, bookingId: `b${i}` }));
    expect(crewScheduleText({ businessName: "X", day: "2026-10-15", timeZone: TZ, jobs: many, update: false, tomorrow: true })).toContain("+2 more in the app.");
  });

  it("house orgs: no crew texts by default", async () => {
    db.tables.booking_assignments = [{ organization_id: ORG, booking_id: B_SAM, profile_id: P_MIKE }];
    db.tables.organizations[0].platform_brand = "empirevu";
    expect(await loadDispatchCompanies(db.client)).toEqual([]);
    expect(await dispatcherActiveFor(db.client, { organizationId: ORG, companyId: CO })).toBe(false);
    expect(sendSms).not.toHaveBeenCalled();
    // …until the owner turns it on.
    db.tables.companies[0].ai_settings = mergeDispatchSettings({}, { crewTexts: { enabled: true } });
    const co = (await loadDispatchCompanies(db.client)).find((c) => c.companyId === CO) as DispatchCompany;
    const out = await crewPassForDay(db.client, co, "2026-10-15", Date.parse("2026-10-14T22:05:00Z"), { initial: true, tomorrow: true });
    expect(out.sent).toBe(1);
  });
});

// ── Fill the gap ─────────────────────────────────────────────────────────────

describe("fill the gap", () => {
  function cancelEvent(bookingId: string) {
    bookingRow(bookingId).status = "cancelled";
    (db.tables.activity_events as Array<Record<string, unknown>>).push({
      id: `ev-c-${bookingId}`, organization_id: ORG, company_id: CO, entity_type: "booking", entity_id: bookingId, event_type: "booking.status_changed",
      metadata_json: { bookingId, previousStatus: "confirmed", status: "cancelled" }, occurred_at: new Date(NOW - 60_000).toISOString(),
    });
  }

  it("a cancellation within 48h → one fill_gap approval for the soonest later similar booking not offered in 7 days; Y texts them the offer", async () => {
    // Kim (Fri 10am, 60 min) was offered a gap 3 days ago; Lee (Sat 10am, 60 min) is next.
    (db.tables.bookings as Array<Record<string, unknown>>).push(booking(B_LEE, C_LEE, "Chimney flashing", "2026-10-17T14:00:00Z", 60));
    (db.tables.dispatch_messages as Array<Record<string, unknown>>).push({
      id: "dm-old", organization_id: ORG, company_id: CO, kind: "gap_offer", dedupe_key: "old", booking_id: B_KIM, status: "sent", created_at: new Date(NOW - 3 * 86_400_000).toISOString(), payload: {},
    });
    cancelEvent(B_JO); // Thu 1pm, 60 min
    const companies = new Map((await loadDispatchCompanies(db.client)).map((c) => [c.companyId, c]));
    await sweepFillGap(db.client, NOW, companies, notifyNoop);
    await sweepFillGap(db.client, NOW + 2 * 60_000, companies, notifyNoop);
    expect(approvals()).toHaveLength(1);
    const row = approvals()[0];
    expect(row.kind).toBe("fill_gap");
    expect(row.summary).toBe(
      'Jo Park cancelled Thu 1pm. Offer it to Lee Moss (booked Sat 10am)? They\'d get: "Hi Lee, it\'s Northshore Roofing. A spot opened up on Thu Oct 15, 1:00 p.m., earlier than your chimney flashing on Sat Oct 17, 10:00 a.m. Want it? You can switch here: [their booking link]"',
    );
    const res = await decideApproval(db.client, String(row.id), { approved: true, decidedVia: "sms", decidedBy: OWNER }, { nowMs: NOW + 5 * 60_000 });
    expect(res.message).toBe("Offered Thu 1pm to Lee Moss. If they take it, it shows up on your calendar.");
    const lee = textsTo("+17055550104");
    expect(lee).toHaveLength(1);
    expect(lee[0].body).toContain("You can switch here: https://app.crankleads.test/v/tok-4");
    // Nothing moved on its own.
    expect(bookingRow(B_LEE).scheduled_for).toBe("2026-10-17T14:00:00Z");
  });

  it("no offer when the slot is refilled, when it's more than 48h out, or when the setting is off", async () => {
    cancelEvent(B_KIM); // Fri 10am = ~43h out
    (db.tables.bookings as Array<Record<string, unknown>>).push(booking(B_LEE, C_LEE, "Inspection", "2026-10-16T14:00:00Z", 60)); // refilled
    const companies = new Map((await loadDispatchCompanies(db.client)).map((c) => [c.companyId, c]));
    await sweepFillGap(db.client, NOW, companies, notifyNoop);
    expect(approvals()).toHaveLength(0);
    // Lee took Fri 10am: no visit page can offer it any more.
    expect(db.tables.dispatch_runs[0]).toMatchObject({ status: "skipped", detail: { reason: "no_candidate" } });

    db.tables.companies[0].ai_settings = { dispatch: { fill_gap: { enabled: false } } };
    cancelEvent(B_SAM);
    await sweepFillGap(db.client, NOW, new Map((await loadDispatchCompanies(db.client)).map((c) => [c.companyId, c])), notifyNoop);
    expect(approvals()).toHaveLength(0);
  });

  it("the offer re-checks at Y: if the gap got booked meanwhile, nothing is sent", async () => {
    (db.tables.bookings as Array<Record<string, unknown>>).push(booking(B_LEE, C_LEE, "Chimney flashing", "2026-10-17T14:00:00Z", 60));
    cancelEvent(B_JO);
    await sweepFillGap(db.client, NOW, new Map((await loadDispatchCompanies(db.client)).map((c) => [c.companyId, c])), notifyNoop);
    const row = approvals()[0];
    (db.tables.bookings as Array<Record<string, unknown>>).push(booking("a0000000-0000-4000-8000-000000000008", C_SAM, "Walk-in", "2026-10-15T17:00:00Z", 60));
    const res = await executeFillGap(db.client, row as never, { approved: true, decidedVia: "sms", decidedBy: OWNER }, NOW);
    expect(res).toMatchObject({ ok: false, message: "Thu 1pm can't be offered any more (it's booked, or too close to change online) - nothing sent." });
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("only offers what the customer's visit page can take: not inside the change cutoff, not when self-serve moves are off", async () => {
    (db.tables.bookings as Array<Record<string, unknown>>).push(booking(B_LEE, C_LEE, "Chimney flashing", "2026-10-17T14:00:00Z", 60));
    db.tables.companies[0].visit_settings = {}; // default: changes need 24h notice; Jo's 1pm Thu slot is ~22h away
    cancelEvent(B_JO);
    const companies = () => loadDispatchCompanies(db.client).then((cs) => new Map(cs.map((c) => [c.companyId, c])));
    await sweepFillGap(db.client, NOW, await companies(), notifyNoop);
    expect(approvals()).toHaveLength(0);
    expect(db.tables.dispatch_runs[0]).toMatchObject({ status: "skipped", detail: { reason: "inside_change_cutoff" } });

    resetGapEventMemory();
    db.tables.dispatch_runs = [];
    db.tables.companies[0].visit_settings = { allowReschedule: false, cutoffHours: 12 };
    await sweepFillGap(db.client, NOW, await companies(), notifyNoop);
    expect(db.tables.dispatch_runs[0]).toMatchObject({ status: "skipped", detail: { reason: "self_reschedule_off" } });
  });

  it("a move away is read from the event before any booking is loaded; a move within the same slot isn't a gap", async () => {
    (db.tables.bookings as Array<Record<string, unknown>>).push(booking(B_LEE, C_LEE, "Chimney flashing", "2026-10-17T14:00:00Z", 60));
    bookingRow(B_JO).scheduled_for = "2026-10-21T17:00:00Z";
    (db.tables.activity_events as Array<Record<string, unknown>>).push(
      { id: "ev-m1", organization_id: ORG, company_id: CO, entity_id: B_JO, event_type: "booking.rescheduled", occurred_at: new Date(NOW - 60_000).toISOString(),
        metadata_json: { bookingId: B_JO, previousScheduledFor: "2026-10-15T17:00:00Z", scheduledFor: "2026-10-21T17:00:00Z", durationMinutes: 60 } },
      { id: "ev-m2", organization_id: ORG, company_id: CO, entity_id: B_SAM, event_type: "booking.rescheduled", occurred_at: new Date(NOW - 60_000).toISOString(),
        metadata_json: { bookingId: B_SAM, previousScheduledFor: "2026-10-15T13:00:00Z", scheduledFor: "2026-10-15T13:30:00Z", durationMinutes: 120 } },
    );
    await sweepFillGap(db.client, NOW, new Map((await loadDispatchCompanies(db.client)).map((c) => [c.companyId, c])), notifyNoop);
    expect(approvals()).toHaveLength(1);
    expect(approvals()[0].summary).toMatch(/^Jo Park moved off Thu 1pm\. Offer it to Kim Ng/);
  });
});

// ── Owner tools ──────────────────────────────────────────────────────────────

describe("owner tools", () => {
  function state(): ToolRunState {
    return { admin: db.client, scope: { organizationId: ORG, companyId: CO, companyName: "Northshore Roofing", timeZone: TZ }, ownerPhone: OWNER, nowMs: NOW, confirmation: null, actions: [] };
  }

  it("move_day proposes a bulk_reschedule the owner answers with Y; Y moves each job (same time when open) and texts the customers", async () => {
    const result = await runOwnerTool(state(), "move_day", { from_date: "tomorrow", to_date: "2026-10-19" });
    expect(result.ok).toBe(true);
    expect(result.tell_owner_exactly).toBe(
      '#1 Move 2 jobs from Thu Oct 15 to Mon Oct 19? Sam Lee roof repair Thu 9am to Mon 9am; Jo Park gutter cleaning Thu 1pm to Mon 1pm. Each customer gets: "Hi Sam, it\'s Northshore Roofing. We need to move your roof repair from Thu Oct 15 to Mon Oct 19, 9:00 a.m. Sorry for the change. Need a different time? [their booking link]" Reply Y 1 to move them, N 1 to leave them.',
    );
    // Asked inline: already counts as texted to the owner's phone (so "Y 1" is accepted), no second text.
    expect(approvals()[0]).toMatchObject({ kind: "bulk_reschedule", notified_to: OWNER });
    expect(sendSms).not.toHaveBeenCalled();
    expect(bookingRow(B_SAM).scheduled_for).toBe("2026-10-15T13:00:00Z");

    const res = await decideApproval(db.client, String(approvals()[0].id), { approved: true, decidedVia: "sms", decidedBy: OWNER }, { nowMs: NOW });
    expect(res.message).toBe("Moved 2 jobs: Sam Lee to Mon 9am, Jo Park to Mon 1pm. Customers texted.");
    expect(bookingRow(B_SAM).scheduled_for).toBe("2026-10-19T13:00:00.000Z");
    expect(textsTo("+17055550101")[0].body).toContain("We need to move your roof repair from Thu Oct 15 to Mon Oct 19, 9:00 a.m.");
  });

  it("move_day validates its dates and is scoped to the owner's company", async () => {
    expect(await runOwnerTool(state(), "move_day", { from_date: "tomorrow", to_date: "2026-10-01" })).toMatchObject({ error: "That day has already passed." });
    expect(await runOwnerTool(state(), "move_day", { from_date: "2026-10-22", to_date: "2026-10-23" })).toMatchObject({ ok: false, reason: "Nothing is booked on Thu Oct 22." });
    const other = { ...state(), scope: { ...state().scope, organizationId: HOUSE_ORG } };
    expect(await runOwnerTool(other, "move_day", { from_date: "tomorrow", to_date: "2026-10-19" })).toMatchObject({ error: "Business not found." });
  });

  it("crew_plan lists tomorrow by crew member with unassigned jobs", async () => {
    db.tables.booking_assignments = [{ organization_id: ORG, booking_id: B_SAM, profile_id: P_MIKE }];
    const plan = await runOwnerTool(state(), "crew_plan", {});
    expect(plan).toMatchObject({
      ok: true,
      day: "Thu Oct 15",
      crew: [{ member: "Mike Dunn", cell_on_file: true, jobs: ["9:00 a.m. - Sam - Roof repair - 12 Bay St"] }],
      unassigned: ["1:00 p.m. - Jo - Gutter cleaning - 12 Bay St"],
    });
  });

  it("weather_outlook flags at-risk jobs for the next 3 days", async () => {
    const tools = (await import("@/server/services/staff/dispatcher/owner-tools")).dispatcherOwnerTools({ provider: () => fakeProvider(forecastWith(["2026-10-15"])), geocoder: () => null });
    const outlook = (await tools.find((t) => t.tool.name === "weather_outlook")!.run(state(), {})) as { days: Array<{ day: string; jobs: Array<{ customer: string; at_risk: string | null }> }> };
    expect(outlook.days.map((d) => d.day)).toEqual(["Wed Oct 14", "Thu Oct 15", "Fri Oct 16"]);
    expect(outlook.days[1].jobs).toEqual([
      expect.objectContaining({ customer: "Sam Lee", at_risk: "rain 90%, 5 mm" }),
      expect.objectContaining({ customer: "Jo Park", at_risk: "rain 90%, 2.5 mm" }),
    ]);
    expect(outlook.days[2].jobs[0]).toMatchObject({ customer: "Kim Ng", at_risk: null });
  });
});

// ── Registry + crew phones ───────────────────────────────────────────────────

describe("registry and crew phones", () => {
  it("registers its kinds, owner tools and sweeps", () => {
    expect(Object.keys(dispatcherRole.approvalExecutors).sort()).toEqual(["bulk_reschedule", "fill_gap", "weather_reschedule"]);
    expect(dispatcherRole.ownerTools.map((t) => t.tool.name)).toEqual(["weather_outlook", "crew_plan", "move_day"]);
    expect(dispatcherRole.sweeps.map((s) => s.name)).toEqual(["dispatcher:on-our-way", "dispatcher:queue", "dispatcher:fill-gap", "dispatcher:crew-texts", "dispatcher:weather"]);
    expect(roleApprovalExecutor("fill_gap")).toBeTypeOf("function");
  });

  it("dispatcherActiveFor: on for a done-for-you company, off for a house org by default, never throws", async () => {
    expect(await dispatcherActiveFor(db.client, { organizationId: ORG, companyId: CO })).toBe(true);
    expect(await dispatcherActiveFor(db.client, { organizationId: HOUSE_ORG, companyId: HOUSE_CO })).toBe(false);
    expect(await dispatcherActiveFor(db.client, { organizationId: HOUSE_ORG, companyId: CO })).toBe(false); // wrong org
    expect(await dispatcherActiveFor({ from: () => { throw new Error("db down"); } } as never, { organizationId: ORG, companyId: CO })).toBe(false);
  });

  it("the queue sweep skips loading companies when nothing is due; companies are loaded once per tick", async () => {
    const { DISPATCHER_SWEEPS } = await import("@/server/services/staff/dispatcher");
    const { resetDispatchCompanyCache } = await import("@/server/services/staff/dispatcher/company");
    resetDispatchCompanyCache();
    const queue = DISPATCHER_SWEEPS.find((s) => s.name === "dispatcher:queue")!;
    const before = db.queries.length;
    await queue.run(db.client, NOW);
    expect(db.queries.slice(before).map((q) => q.table)).toEqual(["dispatch_messages", "dispatch_messages"]);
    const onOurWay = DISPATCHER_SWEEPS.find((s) => s.name === "dispatcher:on-our-way")!;
    const crew = DISPATCHER_SWEEPS.find((s) => s.name === "dispatcher:crew-texts")!;
    const mark = db.queries.length;
    await onOurWay.run(db.client, NOW);
    await crew.run(db.client, NOW + 1000);
    // One load = the done-for-you-org query + the opted-in house-org query.
    expect(db.queries.slice(mark).filter((q) => q.table === "companies")).toHaveLength(2);
  });

  it("normalizes and stores member cells, scoped to the org", async () => {
    expect(normalizeCellPhone("(705) 555-0142")).toBe("+17055550142");
    expect(normalizeCellPhone("+44 20 7946 0958")).toBe("+442079460958");
    expect(normalizeCellPhone("555-0142")).toBeNull();
    expect(await setMemberPhone(db.client, ORG, P_ANA, "705 555 0300")).toBe("+17055550300");
    expect((db.tables.organization_memberships as Array<Record<string, unknown>>).find((m) => m.profile_id === P_ANA)?.phone_e164).toBe("+17055550300");
    await expect(setMemberPhone(db.client, HOUSE_ORG, P_ANA, "705 555 0300")).rejects.toThrow("isn't on this team");
    await expect(setMemberPhone(db.client, ORG, P_ANA, "12")).rejects.toThrow("doesn't look like a cell number");
    expect(await setMemberPhone(db.client, ORG, P_ANA, null)).toBeNull();
  });

  it("an owner note on a dispatch approval is never acted on", async () => {
    const res = await applyMoves(db.client, { id: "x", organization_id: ORG, company_id: CO, short_code: 4, payload: {} } as never, { approved: true, ownerNote: "$700", decidedVia: "sms", decidedBy: OWNER }, "weather");
    expect(res).toEqual({ ok: false, message: "Nothing moved - #4 doesn't take an amount. Ask me again and reply just Y to move them." });
  });
});
