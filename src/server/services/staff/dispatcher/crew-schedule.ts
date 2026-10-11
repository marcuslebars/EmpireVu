/**
 * Crew schedule texts: at 18:00 company time (setting crew_texts.time) each team member with a
 * cell on file (organization_memberships.phone_e164) gets tomorrow's jobs from the business
 * number — time, customer first name, job, short address and a map link. If their day changes
 * after that text (a job added, moved, cancelled, re-assigned, a new address), they get an
 * update with the new list (until 21:00, and again from 06:00 on the day itself).
 *
 * Transactional staff texts (no contact, no CASL consent); a member with no phone is skipped.
 * Idempotent: the first text is keyed `<profile>:<day>`, each update `<profile>:<day>:u<n>`,
 * and the list's fingerprint is stored so an unchanged day never re-texts.
 */
import { createHash } from "node:crypto";

import type { Tables } from "@/server/db/database.types";
import type { AdminClient } from "@/server/services/front-desk/contracts";
import type { DispatchCompany } from "./company";
import type { Db, DispatchMessageRow } from "./db-types";
import { firstName, jobPhrase, sendOrQueue } from "./messages";
import { addDays, dayLabel, hhmmToMinutes, localDate, localDayRange, localMinutes, timeLabel } from "./time";

export interface CrewJob {
  bookingId: string;
  startsAt: string;
  title: string;
  location: string | null;
  customerFirstName: string;
}

export interface CrewMemberPlan {
  profileId: string;
  name: string;
  phone: string | null;
  jobs: CrewJob[];
}

/** Crew texts only go out between these local times. */
export const CREW_TEXT_FROM = "06:00";
export const CREW_TEXT_UNTIL = "21:00";
const MAX_JOBS_LISTED = 8;

/** PURE: "12 Bay St" from "12 Bay St, Midland, ON L4R 1A1" (≤ 40 chars). */
export function shortAddress(location: string | null | undefined): string | null {
  const first = (location ?? "").split(",")[0]?.replace(/\s+/g, " ").trim();
  if (!first) return null;
  return first.length > 40 ? `${first.slice(0, 37).trimEnd()}...` : first;
}

/** PURE: a Google Maps link for an address. */
export function mapLink(location: string | null | undefined): string | null {
  const q = (location ?? "").replace(/\s+/g, " ").trim();
  return q ? `https://maps.google.com/?q=${encodeURIComponent(q).replace(/%20/g, "+")}` : null;
}

/** PURE: the day's identity — any change to which jobs, when, or where changes it. */
export function crewFingerprint(jobs: CrewJob[]): string {
  const canon = [...jobs]
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.bookingId.localeCompare(b.bookingId))
    .map((j) => `${j.bookingId}|${new Date(j.startsAt).toISOString()}|${(j.location ?? "").trim()}|${j.title.trim()}`)
    .join("\n");
  return createHash("sha256").update(canon).digest("hex").slice(0, 16);
}

/** PURE: the crew member's text (first one, or an update). */
export function crewScheduleText(input: { businessName: string; day: string; timeZone: string; jobs: CrewJob[]; update: boolean; tomorrow: boolean }): string {
  const when = `${input.tomorrow ? "tomorrow" : "today"} (${dayLabel(`${input.day}T12:00:00Z`, "UTC")})`;
  if (input.jobs.length === 0) return `${input.businessName} update: you're no longer on any jobs ${when}.`;
  const head = input.update ? `${input.businessName} update - your jobs ${when} changed:` : `${input.businessName} - your jobs ${when}:`;
  const sorted = [...input.jobs].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const lines = sorted.slice(0, MAX_JOBS_LISTED).map((j, i) => {
    const parts = [`${i + 1}) ${timeLabel(j.startsAt, input.timeZone)}`, j.customerFirstName || null, jobPhrase(j.title), shortAddress(j.location), mapLink(j.location)].filter(Boolean);
    return parts.join(" - ");
  });
  const more = sorted.length > MAX_JOBS_LISTED ? `\n+${sorted.length - MAX_JOBS_LISTED} more in the app.` : "";
  return `${head}\n${lines.join("\n")}${more}`;
}

