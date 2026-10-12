// ─────────────────────────────────────────────────────────────────────────────
// SANCTIONED EXCEPTION (service role): the public service-plan pages on a company's generated
// site (/s/<slug>/plans, /s/<slug>/plans/<id>, /s/<slug>/plans/renew/<token>) and their forms.
// No session. The company is resolved FROM THE SLUG ROW ONLY (status 'published'); a plan only
// renders when it's that company's and active; a renewal page only for the exact token of an
// agreement of that same company. Service plans must be on (CrankLeads org, switched on).
// docs/ai-staff.md → "Service plans".
// ─────────────────────────────────────────────────────────────────────────────
import { localDate } from "@/server/services/booking-windows";
import { isValidSlug, parseSiteContent } from "@/server/services/dfy/site-content";
import { turnstileSiteKey } from "@/server/services/dfy/site-public";
import { siteUrl } from "@/server/services/dfy/site-url";
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { toE164 } from "@/server/services/retell/payload";
import { defaultPlanDeps, publicSignup, renewAgreement, type PlanDeps } from "./agreements";
import { invoicePageUrl, invoiceStates, isPaid } from "./billing";
import type { Db, ServiceAgreementRow, ServicePlanRow } from "./db-types";
import { loadContact } from "./messages";
import { listPlans, loadPlan, planSchedule } from "./plans";
import { renderAlreadyOn, renderPlanPage, renderPlansList, renderRenewal, renderRequested, type PlansPageContext } from "./render";
import { addDaysYmd, longDate, termEndFor, termVisitDates } from "./schedule";
import { loadPlanCompany, type PlanCompany } from "./settings";
import { firstNameOf } from "./texts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[a-f0-9]{32}$/;

export interface PlansSite {
  company: PlanCompany;
  ctx: PlansPageContext;
}

export interface PublicPage {
  status: number;
  html: string | null;
  /** 303 to here instead (Stripe Checkout, or the invoice page). */
  redirect?: string | null;
}

/** The published site for a slug with Service plans on, or null (→ the neutral 404). */
export async function loadPlansSite(admin: AdminClient, slug: string): Promise<PlansSite | null> {
  const s = (slug ?? "").trim().toLowerCase();
  if (!isValidSlug(s)) return null;
  const { data, error } = await (admin as Db).from("company_sites").select("id, organization_id, company_id, slug, status, content").eq("slug", s).maybeSingle();
  if (error) throw new Error(`site read failed: ${error.message}`);
  const site = data as { organization_id: string; company_id: string; slug: string; status: string; content: unknown } | null;
  if (!site || site.status !== "published") return null;
  const content = parseSiteContent(site.content);
  if (!content) return null;
  const company = await loadPlanCompany(admin, site.organization_id, site.company_id);
  if (!company || !company.crankleads || !company.active || !company.settings.enabled) return null;
  return { company, ctx: { content, siteUrl: siteUrl(site.slug, content.facts.brand), turnstileSiteKey: turnstileSiteKey() } };
}

export async function plansListPage(admin: AdminClient, slug: string): Promise<PublicPage> {
  const site = await loadPlansSite(admin, slug);
  if (!site) return { status: 404, html: null };
  const plans = await listPlans(admin, site.company, { activeOnly: true });
  if (plans.length === 0) return { status: 404, html: null };
  return { status: 200, html: renderPlansList(site.ctx, plans) };
}

async function activePlan(admin: AdminClient, site: PlansSite, planId: string): Promise<ServicePlanRow | null> {
  if (!UUID_RE.test(planId)) return null;
  const plan = await loadPlan(admin, site.company, planId);
  return plan && plan.active ? plan : null;
}

export async function planPage(admin: AdminClient, slug: string, planId: string, deps: PlanDeps = defaultPlanDeps): Promise<PublicPage> {
  const site = await loadPlansSite(admin, slug);
  if (!site) return { status: 404, html: null };
  const plan = await activePlan(admin, site, planId);
  if (!plan) return { status: 404, html: null };
  const paysOnline = plan.billing === "annual" && (await deps.billing.stripeReady(site.company.companyId));
  return { status: 200, html: renderPlanPage(site.ctx, plan, { paysOnline }) };
}

const LIMITS = { name: 120, phone: 20, email: 254, address: 300 };
const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/;

function field(params: URLSearchParams, key: string, max: number): string {
  return (params.get(key) ?? "").split(String.fromCharCode(0)).join("").trim().slice(0, max);
}

export interface SignupForm {
  name: string;
  phone: string;
  email: string | null;
  address: string;
  smsConsent: boolean;
}

