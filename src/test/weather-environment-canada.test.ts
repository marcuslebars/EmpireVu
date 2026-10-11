import { beforeEach, describe, expect, it } from "vitest";

import {
  clearEcSiteCache,
  EC_SITE_LIST_URL,
  environmentCanadaProvider,
  environmentCanadaTownGeocoder,
  latestFileForSite,
  nearestSite,
  parseCitypageXml,
  parseEcUtcStamp,
  parseSiteList,
  townLocation,
} from "@/server/services/staff/dispatcher/environment-canada";
import { assessWindow } from "@/server/services/staff/dispatcher/weather";

const HOUR = 3_600_000;

// The site list as Environment Canada publishes it: a title line, then the header.
const SITE_CSV = `Site Names,,,,,
Codes,English Names,Province Codes,Latitude,Longitude,Nom français
s0000458,Toronto,ON,43.74N,79.37W,Toronto
s0000105,Midland,ON,44.75N,79.88W,Midland
s0000430,Orillia,ON,44.61N,79.42W,Orillia
s0000635,Midland,BC,49.10N,122.10W,Midland
s0000999,Bad Row,ON,,79.00W,Bad
`;

// A citypage document in the published layout (abridged): issued Sun Oct 11 2026 15:30 EDT.
const XML = `<?xml version="1.0" encoding="UTF-8"?>
<siteData>
  <location><name code="s0000105">Midland</name><province code="ON">Ontario</province></location>
  <forecastGroup>
    <dateTime name="forecastIssue" zone="UTC" UTCOffset="0"><year>2026</year><timeStamp>20261011193000</timeStamp></dateTime>
    <dateTime name="forecastIssue" zone="EDT" UTCOffset="-4"><year>2026</year><timeStamp>20261011153000</timeStamp></dateTime>
    <forecast>
      <period textForecastName="Tonight">Sunday night</period>
      <abbreviatedForecast><iconCode format="gif">33</iconCode><pop units="%"></pop><textSummary>Clear</textSummary></abbreviatedForecast>
      <temperatures><temperature unitType="metric" units="C" class="low">4</temperature></temperatures>
      <winds><wind index="1" rank="major"><speed unitType="metric" units="km/h">10</speed><gust unitType="metric" units="km/h"></gust></wind></winds>
    </forecast>
    <forecast>
      <period textForecastName="Monday">Monday</period>
      <abbreviatedForecast><iconCode format="gif">12</iconCode><pop units="%">90</pop><textSummary>Rain</textSummary></abbreviatedForecast>
      <temperatures><temperature unitType="metric" units="C" class="high">11</temperature></temperatures>
      <winds><wind index="1" rank="major"><speed unitType="metric" units="km/h">30</speed><gust unitType="metric" units="km/h">60</gust></wind></winds>
      <precipitation><precipType start="" end="">rain</precipType><accumulation><name>rain</name><amount unitType="metric" units="mm">15</amount></accumulation></precipitation>
    </forecast>
    <forecast>
      <period textForecastName="Monday night">Monday night</period>
      <abbreviatedForecast><pop units="%">40</pop></abbreviatedForecast>
      <temperatures><temperature unitType="metric" units="C" class="low">2</temperature></temperatures>
    </forecast>
    <forecast>
      <period textForecastName="Tuesday">Tuesday</period>
      <abbreviatedForecast><pop units="%"></pop></abbreviatedForecast>
      <temperatures><temperature unitType="metric" units="C" class="high">9</temperature></temperatures>
      <precipitation><accumulation><name>snow</name><amount unitType="metric" units="cm">2</amount></accumulation></precipitation>
    </forecast>
  </forecastGroup>
  <hourlyForecastGroup>
    <dateTime name="forecastIssue" zone="UTC" UTCOffset="0"><timeStamp>20261011193000</timeStamp></dateTime>
    <hourlyForecast dateTimeUTC="202610112000"><condition>Clear</condition><temperature unitType="metric" units="C">9</temperature><lop category="Nil" units="%">0</lop><wind><speed unitType="metric" units="km/h">10</speed><direction windDirFull="West">W</direction><gust unitType="metric" units="km/h"></gust></wind></hourlyForecast>
    <hourlyForecast dateTimeUTC="202610112100"><condition>Clear</condition><temperature unitType="metric" units="C">8</temperature><lop category="Low" units="%">10</lop><wind><speed unitType="metric" units="km/h">15</speed><gust unitType="metric" units="km/h">40</gust></wind></hourlyForecast>
  </hourlyForecastGroup>
</siteData>`;

const LISTING = `<html><body><pre>
<a href="20261011T183012.4Z_MSC_CitypageWeather_s0000105_en.xml">20261011T183012.4Z_MSC_CitypageWeather_s0000105_en.xml</a>
<a href="20261011T193059.9Z_MSC_CitypageWeather_s0000105_en.xml">20261011T193059.9Z_MSC_CitypageWeather_s0000105_en.xml</a>
<a href="20261011T193059.9Z_MSC_CitypageWeather_s0000105_fr.xml">fr</a>
<a href="20261011T193100.0Z_MSC_CitypageWeather_s0000458_en.xml">toronto</a>
</pre></body></html>`;