/** Each team member's jobs on a local day (direct assignments + task assignees), with their phone. */
export async function crewPlanForDay(admin: AdminClient, company: Pick<DispatchCompany, "organizationId" | "companyId" | "timeZone">, day: string): Promise<{ members: CrewMemberPlan[]; unassigned: CrewJob[] }> {
  const db = admin as Db;
  const range = localDayRange(day, company.timeZone);
  const { data: bookingRows, error } = await db
    .from("bookings")
    .select("id, contact_id, title, scheduled_for, location, status")
    .eq("organization_id", company.organizationId)
    .eq("company_id", company.companyId)
    .in("status", ["pending", "confirmed"])
    .gte("scheduled_for", range.from.toISOString())
    .lt("scheduled_for", range.to.toISOString())
    .order("scheduled_for", { ascending: true })
    .limit(300);
  if (error) throw error;
  const bookings = (bookingRows ?? []) as Array<Pick<Tables<"bookings">, "id" | "contact_id" | "title" | "scheduled_for" | "location" | "status">>;
  const ids = bookings.map((b) => b.id);
  const contactIds = [...new Set(bookings.map((b) => b.contact_id).filter((x): x is string => Boolean(x)))];
  const [direct, tasks, contacts, memberships] = await Promise.all([
    ids.length ? db.from("booking_assignments").select("booking_id, profile_id").eq("organization_id", company.organizationId).in("booking_id", ids) : Promise.resolve({ data: [] }),
    ids.length
      ? db.from("tasks").select("booking_id, assigned_to_profile_id").eq("organization_id", company.organizationId).in("booking_id", ids).not("assigned_to_profile_id", "is", null)
      : Promise.resolve({ data: [] }),
    contactIds.length
      ? db.from("contacts").select("id, first_name").eq("organization_id", company.organizationId).eq("company_id", company.companyId).in("id", contactIds)
      : Promise.resolve({ data: [] }),
    db.from("organization_memberships").select("profile_id, phone_e164").eq("organization_id", company.organizationId).limit(500),
  ]);
  const crewOf = new Map<string, string[]>();
  const add = (bookingId: string | null, profileId: string | null) => {
    if (!bookingId || !profileId) return;
    const list = crewOf.get(bookingId) ?? [];
    if (!list.includes(profileId)) list.push(profileId);
    crewOf.set(bookingId, list);
  };
  for (const r of (direct.data ?? []) as Array<{ booking_id: string; profile_id: string }>) add(r.booking_id, r.profile_id);
  for (const r of (tasks.data ?? []) as Array<{ booking_id: string | null; assigned_to_profile_id: string | null }>) add(r.booking_id, r.assigned_to_profile_id);
  const firstOf = new Map(((contacts.data ?? []) as Array<{ id: string; first_name: string | null }>).map((c) => [c.id, firstName(c)]));
  const phoneOf = new Map(((memberships.data ?? []) as Array<{ profile_id: string; phone_e164: string | null }>).map((m) => [m.profile_id, m.phone_e164 ?? null]));

  const byMember = new Map<string, CrewJob[]>();
  const unassigned: CrewJob[] = [];
  for (const b of bookings) {
    const job: CrewJob = { bookingId: b.id, startsAt: b.scheduled_for, title: b.title, location: b.location, customerFirstName: b.contact_id ? firstOf.get(b.contact_id) ?? "" : "" };
    const crew = (crewOf.get(b.id) ?? []).filter((p) => phoneOf.has(p)); // only people still in the org
    if (crew.length === 0) unassigned.push(job);
    for (const p of crew) byMember.set(p, [...(byMember.get(p) ?? []), job]);
  }
  // Members who could have had jobs (phone on file) are included with an empty list, so a
  // member whose last job moved away gets the "no longer on any jobs" update.
  const profileIds = [...new Set([...byMember.keys(), ...[...phoneOf.entries()].filter(([, phone]) => Boolean(phone)).map(([p]) => p)])];
  const { data: profiles } = profileIds.length ? await db.from("profiles").select("id, full_name, email").in("id", profileIds) : { data: [] };
  const nameOf = new Map(((profiles ?? []) as Array<{ id: string; full_name: string | null; email: string | null }>).map((p) => [p.id, p.full_name?.trim() || p.email || "Team member"]));
  const members = profileIds.map((p) => ({ profileId: p, name: nameOf.get(p) ?? "Team member", phone: phoneOf.get(p) ?? null, jobs: byMember.get(p) ?? [] }));
  return { members, unassigned };
}

