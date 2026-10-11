/**
 * The morning briefing sweep (docs/ai-staff.md → "Office manager"): one text a day to the owner's
 * VERIFIED cell, from the platform number (sendOwnerSms), at the set local time (default 07:00)
 * on the set days (default Monday–Saturday).
 *
 * Exactly once per company per local date: owner_briefings is unique on (company_id,
 * local_date), and the row is inserted (claimed) BEFORE anything is read or sent, so
 * overlapping workers send one text. A failed send releases the claim (status 'failed'); a later
 * pass re-claims it (conditional update on status + attempts — one winner) after RETRY_AFTER_MS,
 * up to MAX_ATTEMPTS, and only before 11:00 local. A platform opt-out is final for the day.
 *
 * The Bookkeeper's 08:00 money alert stands down on briefing days (bookkeeper/daily-alert.ts
 * briefingTakesMoneyAlert); its untold items ride in the briefing and are marked reported only
 * once the briefing went out (only the ones that fit).
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { ctxFor, sendOwnerSms, signaturePrefix } from "@/server/services/owner-channel/common";
import { markMoneyAlertReported } from "@/server/services/staff/bookkeeper/daily-alert";
import { chunks } from "@/server/services/staff/bookkeeper/settings";
import { deliverMessage, resolveOwnerContacts } from "@/server/services/workflow-engine/messaging";
import { composeBriefing, MAX_BRIEFING_SEPTETS, septets, type ComposedBriefing } from "./compose";
import type { Db, OwnerBriefingRow } from "./db-types";
import { renderBriefingEmail } from "./email";
import { defaultBriefingDeps, gatherBriefing, type BriefingDeps, type GatheredBriefing } from "./gather";
import { briefingDue, loadBriefingCompanies, type BriefingCompany } from "./settings";
import { localDate } from "@/server/services/staff/dispatcher/time";

export const SWEEP_INTERVAL_MS = 2 * 60_000;
export const RETRY_AFTER_MS = 10 * 60_000;
export const MAX_ATTEMPTS = 3;

export interface BriefingOutcome {
  companyId: string;
  status: "sent" | "failed" | "skipped" | "claimed_elsewhere" | "no_owner_phone";
  body?: string;
}

/** The text for a company now (shared by the sweep and briefing_now). */
export function composeFor(company: BriefingCompany, gathered: GatheredBriefing): ComposedBriefing {
  return composeBriefing({ ...gathered.input, maxSeptets: MAX_BRIEFING_SEPTETS - septets(signaturePrefix(company.platformBrand)) });
}

/** Claim today's row: insert, or re-claim a failed one that is due a retry. Null → someone else has it. */
export async function claimBriefingDay(admin: AdminClient, company: BriefingCompany, today: string, nowMs: number): Promise<OwnerBriefingRow | null> {
  const db = admin as Db;
  const nowIso = new Date(nowMs).toISOString();
  const { data, error } = await db
    .from("owner_briefings")
    .insert({ organization_id: company.organizationId, company_id: company.companyId, local_date: today, status: "claimed", attempts: 1, last_attempt_at: nowIso })
    .select("*")
    .single();
  if (!error && data) return data as OwnerBriefingRow;
  const existing = await db
    .from("owner_briefings")
    .select("*")
    .eq("organization_id", company.organizationId)
    .eq("company_id", company.companyId)
    .eq("local_date", today)
    .maybeSingle();
  const row = existing.data as OwnerBriefingRow | null;
  if (!row || !retryable(row, nowMs)) return null;
  const { data: reclaimed } = await db
    .from("owner_briefings")
    .update({ status: "claimed", attempts: row.attempts + 1, last_attempt_at: nowIso, last_error: null })
    .eq("id", row.id)
    .eq("organization_id", company.organizationId)
    .eq("status", "failed")
    .eq("attempts", row.attempts)
    .select("*");
  return ((reclaimed ?? []) as OwnerBriefingRow[])[0] ?? null;
}

/** A failed send, under the attempt cap, at least RETRY_AFTER_MS since the last try. PURE. */
export function retryable(row: Pick<OwnerBriefingRow, "status" | "attempts" | "last_attempt_at">, nowMs: number): boolean {
  if (row.status !== "failed" || row.attempts >= MAX_ATTEMPTS) return false;
  const last = row.last_attempt_at ? Date.parse(row.last_attempt_at) : 0;
  return nowMs - last >= RETRY_AFTER_MS;
}

async function sendEmailCopy(admin: AdminClient, company: BriefingCompany, gathered: GatheredBriefing, text: string): Promise<string> {
  const context = ctxFor(admin, company.organizationId);
  const owner = await resolveOwnerContacts(context, { owner_email: company.ownerEmail, owner_phone_e164: company.ownerPhone }, { allowPlatformFallback: false });
  if (!owner.email) return "no_email";
  const email = renderBriefingEmail({ businessName: company.name, dayLabel: gathered.input.dayLabel, briefing: text, details: gathered.details });
  const result = await deliverMessage({ context, channel: "email", to: owner.email, subject: email.subject, body: email.text, html: email.html, companyId: company.companyId, contactId: null, consentContact: null,
    // Never "EmpireVu" for a CrankLeads org; a house org sees its own name.
    fromName: company.crankleads ? "CrankLeads" : company.name });
  return result.status;
}

