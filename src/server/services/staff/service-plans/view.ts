// ─────────────────────────────────────────────────────────────────────────────
// SANCTIONED EXCEPTION (service role): Settings → AI front desk → Service plans. The route checks
// org membership (owner/admin for writes and for the customer list) and that the company belongs
// to the org on the caller's RLS client FIRST; only then does this read or write that one
// company's rows with the service role. Settings writes merge ONLY ai_settings.service_plans
// (updateAiSettings, optimistic). House orgs: read-only "not available", every write refused.
// ─────────────────────────────────────────────────────────────────────────────
import { localDate } from "@/server/services/booking-windows";
import { updateAiSettings } from "@/server/services/front-desk/ai-settings-write";
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { cancelAgreement, contactName, defaultPlanDeps, listAgreements, loadAgreement, type PlanDeps } from "./agreements";
import { CONTACT_COLUMNS, type Db, type PlanBilling, type PlanContact, type ServicePlanRow } from "./db-types";
import { plansPageUrl } from "./links";
import { createPlan, includedOf, listPlans, updatePlan, type PlanInput, type PlanPatch } from "./plans";
import { addDaysYmd } from "./schedule";
import { loadPlanCompany, mergeServicePlansSettings, RENEWAL_WINDOW_DAYS, type ServicePlansSettingsPatch } from "./settings";

export interface PlanView {
  id: string;
  name: string;
  description: string | null;
  priceCents: number;
  billing: PlanBilling;
  months: number[];
  weekday: number;
  week: number;
  timeOfDay: string;
  durationMinutes: number;
  included: string[];
  active: boolean;
  customers: number;
}

export interface AgreementView {
  id: string;
  customer: string;
  planName: string;
  status: string;
  billing: PlanBilling;
  priceCents: number;
  termStart: string | null;
  termEnd: string | null;
  nextVisit: string | null;
  renewalTexted: boolean;
}

export interface ServicePlansView {
  companyId: string;
  companyName: string;
  /** Done-for-you only: house orgs see nothing to set up. */
  available: boolean;
  settings: { enabled: boolean; headsUp: { enabled: boolean }; renewals: { enabled: boolean } };
  stripeReady: boolean;
  plansUrl: string | null;
  plans: PlanView[];
  counts: { active: number; renewingSoon: number; unpaidRenewals: number; lapsed: number; waiting: number; annualRevenueCents: number };
  /** Owners/admins only (null for crew). */
  agreements: AgreementView[] | null;
}

export class ServicePlansError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "ServicePlansError";
  }
}

function toPlanView(p: ServicePlanRow, customers: number): PlanView {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    priceCents: p.price_cents,
    billing: p.billing,
    months: p.visit_months,
    weekday: p.weekday,
    week: p.week_of_month,
    timeOfDay: p.time_of_day,
    durationMinutes: p.duration_minutes,
    included: includedOf(p),
    active: p.active,
    customers,
  };
}