async function sentForDay(admin: AdminClient, company: Pick<DispatchCompany, "companyId">, profileId: string, day: string): Promise<DispatchMessageRow[]> {
  const { data } = await (admin as Db)
    .from("dispatch_messages")
    .select("*")
    .eq("company_id", company.companyId)
    .eq("profile_id", profileId)
    .in("kind", ["crew_schedule", "crew_update"])
    .like("dedupe_key", `${profileId}:${day}%`)
    .order("created_at", { ascending: true })
    .limit(50);
  return ((data ?? []) as DispatchMessageRow[]).filter((r) => r.status !== "failed" && r.status !== "skipped");
}

export interface CrewPassResult {
  sent: number;
  updates: number;
  noPhone: number;
}

/**
 * One company's crew pass for a day. `initial` = the 18:00 run for tomorrow (first texts + updates);
 * otherwise updates only (the morning of the day itself).
 */
export async function crewPassForDay(admin: AdminClient, company: DispatchCompany, day: string, nowMs: number, options: { initial: boolean; tomorrow: boolean }): Promise<CrewPassResult> {
  const result: CrewPassResult = { sent: 0, updates: 0, noPhone: 0 };
  const plan = await crewPlanForDay(admin, company, day);
  for (const member of plan.members) {
    if (!member.phone) {
      if (member.jobs.length > 0) result.noPhone++;
      continue;
    }
    const previous = await sentForDay(admin, company, member.profileId, day);
    const fingerprint = crewFingerprint(member.jobs);
    if (previous.length === 0) {
      if (!options.initial || member.jobs.length === 0) continue;
      const outcome = await sendOrQueue(
        admin,
        company,
        {
          kind: "crew_schedule",
          dedupeKey: `${member.profileId}:${day}`,
          to: member.phone,
          body: crewScheduleText({ businessName: company.businessName, day, timeZone: company.timeZone, jobs: member.jobs, update: false, tomorrow: options.tomorrow }),
          audience: "crew",
          profileId: member.profileId,
          payload: { day, fingerprint, bookingIds: member.jobs.map((j) => j.bookingId) },
        },
        nowMs,
      );
      if (outcome === "sent" || outcome === "queued") result.sent++;
      continue;
    }
    const last = previous[previous.length - 1];
    if (last.payload?.fingerprint === fingerprint) continue;
    const outcome = await sendOrQueue(
      admin,
      company,
      {
        kind: "crew_update",
        dedupeKey: `${member.profileId}:${day}:u${previous.length}`,
        to: member.phone,
        body: crewScheduleText({ businessName: company.businessName, day, timeZone: company.timeZone, jobs: member.jobs, update: true, tomorrow: options.tomorrow }),
        audience: "crew",
        profileId: member.profileId,
        payload: { day, fingerprint, bookingIds: member.jobs.map((j) => j.bookingId) },
      },
      nowMs,
    );
    if (outcome === "sent" || outcome === "queued") result.updates++;
  }
  return result;
}

/** Scheduler pass (every 5 minutes): tomorrow from crew_texts.time until 21:00; today's updates from 06:00. */
export async function sweepCrewTexts(admin: AdminClient, nowMs: number, companies: DispatchCompany[]): Promise<void> {
  for (const company of companies) {
    if (!company.settings.crewTexts.enabled) continue;
    const now = localMinutes(nowMs, company.timeZone);
    if (now < hhmmToMinutes(CREW_TEXT_FROM) || now >= hhmmToMinutes(CREW_TEXT_UNTIL)) continue;
    const today = localDate(new Date(nowMs), company.timeZone);
    try {
      if (now >= hhmmToMinutes(company.settings.crewTexts.time)) {
        await crewPassForDay(admin, company, addDays(today, 1), nowMs, { initial: true, tomorrow: true });
      }
      await crewPassForDay(admin, company, today, nowMs, { initial: false, tomorrow: false });
    } catch (err) {
      console.error("[dispatcher] crew texts failed", company.companyId, err instanceof Error ? err.message : err);
    }
  }
}
