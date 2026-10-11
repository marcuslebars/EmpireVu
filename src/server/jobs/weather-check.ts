/**
 * Live check of the Dispatcher's weather source (docs/ai-staff.md → Dispatcher → Weather).
 * Needs no keys and touches no database — run it anywhere with internet:
 *
 *   npx tsx src/server/jobs/weather-check.ts "Midland, ON"
 *   npx tsx src/server/jobs/weather-check.ts 44.75 -79.88
 *
 * Prints the Environment Canada forecast town it picked, how many hours it read, the next 48
 * hours in 6-hour steps, and whether a 9am–5pm job tomorrow would be flagged (default rules).
 */
import { environmentCanadaProvider, environmentCanadaTownGeocoder, EC_ATTRIBUTION } from "@/server/services/staff/dispatcher/environment-canada";
import { assessWindow } from "@/server/services/staff/dispatcher/weather";
import type { LatLng } from "@/server/services/staff/dispatcher/geocode";

const TZ = "America/Toronto";

function localHour(ms: number): string {
  return new Date(ms).toLocaleString("en-CA", { timeZone: TZ, weekday: "short", hour: "numeric", hour12: true });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let location: LatLng | null = null;
  if (args.length >= 2 && Number.isFinite(Number(args[0])) && Number.isFinite(Number(args[1]))) {
    location = { latitude: Number(args[0]), longitude: Number(args[1]) };
  } else {
    const town = args.join(" ").trim() || "Midland, ON";
    location = await environmentCanadaTownGeocoder().searchLocation(town);
    if (!location) throw new Error(`No Environment Canada forecast town called "${town}".`);
    console.log(`Town "${town}" → ${location.latitude}, ${location.longitude}`);
  }

  const forecast = await environmentCanadaProvider().forecast(location);
  const hours = forecast.hours;
  console.log(`Read ${hours.length} forecast hours: ${localHour(hours[0].timeMs)} → ${localHour(hours[hours.length - 1].timeMs)} (${TZ})`);
  for (const h of hours.filter((_, i) => i % 6 === 0).slice(0, 9)) {
    const mm = h.precipMm === null ? "" : `, ${h.precipMm} mm/h`;
    console.log(`  ${localHour(h.timeMs).padEnd(14)} rain ${h.precipProbability ?? "?"}%${mm}, wind ${h.windKmh ?? "?"} km/h, ${h.tempC ?? "?"}C`);
  }

  // Tomorrow 9am–5pm local.
  const now = new Date();
  const tomorrow = new Date(now.toLocaleString("en-US", { timeZone: TZ }));
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  const offsetMs = new Date(now.toLocaleString("en-US", { timeZone: TZ })).getTime() - now.getTime();
  const start = tomorrow.getTime() - offsetMs;
  const risk = assessWindow(forecast, start, start + 8 * 3_600_000, { rainProbability: 60, rainMm: 2, windKmh: 50, minTempC: -25, maxTempC: 35 });
  console.log(`A 9am-5pm job tomorrow: ${risk.covered ? (risk.atRisk ? `WOULD be flagged (${risk.reason})` : "fine") : "beyond the forecast"}`);
  console.log(EC_ATTRIBUTION);
}

main().catch((err) => {
  console.error("Weather check failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
