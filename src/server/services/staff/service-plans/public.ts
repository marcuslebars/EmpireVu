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
import { defaultPlanDeps, publicSignup, REACTIVATE_DAYS, renewAgreement, type PlanDeps } from "./agreements";
import { invoicePageUrl, invoiceStates, isPaid } from "./billing";
import type { Db, ServiceAgreementRow, ServicePlanRow } from "./db-types";
import { loadContact } from "./messages";
import { listPlans, loadPlan, planSchedule } from "./plans";
import { renderPlanPage, renderPaid, renderPlansList, renderRenewal, renderRequested, type PlansPageContext } from "./render";
import { addDaysYmd, longDate, termEndFor, termVisitDates } from "./schedule";
import { LAPSE_GRACE_DAYS, loadPlanCompany, type PlanCompany } from "./settings";
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
  if (!company || !company.doneForYou || !company.active || !company.settings.enabled) return null;
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

export async function planPage(admin: AdminClient, slug: string, planId: string, deps: PlanDeps = defaultPlanDeps, opts: { paid?: boolean } = {}): Promise<PublicPage> {
  const site = await loadPlansSite(admin, slug);
  if (!site) return { status: 404, html: null };
  const plan = await activePlan(admin, site, planId);
  if (!plan) return { status: 404, html: null };
  // Back from Checkout: the webhook starts the plan and texts them.
  if (opts.paid) return { status: 200, html: renderPaid(site.ctx, plan) };
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
  const result = await publicSignup(admin, site.company, plan, parsed.form, input.nowMs, deps, `${site.ctx.siteUrl}/plans/${plan.id}`);
  switch (result.kind) {
    case "checkout":
      return { status: 303, html: null, redirect: result.url };
    case "requested":
      return { status: 200, html: renderRequested(site.ctx, plan, firstNameOf(parsed.form.name)) };
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

/** A lapsed plan can still be paid (and comes back) for REACTIVATE_DAYS after it lapsed. */
function restartable(agreement: ServiceAgreementRow, today: string): boolean {
  return agreement.status === "lapsed" && Boolean(agreement.term_end) && addDaysYmd(agreement.term_end as string, LAPSE_GRACE_DAYS + REACTIVATE_DAYS) >= today;
}

async function renewalPageFor(admin: AdminClient, site: PlansSite, token: string, agreement: ServiceAgreementRow, error?: string | null, nowMs: number = Date.now(), notice?: string | null): Promise<string> {
  const contact = await loadContact(admin, site.company.organizationId, agreement.contact_id);
  const plan = await loadPlan(admin, site.company, agreement.plan_id);
  let nextVisit: string | null = null;
  let renewedThrough: string | null = null;
  if (agreement.term_end) {
    const start = addDaysYmd(agreement.term_end, 1);
    nextVisit = plan ? (termVisitDates({ ...planSchedule(plan), months: agreement.visit_months }, start, termEndFor(start))[0] ?? null) : null;
    renewedThrough = termEndFor(start);
  }
  const today = localDate(new Date(nowMs), site.company.timeZone);
  return renderRenewal(site.ctx, token, { agreement, nextVisit, firstName: firstNameOf(contact?.first_name ?? agreement.customer_name), renewedThrough, error, restartable: restartable(agreement, today), notice });
}

export async function renewalPage(admin: AdminClient, slug: string, token: string, opts: { paid?: boolean; nowMs?: number } = {}): Promise<PublicPage> {
  const site = await loadPlansSite(admin, slug);
  if (!site) return { status: 404, html: null };
  const agreement = await agreementByToken(admin, site, token);
  if (!agreement) return { status: 404, html: null };
  const notice = opts.paid && agreement.status !== "renewed" ? "Thanks - your payment is in. Your plan will show as renewed in a moment." : null;
  return { status: 200, html: await renewalPageFor(admin, site, token, agreement, null, opts.nowMs ?? Date.now(), notice) };
}

/**
 * POST on the renewal page (also for a plan that lapsed in the last REACTIVATE_DAYS days).
 * Per visit → renewed right away (nothing to pay up front). Annual, cards online → a DRAFT renewal
 * invoice (no number until paid; reused on a second tap) → our Checkout on the company's account →
 * the webhook issues it and renews. Annual, no cards online → the issued renewal invoice's page
 * (reminders paused, never "overdue"); the owner records the e-Transfer and the sweep renews.
 */
export async function renewFromPage(admin: AdminClient, input: { slug: string; token: string; nowMs: number }, deps: PlanDeps = defaultPlanDeps): Promise<PublicPage> {
  const site = await loadPlansSite(admin, input.slug);
  if (!site) return { status: 404, html: null };
  const agreement = await agreementByToken(admin, site, input.token);
  if (!agreement) return { status: 404, html: null };
  const company = site.company;
  const today = localDate(new Date(input.nowMs), company.timeZone);
  const page = (error?: string | null, notice?: string | null) => renewalPageFor(admin, site, input.token, agreement, error, input.nowMs, notice);
  const lapsed = restartable(agreement, today);
  if (agreement.status !== "active" && agreement.status !== "renewal_due" && !lapsed) return { status: 200, html: await page() };
  if (!agreement.term_end || !agreement.contact_id) return { status: 409, html: await page("This plan can't be renewed online - please text or call us.") };
  if (agreement.billing === "per_visit") {
    const result = await renewAgreement(admin, company, agreement, input.nowMs, deps, { fromLapsed: lapsed });
    const fresh = (await agreementByToken(admin, site, input.token)) ?? agreement;
    const ok = result.ok || fresh.status === "renewed";
    return { status: ok ? 200 : 409, html: await renewalPageFor(admin, site, input.token, fresh, ok ? null : "Something went wrong - please try again.", input.nowMs) };
  }
  const db = admin as Db;
  const online = await deps.billing.stripeReady(company.companyId);
  let pending = agreement.pending_invoice_id ? (await invoiceStates(admin, company.organizationId, [agreement.pending_invoice_id])).get(agreement.pending_invoice_id) : undefined;
  if (isPaid(pending)) return { status: 200, html: await page(null, "Your payment is in - your plan will show as renewed in a moment.") };
  if (pending && pending.pendingPaymentCents > 0) return { status: 200, html: await page(null, "Your payment is processing - your plan will show as renewed once it clears.") };
  if (pending?.status === "void") pending = undefined;
  // An issued invoice (paid offline, or from before cards were on): its own page takes card too.
  if (pending && pending.status !== "draft" && pending.token) {
    return { status: 303, html: null, redirect: await invoicePageUrl(admin, company.organizationId, company.companyId, pending.token) };
  }
  if (pending && !online) {
    // A draft from when cards were on: drop it (no number used) and issue one they can pay offline.
    await deps.billing.voidUnpaid(admin, company.organizationId, pending.id, "Replaced: online payments are off.");
    pending = undefined;
  }
  const start = addDaysYmd(agreement.term_end, 1);
  const input2 = {
    organizationId: company.organizationId,
    companyId: company.companyId,
    contactId: agreement.contact_id,
    title: `${agreement.plan_name} - service plan renewal`,
    lineLabel: `${agreement.plan_name} - service plan, 12 months`,
    lineDescription: `From ${longDate(start)} to ${longDate(termEndFor(start))}.`,
    priceCents: agreement.renewal_price_cents ?? agreement.price_cents,
    dueDate: agreement.term_end > today ? agreement.term_end : today,
    pauseReminders: true,
    internalNote: `Service plan renewal (agreement ${agreement.id}). Renews when this is paid.`,
  };
  let invoiceId = pending?.id ?? null;
  let token: string | null = null;
  try {
    if (!invoiceId) {
      const made = online ? await deps.billing.draftTermInvoice(admin, input2) : await deps.billing.issueTermInvoice(admin, input2);
      const { data: linked } = await db
        .from("service_agreements")
        .update({ pending_invoice_id: made.id })
        .eq("organization_id", company.organizationId)
        .eq("id", agreement.id)
        .or(agreement.pending_invoice_id ? `pending_invoice_id.eq.${agreement.pending_invoice_id}` : "pending_invoice_id.is.null")
        .select("id");
      if (((linked ?? []) as unknown[]).length === 0) {
        // A second tap made one first: drop ours and use theirs.
        await deps.billing.voidUnpaid(admin, company.organizationId, made.id, "Duplicate renewal invoice.");
        const fresh = await agreementByToken(admin, site, input.token);
        invoiceId = fresh?.pending_invoice_id ?? null;
      } else {
        invoiceId = made.id;
        token = "token" in made ? (made as { token: string }).token : null;
      }
    }
  } catch (err) {
    console.error("[service-plans] renewal invoice failed:", err instanceof Error ? err.message : err);
    return { status: 503, html: await page("We couldn't start the payment. Please try again in a few minutes.") };
  }
  if (!invoiceId) return { status: 503, html: await page("We couldn't start the payment. Please try again in a few minutes.") };
  const state = (await invoiceStates(admin, company.organizationId, [invoiceId])).get(invoiceId);
  if (state?.status === "draft") {
    const url = await deps.billing.planCheckoutUrl(admin, { organizationId: company.organizationId, companyId: company.companyId, agreementId: agreement.id, invoiceId, returnUrl: `${site.ctx.siteUrl}/plans/renew/${input.token}` });
    if (url) return { status: 303, html: null, redirect: url };
    return { status: 503, html: await page("We couldn't start the payment. Please try again in a few minutes.") };
  }
  token = token ?? state?.token ?? null;
  if (!token) return { status: 503, html: await page("We couldn't start the payment. Please try again in a few minutes.") };
  return { status: 303, html: null, redirect: await invoicePageUrl(admin, company.organizationId, company.companyId, token) };
}
