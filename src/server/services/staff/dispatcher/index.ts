/**
 * The Dispatcher (docs/ai-staff.md → "Dispatcher"): weather-aware rescheduling (the owner OKs the
 * batch), "on our way" texts, the crew's next-day schedule by text, and filling gaps when jobs
 * move. Approval kinds weather_reschedule / fill_gap / bulk_reschedule; owner tools
 * weather_outlook / crew_plan / move_day; five sweeps.
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { emptyRole, type StaffRoleModule, type StaffSweep } from "@/server/services/staff/types";
import { BULK_RESCHEDULE_KIND, FILL_GAP_KIND, WEATHER_RESCHEDULE_KIND } from "./approvals";
import { loadDispatchCompanies, type DispatchCompany } from "./company";
import { sweepCrewTexts } from "./crew-schedule";
import { executeFillGap, sweepFillGap } from "./fill-gap";
import { placesGeocoder } from "./geocode";
import { flushQueuedMessages } from "./messages";
import { applyMoves } from "./moves";
import { sweepOnOurWay } from "./on-our-way";
import { dispatcherOwnerTools } from "./owner-tools";
import { openMeteoProvider } from "./weather";
import { sweepWeather } from "./weather-sweep";

function byId(companies: DispatchCompany[]): Map<string, DispatchCompany> {
  return new Map(companies.map((c) => [c.companyId, c]));
}

const anyOn = (companies: DispatchCompany[], pick: (c: DispatchCompany) => boolean) => companies.some(pick);

async function withCompanies(admin: AdminClient, fn: (companies: DispatchCompany[]) => Promise<void>): Promise<void> {
  await fn(await loadDispatchCompanies(admin));
}

export const DISPATCHER_SWEEPS: StaffSweep[] = [
  {
    name: "dispatcher:on-our-way",
    intervalMs: 60_000,
    run: (admin, nowMs) => withCompanies(admin, (cs) => (anyOn(cs, (c) => c.settings.onOurWay.enabled) ? sweepOnOurWay(admin, nowMs, byId(cs)) : Promise.resolve())),
  },
  {
    name: "dispatcher:queue",
    intervalMs: 60_000,
    run: (admin, nowMs) => withCompanies(admin, async (cs) => void (await flushQueuedMessages(admin, nowMs, byId(cs)))),
  },
  {
    name: "dispatcher:fill-gap",
    intervalMs: 2 * 60_000,
    run: (admin, nowMs) => withCompanies(admin, (cs) => sweepFillGap(admin, nowMs, byId(cs))),
  },
  {
    name: "dispatcher:crew-texts",
    intervalMs: 5 * 60_000,
    run: (admin, nowMs) => withCompanies(admin, (cs) => sweepCrewTexts(admin, nowMs, cs)),
  },
  {
    name: "dispatcher:weather",
    intervalMs: 10 * 60_000,
    run: (admin, nowMs) => withCompanies(admin, (cs) => sweepWeather(admin, nowMs, cs, { provider: openMeteoProvider(), geocoder: placesGeocoder() })),
  },
];

export const dispatcherRole: StaffRoleModule = {
  ...emptyRole("dispatcher"),
  approvalExecutors: {
    [WEATHER_RESCHEDULE_KIND]: (admin, approval, decision) => applyMoves(admin, approval, decision, "weather"),
    [BULK_RESCHEDULE_KIND]: (admin, approval, decision) => applyMoves(admin, approval, decision, "bulk"),
    [FILL_GAP_KIND]: (admin, approval, decision) => executeFillGap(admin, approval, decision),
  },
  agentPromptNotes: [
    "Dispatcher texts: this business may have texted the customer that their visit was moved (weather or a schedule change), that the crew is on the way, or that an earlier spot opened up. If they reply about it: a moved visit they can't make, or an earlier spot they want, is changed with the booking link in that text (it shows the open times); you may check_availability to tell them what's open. Never say a spot is held for them, never move or cancel a booking yourself, and hand off to the owner if they're upset about a change.",
  ],
  ownerTools: dispatcherOwnerTools(),
  ownerPromptNotes: [
    "Weather and crew: use weather_outlook for weather questions about the schedule, crew_plan for who's working on a day. To move a whole day (\"move all of tomorrow to Friday\", \"rain day, push everything to Thursday\") use move_day: it only proposes — reply with its tell_owner_exactly text word for word (it carries the Y code). For one job, use propose_reschedule as usual.",
  ],
  sweeps: DISPATCHER_SWEEPS,
};