/** Today's briefing for one company (claim → read → compose → send → record). Never throws. */
export async function runCompanyBriefing(admin: AdminClient, company: BriefingCompany, nowMs: number, deps: BriefingDeps = defaultBriefingDeps): Promise<BriefingOutcome> {
  if (!company.ownerPhone) return { companyId: company.companyId, status: "no_owner_phone" };
  const db = admin as Db;
  const today = localDate(new Date(nowMs), company.timeZone);
  const claim = await claimBriefingDay(admin, company, today, nowMs).catch(() => null);
  if (!claim) return { companyId: company.companyId, status: "claimed_elsewhere" };
  const finish = (patch: Record<string, unknown>) => db.from("owner_briefings").update(patch).eq("id", claim.id).eq("organization_id", company.organizationId).eq("status", "claimed");
  try {
    const gathered = await gatherBriefing(admin, company, nowMs, deps, { fold: true });
    const composed = composeFor(company, gathered);
    const sent = await sendOwnerSms(admin, { to: company.ownerPhone, body: composed.text, organizationId: company.organizationId, companyId: company.companyId, platformBrand: company.platformBrand });
    if (sent.status !== "sent") {
      // Blocked (the owner texted STOP to the platform number): final for today. Failed: release for a retry.
      await finish({ status: sent.status === "blocked" ? "skipped" : "failed", body: composed.text, last_error: sent.reason ?? sent.status });
      return { companyId: company.companyId, status: sent.status === "blocked" ? "skipped" : "failed", body: composed.text };
    }
    let moneyItems: string[] = [];
    if (gathered.fold) {
      const reported = gathered.fold.groups.slice(0, composed.foldIncluded).flatMap((g) => g.entries);
      try {
        moneyItems = await markMoneyAlertReported(admin, gathered.fold.ctx, nowMs, { entries: gathered.fold.entries, fresh: gathered.fold.fresh, reported, body: composed.text });
      } catch (err) {
        console.error("[office-manager] marking money items failed", company.companyId, err instanceof Error ? err.message : err);
      }
    }
    let emailStatus: string | null = null;
    if (company.settings.channels.includes("email")) {
      emailStatus = await sendEmailCopy(admin, company, gathered, composed.text).catch((err) => {
        console.error("[office-manager] email copy failed", company.companyId, err instanceof Error ? err.message : err);
        return "failed";
      });
    }
    await finish({ status: "sent", body: composed.text, sent_at: new Date(nowMs).toISOString(), money_items: moneyItems, email_status: emailStatus });
    return { companyId: company.companyId, status: "sent", body: composed.text };
  } catch (err) {
    await finish({ status: "failed", last_error: err instanceof Error ? err.message : String(err) });
    return { companyId: company.companyId, status: "failed" };
  }
}

/** Today's rows for these companies, one read per chunk (so done companies cost nothing per pass). */
async function rowsForToday(admin: AdminClient, due: Array<{ company: BriefingCompany; today: string }>): Promise<Map<string, OwnerBriefingRow>> {
  const out = new Map<string, OwnerBriefingRow>();
  for (const part of chunks(due)) {
    const dates = [...new Set(part.map((d) => d.today))];
    const { data, error } = await (admin as Db)
      .from("owner_briefings")
      .select("id, company_id, local_date, status, attempts, last_attempt_at")
      .in("company_id", part.map((d) => d.company.companyId))
      .in("local_date", dates);
    if (error) throw error;
    for (const r of (data ?? []) as OwnerBriefingRow[]) {
      const mine = part.find((d) => d.company.companyId === r.company_id);
      if (mine && mine.today === r.local_date) out.set(r.company_id, r);
    }
  }
  return out;
}

/** Scheduler pass: every company whose briefing is due now (set time → 11:00 local, briefing day). */
export async function runMorningBriefings(admin: AdminClient, nowMs: number = Date.now(), deps: BriefingDeps = defaultBriefingDeps): Promise<BriefingOutcome[]> {
  const due = (await loadBriefingCompanies(admin))
    .filter((c) => c.ownerPhone && briefingDue(c.settings, nowMs, c.timeZone))
    .map((company) => ({ company, today: localDate(new Date(nowMs), company.timeZone) }));
  if (due.length === 0) return [];
  const existing = await rowsForToday(admin, due);
  const outcomes: BriefingOutcome[] = [];
  for (const { company } of due) {
    const row = existing.get(company.companyId);
    if (row && !retryable(row, nowMs)) continue;
    try {
      outcomes.push(await runCompanyBriefing(admin, company, nowMs, deps));
    } catch (err) {
      console.error("[office-manager] briefing failed", company.companyId, err instanceof Error ? err.message : err);
    }
  }
  return outcomes;
}