/** Form body → a checked sign-up, or the error to show. PURE. */
export function parseSignupForm(params: URLSearchParams): { form: SignupForm; values: Record<string, string> } | { error: string; values: Record<string, string> } {
  const values: Record<string, string> = {};
  for (const key of ["name", "phone", "email", "address", "smsConsent", "t"]) values[key] = field(params, key, (LIMITS as Record<string, number>)[key] ?? 40);
  const name = values.name.replace(/\s+/g, " ");
  if (name.length < 2 || /https?:|www\./i.test(name)) return { error: "Please enter your name.", values };
  const phone = toE164(values.phone);
  if (!phone || !/^\+1[2-9]\d{9}$/.test(phone)) return { error: "Please enter a 10-digit cell number.", values };
  if (values.email && !EMAIL_RE.test(values.email)) return { error: "That email doesn't look right - fix it or leave it blank.", values };
  const address = values.address.replace(/\s+/g, " ");
  if (address.length < 5 || /https?:|www\./i.test(address)) return { error: "Please enter the address where we'll do the work.", values };
  return { form: { name, phone, email: values.email ? values.email.toLowerCase() : null, address, smsConsent: values.smsConsent === "1" }, values };
}

/** The plan page again with an error (bot checks / rate limit / bad form), keeping what they typed. */
export async function planPageWithError(admin: AdminClient, slug: string, planId: string, params: URLSearchParams, error: string, status = 400, deps: PlanDeps = defaultPlanDeps): Promise<PublicPage> {
  const site = await loadPlansSite(admin, slug);
  if (!site) return { status: 404, html: null };
  const plan = await activePlan(admin, site, planId);
  if (!plan) return { status: 404, html: null };
  const values: Record<string, string> = {};
  for (const key of ["name", "phone", "email", "address", "smsConsent"]) values[key] = field(params, key, 300);
  const paysOnline = plan.billing === "annual" && (await deps.billing.stripeReady(site.company.companyId));
  return { status, html: renderPlanPage(site.ctx, plan, { values, error, paysOnline }) };
}

/** POST: the route already ran the rate limit, honeypot, timing and Turnstile checks. */
export async function signUpForPlan(admin: AdminClient, input: { slug: string; planId: string; params: URLSearchParams; nowMs: number }, deps: PlanDeps = defaultPlanDeps): Promise<PublicPage> {
  const site = await loadPlansSite(admin, input.slug);
  if (!site) return { status: 404, html: null };
  const plan = await activePlan(admin, site, input.planId);
  if (!plan) return { status: 404, html: null };
  const parsed = parseSignupForm(input.params);
  const paysOnline = plan.billing === "annual" && (await deps.billing.stripeReady(site.company.companyId));
  if ("error" in parsed) return { status: 400, html: renderPlanPage(site.ctx, plan, { values: parsed.values, error: parsed.error, paysOnline }) };
  const result = await publicSignup(admin, site.company, plan, parsed.form, input.nowMs, deps);
  switch (result.kind) {
    case "checkout":
      return { status: 303, html: null, redirect: result.url };
    case "requested":
      return { status: 200, html: renderRequested(site.ctx, plan, firstNameOf(parsed.form.name)) };
    case "already_active":
      return { status: 200, html: renderAlreadyOn(site.ctx, plan) };
    default:
      return { status: 400, html: renderPlanPage(site.ctx, plan, { values: parsed.values, error: result.error, paysOnline }) };
  }
}

// ── Renewal page ────────────────────────────────────────────────────────────

async function agreementByToken(admin: AdminClient, site: PlansSite, token: string): Promise<ServiceAgreementRow | null> {
  if (!TOKEN_RE.test(token)) return null;
  const { data, error } = await (admin as Db)
    .from("service_agreements")
    .select("*")
    .eq("organization_id", site.company.organizationId)
    .eq("company_id", site.company.companyId)
    .eq("renewal_token", token)
    .maybeSingle();
  if (error) throw error;
  return (data as ServiceAgreementRow | null) ?? null;
}

async function renewalPageFor(admin: AdminClient, site: PlansSite, token: string, agreement: ServiceAgreementRow, error?: string | null): Promise<string> {
  const contact = await loadContact(admin, site.company.organizationId, agreement.contact_id);
  const plan = await loadPlan(admin, site.company, agreement.plan_id);
  let nextVisit: string | null = null;
  let renewedThrough: string | null = null;
  if (agreement.term_end) {
    const start = addDaysYmd(agreement.term_end, 1);
    nextVisit = plan ? (termVisitDates({ ...planSchedule(plan), months: agreement.visit_months }, start, termEndFor(start))[0] ?? null) : null;
    renewedThrough = termEndFor(start);
  }
  return renderRenewal(site.ctx, token, { agreement, nextVisit, firstName: firstNameOf(contact?.first_name ?? agreement.customer_name), renewedThrough, error });
}