beforeEach(() => clearEcSiteCache());

describe("Environment Canada: site list", () => {
  it("parses the published CSV (title line, N/W coordinates) and skips bad rows", () => {
    const sites = parseSiteList(SITE_CSV);
    expect(sites.map((s) => s.code)).toEqual(["s0000458", "s0000105", "s0000430", "s0000635"]);
    expect(sites[1]).toEqual({ code: "s0000105", name: "Midland", province: "ON", latitude: 44.75, longitude: -79.88 });
  });

  it("picks the nearest forecast town, and none when nothing is within 150 km", () => {
    const sites = parseSiteList(SITE_CSV);
    expect(nearestSite(sites, { latitude: 44.73, longitude: -79.9 })?.name).toBe("Midland");
    expect(nearestSite(sites, { latitude: 44.6, longitude: -79.45 })?.name).toBe("Orillia");
    expect(nearestSite(sites, { latitude: 60, longitude: -100 })).toBeNull();
  });

  it("finds the town in an address or service area (Ontario first) without Google", () => {
    const sites = parseSiteList(SITE_CSV);
    expect(townLocation(sites, "123 King St, Midland, ON L4R 1A1")).toEqual({ latitude: 44.75, longitude: -79.88 });
    expect(townLocation(sites, "Orillia, Ontario")).toEqual({ latitude: 44.61, longitude: -79.42 });
    expect(townLocation(sites, "Somewhere Else")).toBeNull();
  });
});

describe("Environment Canada: files", () => {
  it("picks the newest English file for the site from a directory listing", () => {
    expect(latestFileForSite(LISTING, "s0000105")).toBe("20261011T193059.9Z_MSC_CitypageWeather_s0000105_en.xml");
    expect(latestFileForSite(LISTING, "s0000430")).toBeNull();
  });

  it("parses UTC stamps", () => {
    expect(parseEcUtcStamp("202610112000")).toBe(Date.UTC(2026, 9, 11, 20, 0));
    expect(parseEcUtcStamp("20261011193000")).toBe(Date.UTC(2026, 9, 11, 19, 30));
    expect(parseEcUtcStamp("nope")).toBeNull();
  });
});

describe("Environment Canada: forecast XML → hours", () => {
  const hours = parseCitypageXml(XML);
  const at = (iso: string) => hours.find((h) => h.timeMs === Date.parse(iso));

  it("takes the hourly group first (probability, gust over speed, no amounts)", () => {
    expect(at("2026-10-11T20:00:00Z")).toEqual({ timeMs: Date.parse("2026-10-11T20:00:00Z"), precipProbability: 0, precipMm: null, windKmh: 10, tempC: 9 });
    expect(at("2026-10-11T21:00:00Z")?.windKmh).toBe(40);
  });

  it("spreads day/night periods over local hours after the hourly group (EDT, day 06-18)", () => {
    // Monday 06:00-18:00 EDT = 10:00-22:00Z: 90% PoP, 15 mm rain over 12 h, 60 km/h gusts.
    const mon10 = at("2026-10-12T14:00:00Z");
    expect(mon10).toMatchObject({ precipProbability: 90, precipMm: 1.25, windKmh: 60, tempC: 11 });
    expect(at("2026-10-12T09:00:00Z")?.precipProbability).toBe(0); // still Sunday night (empty PoP)
    expect(at("2026-10-12T22:00:00Z")?.precipProbability).toBe(40); // Monday night
    // Snow in cm is not rain; empty PoP → 0.
    expect(at("2026-10-13T14:00:00Z")).toMatchObject({ precipProbability: 0, precipMm: null, tempC: 9 });
    // Ascending, unique hours, nothing before the hourly group starts.
    const times = hours.map((h) => h.timeMs);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(new Set(times).size).toBe(times.length);
    expect(Math.min(...times)).toBe(Date.parse("2026-10-11T20:00:00Z"));
  });

  it("is safe on junk", () => {
    expect(parseCitypageXml("<not xml")).toEqual([]);
    expect(parseCitypageXml("<siteData/>")).toEqual([]);
  });

  it("drives the job-window rule: Monday's rain is caught, Sunday evening isn't", () => {
    const forecast = { latitude: 44.75, longitude: -79.88, fetchedAtMs: 0, hours };
    const t = { rainProbability: 60, rainMm: 2, windKmh: 50, minTempC: -25, maxTempC: 35 };
    const monday = assessWindow(forecast, Date.parse("2026-10-12T13:00:00Z"), Date.parse("2026-10-12T16:00:00Z"), t);
    expect(monday).toMatchObject({ atRisk: true, kinds: ["rain", "wind"] });
    expect(monday.reason).toBe("rain 90%, 3.8 mm, wind 60 km/h");
    const sunday = assessWindow(forecast, Date.parse("2026-10-11T20:00:00Z"), Date.parse("2026-10-11T22:00:00Z"), t);
    expect(sunday.atRisk).toBe(false);
  });

  it("probability alone decides when the hours carry no amounts", () => {
    const start = Date.parse("2026-10-11T20:00:00Z");
    const forecast = { latitude: 0, longitude: 0, fetchedAtMs: 0, hours: [{ timeMs: start, precipProbability: 80, precipMm: null, windKmh: 10, tempC: 10 }] };
    const r = assessWindow(forecast, start, start + HOUR, { rainProbability: 60, rainMm: 2, windKmh: 50, minTempC: -25, maxTempC: 35 });
    expect(r).toMatchObject({ atRisk: true, kinds: ["rain"], reason: "rain 80%" });
  });
});