export async function getServicePlansView(
  admin: AdminClient,
  organizationId: string,
  companyId: string,
  options: { manager: boolean; nowMs?: number },
  deps: PlanDeps = defaultPlanDeps,
): Promise<ServicePlansView | null> {
  const company = await loadPlanCompany(admin, organizationId, companyId);
  if (!company) return null;
  const base: ServicePlansView = {
    companyId,
    companyName: company.name,
    available: company.doneForYou,
    settings: { enabled: company.settings.enabled, headsUp: company.settings.headsUp, renewals: company.settings.renewals },
    stripeReady: false,
    plansUrl: null,
    plans: [],
    counts: { active: 0, renewingSoon: 0, unpaidRenewals: 0, lapsed: 0, waiting: 0, annualRevenueCents: 0 },
    agreements: null,
  };
  if (!company.doneForYou) return base;
  const nowMs = options.nowMs ?? Date.now();
  const today = localDate(new Date(nowMs), company.timeZone);
  const [plans, agreements, plansUrl, stripeReady] = await Promise.all([
    listPlans(admin, company),
    listAgreements(admin, company, undefined, 500),
    plansPageUrl(admin, company),
    deps.billing.stripeReady(companyId).catch(() => false),
  ]);
  const live = agreements.filter((a) => a.status === "active" || a.status === "renewal_due");
  const soon = addDaysYmd(today, RENEWAL_WINDOW_DAYS);
  base.stripeReady = stripeReady;
  base.plansUrl = plans.some((p) => p.active) ? plansUrl : null;
  base.plans = plans.map((p) => toPlanView(p, live.filter((a) => a.plan_id === p.id).length));
  base.counts = {
    active: live.length,
    renewingSoon: live.filter((a) => a.term_end && a.term_end <= soon && !a.renewed_by_agreement_id).length,
    unpaidRenewals: live.filter((a) => a.status === "renewal_due" && a.renewal_texted_at).length,
    lapsed: agreements.filter((a) => a.status === "lapsed").length,
    waiting: agreements.filter((a) => a.status === "pending_owner" || a.status === "pending_payment").length,
    annualRevenueCents: live.filter((a) => a.billing === "annual").reduce((s, a) => s + a.price_cents, 0),
  };
  if (options.manager) {
    const shown = agreements.filter((a) => a.status !== "renewed").slice(0, 100);
    const ids = [...new Set(shown.map((a) => a.contact_id).filter((v): v is string => !!v))];
    const { data: contacts } = ids.length ? await (admin as Db).from("contacts").select(CONTACT_COLUMNS).eq("organization_id", organizationId).in("id", ids) : { data: [] };
    const byId = new Map(((contacts ?? []) as PlanContact[]).map((c) => [c.id, c]));
    base.agreements = shown.map((a) => ({
      id: a.id,
      customer: contactName(a.contact_id ? (byId.get(a.contact_id) ?? null) : null, a.customer_name),
      planName: a.plan_name,
      status: a.status,
      billing: a.billing,
      priceCents: a.price_cents,
      termStart: a.term_start,
      termEnd: a.term_end,
      nextVisit: (a.visit_dates ?? []).find((d) => d >= today) ?? null,
      renewalTexted: Boolean(a.renewal_texted_at),
    }));
  }
  return base;
}

async function requireAvailable(admin: AdminClient, organizationId: string, companyId: string) {
  const company = await loadPlanCompany(admin, organizationId, companyId);
  if (!company) throw new ServicePlansError("Company not found.", 404);
  if (!company.doneForYou) throw new ServicePlansError("Service plans aren't available for this business.", 403);
  return company;
}

export async function updateServicePlansSettings(admin: AdminClient, organizationId: string, companyId: string, patch: ServicePlansSettingsPatch): Promise<ServicePlansView | null> {
  await requireAvailable(admin, organizationId, companyId);
  const written = await updateAiSettings(admin, { organizationId, companyId }, (current) => mergeServicePlansSettings(current, patch) as typeof current);
  if (!written) return null;
  return getServicePlansView(admin, organizationId, companyId, { manager: true });
}

export type ServicePlansAction =
  | { action: "create_plan"; plan: PlanInput }
  | { action: "update_plan"; planId: string; plan: PlanPatch }
  | { action: "cancel_agreement"; agreementId: string };

export async function runServicePlansAction(
  admin: AdminClient,
  organizationId: string,
  companyId: string,
  actorProfileId: string | null,
  input: ServicePlansAction,
  deps: PlanDeps = defaultPlanDeps,
  nowMs: number = Date.now(),
): Promise<{ view: ServicePlansView | null; message: string }> {
  const company = await requireAvailable(admin, organizationId, companyId);
  const scope = { organizationId, companyId };
  let message: string;
  switch (input.action) {
    case "create_plan": {
      const plan = await createPlan(admin, scope, input.plan, actorProfileId);
      message = `Created ${plan.name}.`;
      break;
    }
    case "update_plan": {
      const plan = await updatePlan(admin, scope, input.planId, input.plan);
      if (!plan) throw new ServicePlansError("Plan not found.", 404);
      message = `Saved ${plan.name}. Customers already on it keep what they signed up for until they renew.`;
      break;
    }
    case "cancel_agreement": {
      const agreement = await loadAgreement(admin, scope, input.agreementId);
      if (!agreement) throw new ServicePlansError("Agreement not found.", 404);
      const result = await cancelAgreement(admin, company, agreement, "cancelled in Settings", nowMs, deps);
      if (!result.ok) throw new ServicePlansError("That plan isn't open any more.", 409);
      message = result.removed ? `Cancelled. ${result.removed} upcoming visit${result.removed === 1 ? "" : "s"} came off the calendar.` : "Cancelled.";
      break;
    }
  }
  return { view: await getServicePlansView(admin, organizationId, companyId, { manager: true, nowMs }, deps), message };
}