export async function renewalPage(admin: AdminClient, slug: string, token: string): Promise<PublicPage> {
  const site = await loadPlansSite(admin, slug);
  if (!site) return { status: 404, html: null };
  const agreement = await agreementByToken(admin, site, token);
  if (!agreement) return { status: 404, html: null };
  return { status: 200, html: await renewalPageFor(admin, site, token, agreement) };
}

/**
 * POST on the renewal page. Annual → the renewal invoice (issued once, reminders paused) → Stripe
 * Checkout (or its invoice page when the business can't take cards online); paid → the webhook /
 * payments sweep renews. Per visit → renewed right away (nothing to pay up front).
 */
export async function renewFromPage(admin: AdminClient, input: { slug: string; token: string; nowMs: number }, deps: PlanDeps = defaultPlanDeps): Promise<PublicPage> {
  const site = await loadPlansSite(admin, input.slug);
  if (!site) return { status: 404, html: null };
  const agreement = await agreementByToken(admin, site, input.token);
  if (!agreement) return { status: 404, html: null };
  if (agreement.status !== "active" && agreement.status !== "renewal_due") return { status: 200, html: await renewalPageFor(admin, site, input.token, agreement) };
  if (!agreement.term_end || !agreement.contact_id) return { status: 409, html: await renewalPageFor(admin, site, input.token, agreement, "This plan can't be renewed online - please text or call us.") };
  if (agreement.billing === "per_visit") {
    const result = await renewAgreement(admin, site.company, agreement, input.nowMs, deps);
    const fresh = (await agreementByToken(admin, site, input.token)) ?? agreement;
    return { status: result.ok || fresh.status === "renewed" ? 200 : 409, html: await renewalPageFor(admin, site, input.token, fresh, result.ok || fresh.status === "renewed" ? null : "Something went wrong - please try again.") };
  }
  const db = admin as Db;
  let invoiceId = agreement.pending_invoice_id;
  let token: string | null = null;
  if (invoiceId) {
    const state = (await invoiceStates(admin, site.company.organizationId, [invoiceId])).get(invoiceId);
    if (isPaid(state)) return { status: 200, html: await renewalPageFor(admin, site, input.token, agreement, "Your payment is in - your plan will show as renewed in a moment.") };
    if (!state || state.status === "void") invoiceId = null;
    else token = state.token;
  }
  if (!invoiceId) {
    const start = addDaysYmd(agreement.term_end, 1);
    const today = localDate(new Date(input.nowMs), site.company.timeZone);
    try {
      const issued = await deps.billing.issueTermInvoice(admin, {
        organizationId: site.company.organizationId,
        companyId: site.company.companyId,
        contactId: agreement.contact_id,
        title: `${agreement.plan_name} - service plan renewal`,
        lineLabel: `${agreement.plan_name} - service plan, 12 months`,
        lineDescription: `From ${longDate(start)} to ${longDate(termEndFor(start))}.`,
        priceCents: agreement.renewal_price_cents ?? agreement.price_cents,
        dueDate: agreement.term_end > today ? agreement.term_end : today,
        pauseReminders: true,
        internalNote: `Service plan renewal (agreement ${agreement.id}). Renews when this is paid.`,
      });
      const { data: linked } = await db
        .from("service_agreements")
        .update({ pending_invoice_id: issued.id })
        .eq("organization_id", site.company.organizationId)
        .eq("id", agreement.id)
        .or(invoiceId === null && agreement.pending_invoice_id ? `pending_invoice_id.eq.${agreement.pending_invoice_id}` : "pending_invoice_id.is.null")
        .select("id");
      if (((linked ?? []) as unknown[]).length === 0) {
        // A second tap issued one first: void ours and use theirs.
        await deps.billing.voidUnpaid(admin, site.company.organizationId, issued.id, "Duplicate renewal invoice.");
        const fresh = await agreementByToken(admin, site, input.token);
        const st = fresh?.pending_invoice_id ? (await invoiceStates(admin, site.company.organizationId, [fresh.pending_invoice_id])).get(fresh.pending_invoice_id) : undefined;
        token = st?.token ?? null;
      } else {
        token = issued.token;
      }
    } catch (err) {
      console.error("[service-plans] renewal invoice failed:", err instanceof Error ? err.message : err);
      return { status: 503, html: await renewalPageFor(admin, site, input.token, agreement, "We couldn't start the payment. Please try again in a few minutes.") };
    }
  }
  if (!token) return { status: 503, html: await renewalPageFor(admin, site, input.token, agreement, "We couldn't start the payment. Please try again in a few minutes.") };
  const online = await deps.billing.stripeReady(site.company.companyId);
  const url = (online ? await deps.billing.checkoutUrl(token) : null) ?? (await invoicePageUrl(admin, site.company.organizationId, site.company.companyId, token));
  return { status: 303, html: null, redirect: url };
}