describe("Environment Canada: provider end to end (fetch faked)", () => {
  function fakeFetch(routes: Record<string, string | number>) {
    const calls: string[] = [];
    const impl = async (url: string) => {
      calls.push(url);
      const body = routes[url];
      if (body === undefined || typeof body === "number") return new Response("nope", { status: typeof body === "number" ? body : 404 });
      return new Response(body, { status: 200 });
    };
    return { impl, calls };
  }
  const now = Date.parse("2026-10-11T19:45:00Z");
  const dir = (hh: string) => `https://dd.weather.gc.ca/today/citypage_weather/ON/${hh}/`;

  it("site list → nearest town → newest file in this hour's directory → hours", async () => {
    const { impl, calls } = fakeFetch({
      [EC_SITE_LIST_URL]: SITE_CSV,
      [dir("19")]: LISTING,
      [`${dir("19")}20261011T193059.9Z_MSC_CitypageWeather_s0000105_en.xml`]: XML,
    });
    const forecast = await environmentCanadaProvider(impl, () => now).forecast({ latitude: 44.74, longitude: -79.9 });
    expect(forecast.hours.length).toBeGreaterThan(30);
    expect(calls).toContain(`${dir("19")}20261011T193059.9Z_MSC_CitypageWeather_s0000105_en.xml`);
  });

  it("falls back to earlier hours' directories, and caches the site list", async () => {
    const { impl, calls } = fakeFetch({
      [EC_SITE_LIST_URL]: SITE_CSV,
      [dir("19")]: "<html>no files yet</html>",
      [dir("18")]: LISTING.replace(/T193059\.9Z_MSC_CitypageWeather_s0000105_en/g, "T183012.4Z_MSC_CitypageWeather_s0000105_en"),
      [`${dir("18")}20261011T183012.4Z_MSC_CitypageWeather_s0000105_en.xml`]: XML,
    });
    const provider = environmentCanadaProvider(impl, () => now);
    await provider.forecast({ latitude: 44.74, longitude: -79.9 });
    await provider.forecast({ latitude: 44.74, longitude: -79.9 });
    expect(calls.filter((c) => c === EC_SITE_LIST_URL)).toHaveLength(1);
  });

  it("fails loudly (no invented forecast) when nothing is published or the town is too far", async () => {
    const { impl } = fakeFetch({ [EC_SITE_LIST_URL]: SITE_CSV });
    await expect(environmentCanadaProvider(impl, () => now).forecast({ latitude: 44.74, longitude: -79.9 })).rejects.toThrow(/No recent/);
    await expect(environmentCanadaProvider(impl, () => now).forecast({ latitude: 60, longitude: -100 })).rejects.toThrow(/No Environment Canada forecast town/);
  });

  it("the town geocoder works from the same list", async () => {
    const { impl } = fakeFetch({ [EC_SITE_LIST_URL]: SITE_CSV });
    const geo = environmentCanadaTownGeocoder(impl, () => now);
    expect(await geo.placeLocation()).toBeNull();
    expect(await geo.searchLocation("Midland, Ontario")).toEqual({ latitude: 44.75, longitude: -79.88 });
  });
});

describe("job-window rain rule with mixed sources", () => {
  const t = { rainProbability: 60, rainMm: 2, windKmh: 50, minTempC: -25, maxTempC: 35 };
  const start = Date.parse("2026-10-12T19:00:00Z");
  it("a window straddling the hourly forecast (no amounts) and a period (small share) is still rainy", () => {
    const forecast = {
      latitude: 0,
      longitude: 0,
      fetchedAtMs: 0,
      hours: [
        { timeMs: start, precipProbability: 90, precipMm: null, windKmh: 10, tempC: 10 },
        { timeMs: start + HOUR, precipProbability: 90, precipMm: 1.25, windKmh: 10, tempC: 10 },
      ],
    };
    expect(assessWindow(forecast, start, start + 2 * HOUR, t)).toMatchObject({ atRisk: true, kinds: ["rain"], reason: "rain 90%" });
  });
  it("when every likely-rain hour has an amount, a light total clears it", () => {
    const forecast = { latitude: 0, longitude: 0, fetchedAtMs: 0, hours: [{ timeMs: start, precipProbability: 90, precipMm: 0.5, windKmh: 10, tempC: 10 }] };
    expect(assessWindow(forecast, start, start + HOUR, t).atRisk).toBe(false);
  });
});
