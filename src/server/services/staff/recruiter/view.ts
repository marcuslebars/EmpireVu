// ─────────────────────────────────────────────────────────────────────────────
// SANCTIONED EXCEPTION (service role): Settings → AI front desk → Hiring & payroll. The routes
// check org membership (owner/admin for writes and anything with hours or applicants) and that
// the company belongs to the org on the caller's RLS client FIRST; only then does this read or
// write that one company's rows with the service role. Settings writes merge ONLY
// ai_settings.recruiter (updateAiSettings, optimistic).
// ─────────────────────────────────────────────────────────────────────────────
import { localDate } from "@/server/services/booking-windows";
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { updateAiSettings } from "@/server/services/front-desk/ai-settings-write";
import type { Db } from "./db-types";
import { jobUrl, listJobs, publishedSiteSlug } from "./jobs";
import { addDays, periodContaining } from "./periods";
import { defaultPayrollDeps, recentPeriods, type PayrollDeps } from "./payroll";
import { loadRecruiterCompany, mergeRecruiterSettings, type RecruiterSettings, type RecruiterSettingsPatch } from "./settings";

export interface RecruiterPeriodView {
  id: string;
  start: string;
  end: string;
  status: string;
  people: number;
  totalMinutes: number;
  otMinutes: number;
  openEntries: number;
  lockedAt: string | null;
  lockedWithOpenEntries: boolean;
  unlockedAt: string | null;
  csvEmailedTo: string | null;
  csvEmailedAt: string | null;
  csvEmailError: string | null;
}

export interface RecruiterJobView {
  id: string;
  title: string;
  status: string;
  url: string | null;
  applicants: number;
  newApplicants: number;
  createdAt: string;
}

export interface RecruiterView {
  companyId: string;
  companyName: string;
  settings: RecruiterSettings;
  defaultEnabled: boolean;
  ownerPhoneOnFile: boolean;
  /** Where the CSV goes when no email is set (the org owner's), for display. */
  fallbackEmail: string | null;
  siteLive: boolean;
  currentPeriod: { start: string; end: string };
  /** The morning the current period's approval goes out. */
  nextAskOn: string;
  /** Owners/admins only (null for crew). */
  periods: RecruiterPeriodView[] | null;
  jobs: RecruiterJobView[] | null;
}

export async function getRecruiterView(
  admin: AdminClient,
  organizationId: string,
  companyId: string,
  options: { manager: boolean; nowMs?: number } = { manager: false },
  deps: Pick<PayrollDeps, "ownerEmail"> = defaultPayrollDeps,
): Promise<RecruiterView | null> {
  const company = await loadRecruiterCompany(admin, organizationId, companyId);
  if (!company) return null;
  const nowMs = options.nowMs ?? Date.now();
  const today = localDate(new Date(nowMs), company.timeZone);
  const current = periodContaining(today, company.settings.payroll.frequency, company.settings.payroll.anchorDate);
  const scope = { organizationId, companyId };
  const slug = await publishedSiteSlug(admin, scope).catch(() => null);
  let periods: RecruiterPeriodView[] | null = null;
  let jobs: RecruiterJobView[] | null = null;
  if (options.manager) {
    periods = (await recentPeriods(admin, scope)).map((p) => ({
      id: p.id,
      start: p.start_date,
      end: p.end_date,
      status: p.status,
      people: p.people,
      totalMinutes: p.total_minutes,
      otMinutes: p.ot_minutes,
      openEntries: p.open_entries,
      lockedAt: p.locked_at,
      lockedWithOpenEntries: p.locked_with_open_entries,
      unlockedAt: p.unlocked_at,
      csvEmailedTo: p.csv_emailed_to,
      csvEmailedAt: p.csv_emailed_at,
      csvEmailError: p.csv_email_error,
    }));
    const rows = await listJobs(admin, scope, ["awaiting_owner", "open", "closed"]);
    const counts = new Map<string, { all: number; fresh: number }>();
    if (rows.length) {
      const { data } = await (admin as Db)
        .from("job_applicants")
        .select("job_id, digest_at")
        .eq("organization_id", organizationId)
        .eq("company_id", companyId)
        .in("job_id", rows.map((j) => j.id))
        .limit(5000);
      for (const a of (data ?? []) as Array<{ job_id: string; digest_at: string | null }>) {
        const c = counts.get(a.job_id) ?? { all: 0, fresh: 0 };
        c.all += 1;
        if (!a.digest_at) c.fresh += 1;
        counts.set(a.job_id, c);
      }
    }
    jobs = rows.slice(0, 10).map((j) => ({
      id: j.id,
      title: j.title,
      status: j.status,
      url: j.status === "open" && slug ? jobUrl(slug, j.id, company.platformBrand) : null,
      applicants: counts.get(j.id)?.all ?? 0,
      newApplicants: counts.get(j.id)?.fresh ?? 0,
      createdAt: j.created_at,
    }));
  }
  return {
    companyId,
    companyName: company.name,
    settings: company.settings,
    defaultEnabled: company.settings.defaultEnabled,
    ownerPhoneOnFile: Boolean(company.ownerPhone),
    fallbackEmail: options.manager ? await deps.ownerEmail(admin, organizationId).catch(() => null) : null,
    siteLive: Boolean(slug),
    currentPeriod: current,
    nextAskOn: addDays(current.end, 1),
    periods,
    jobs,
  };
}

/** Merge ONLY ai_settings.recruiter; returns the fresh view (null → company not found). */
export async function updateRecruiter(admin: AdminClient, organizationId: string, companyId: string, patch: RecruiterSettingsPatch): Promise<RecruiterView | null> {
  const written = await updateAiSettings(admin, { organizationId, companyId }, (current) => mergeRecruiterSettings(current, patch));
  if (!written) return null;
  return getRecruiterView(admin, organizationId, companyId, { manager: true });
}
