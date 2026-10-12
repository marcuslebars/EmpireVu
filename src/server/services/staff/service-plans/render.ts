/**
 * The public service-plan pages on a company's generated site (docs/ai-staff.md → "Service plans"):
 *   /s/<slug>/plans                 active plans
 *   /s/<slug>/plans/<id>            one plan + the sign-up form (plain HTML form POST, works without JS)
 *   /s/<slug>/plans/renew/<token>   a customer's own renewal page
 * Server-rendered HTML in the site's colours. Every value goes through esc() / safeHref(); the only
 * script is the optional Turnstile widget. PURE.
 */
import type { SiteContent } from "@/server/services/dfy/site-content";
import { esc, safeHref, siteTheme } from "@/server/services/dfy/site-render";
import type { ServiceAgreementRow, ServicePlanRow } from "./db-types";
import { includedOf, planSchedule } from "./plans";
import { dayText, longDate, money, priceText, scheduleSentence } from "./schedule";

export interface PlansPageContext {
  content: SiteContent;
  /** Public URL of the company site (…/s/<slug> or the pages host). */
  siteUrl: string;
  turnstileSiteKey: string | null;
}

export interface FormState {
  values?: Record<string, string>;
  error?: string | null;
  renderedAtMs?: number;
  /** Annual plan and the business takes card payments online: the button says "Continue to payment". */
  paysOnline?: boolean;
}

/** The consent wording shown next to the box (and kept, in short, on the agreement). */
export function planConsentText(businessName: string): string {
  return `Yes, ${businessName} may text me about my service plan (visit reminders and renewals) at the number above. Message and data rates may apply. Reply STOP to opt out. Consent is not a condition of purchase.`;
}

function page(ctx: PlansPageContext, title: string, body: string, opts: { noindex?: boolean; turnstile?: boolean } = {}): string {
  const f = ctx.content.facts;
  const t = siteTheme(f);
  const logo = safeHref(f.logoUrl);
  const home = safeHref(ctx.siteUrl) ?? "#";
  return `<!doctype html>
<html lang="en-CA">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
${opts.noindex ? '<meta name="robots" content="noindex">' : ""}
<style>
:root{--p:${t.primary};--on-p:${t.onPrimary};--soft:${t.primarySoft};--deep:${t.primaryDeep}}
*{box-sizing:border-box}body{margin:0;font:400 17px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#f4f6f8;color:#15202a}
a{color:var(--deep)}.top{background:var(--p);color:var(--on-p)}.wrap{max-width:46rem;margin:0 auto;padding:14px 18px}
.top a{color:var(--on-p);text-decoration:none;font-weight:700}.top img{max-height:40px;vertical-align:middle}
main .wrap{padding-top:24px;padding-bottom:48px}h1{font-size:1.6rem;line-height:1.2;margin:0 0 6px}h2{font-size:1.15rem;margin:0 0 6px}
.card{background:#fff;border-radius:12px;padding:18px 20px;margin:14px 0;box-shadow:0 1px 2px rgba(0,0,0,.06)}
.price{font-size:1.3rem;font-weight:700;margin:4px 0}.meta{color:#46525e;margin:0 0 10px}ul{margin:4px 0 10px;padding-left:1.2em}li{margin:2px 0}
label{display:block;font-weight:600;margin:14px 0 4px}.hint{font-weight:400;color:#5b6772;font-size:.9rem}
input[type=text],input[type=tel],input[type=email]{width:100%;font:inherit;padding:10px 12px;border:1px solid #c9d1d9;border-radius:8px;background:#fff}
.consent{display:flex;gap:10px;align-items:flex-start;font-weight:400;font-size:.92rem;color:#2c3843}.consent input{margin-top:4px}
button{margin-top:18px;font:600 1rem system-ui,sans-serif;background:var(--p);color:var(--on-p);border:0;border-radius:10px;padding:12px 22px;cursor:pointer}
.err{background:#fdecea;color:#8a1c12;border-radius:8px;padding:10px 12px;margin:10px 0}.small{font-size:.85rem;color:#5b6772}
.hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}.btn{display:inline-block;background:var(--p);color:var(--on-p);text-decoration:none;border-radius:10px;padding:10px 18px;font-weight:600}
</style>
</head>
<body>
<div class="top"><div class="wrap"><a href="${home}">${logo ? `<img src="${logo}" alt="${esc(f.name)} logo">` : esc(f.name)}</a></div></div>
<main><div class="wrap">
${body}
</div></main>
${opts.turnstile && ctx.turnstileSiteKey ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>' : ""}
</body>
</html>`;
}

function bullets(items: string[]): string {
  return items.length ? `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : "";
}

function billingLine(plan: Pick<ServicePlanRow, "billing">): string {
  return plan.billing === "annual" ? "Paid once a year, up front. Renews yearly - we'll text you 30 days before." : "Each visit is invoiced after it's done. Renews yearly - we'll text you 30 days before.";
}

function planCard(ctx: PlansPageContext, plan: ServicePlanRow, withButton: boolean): string {
  const href = `${ctx.siteUrl}/plans/${plan.id}`;
  return `<div class="card">
<h2>${withButton ? `<a href="${esc(href)}">${esc(plan.name)}</a>` : esc(plan.name)}</h2>
<p class="price">${esc(priceText(plan.price_cents, plan.billing))} + HST</p>
${plan.description ? `<p>${esc(plan.description)}</p>` : ""}
<p class="meta">Visits: ${esc(scheduleSentence(planSchedule(plan), plan.time_of_day))}.</p>
${includedOf(plan).length ? `<p class="meta">Every visit includes:</p>${bullets(includedOf(plan))}` : ""}
<p class="small">${esc(billingLine(plan))}</p>
${withButton ? `<a class="btn" href="${esc(href)}">Sign up</a>` : ""}
</div>`;
}

export function renderPlansList(ctx: PlansPageContext, plans: ServicePlanRow[]): string {
  const name = ctx.content.facts.name;
  const list = plans.length ? plans.map((p) => planCard(ctx, p, true)).join("\n") : `<div class="card"><p>${esc(name)} has no service plans on offer right now.</p></div>`;
  return page(ctx, `Service plans - ${name}`, `<h1>Service plans</h1><p class="meta">Regular visits from ${esc(name)}, booked for you.</p>\n${list}`);
}

export function renderPlanPage(ctx: PlansPageContext, plan: ServicePlanRow, state: FormState = {}): string {
  const name = ctx.content.facts.name;
  const v = state.values ?? {};
  const val = (k: string) => esc(v[k] ?? "");
  const turnstile = ctx.turnstileSiteKey ? `<div class="cf-turnstile" data-sitekey="${esc(ctx.turnstileSiteKey)}"></div>` : "";
  const button = state.paysOnline ? `Continue to payment (${money(plan.price_cents)} + HST)` : "Sign up";
  const after = state.paysOnline
    ? "Next you'll pay for the first year on a secure page. Your visits are booked as soon as it goes through."
    : `${name} will confirm your plan and your first visit by text.`;
  const body = `<p class="small"><a href="${esc(`${ctx.siteUrl}/plans`)}">All plans</a></p>
<h1>${esc(plan.name)}</h1>
${planCard(ctx, plan, false)}
<div class="card">
<h2>Sign up</h2>
${state.error ? `<div class="err" role="alert">${esc(state.error)}</div>` : ""}
<form method="post" action="${esc(`${ctx.siteUrl}/plans/${plan.id}`)}">
<label for="name">Your name</label><input type="text" id="name" name="name" required maxlength="120" autocomplete="name" value="${val("name")}">
<label for="phone">Cell phone <span class="hint">(visit reminders come by text)</span></label><input type="tel" id="phone" name="phone" required maxlength="20" autocomplete="tel" value="${val("phone")}">
<label for="email">Email <span class="hint">(for your receipt)</span></label><input type="email" id="email" name="email" maxlength="254" autocomplete="email" value="${val("email")}">
<label for="address">Service address</label><input type="text" id="address" name="address" required maxlength="300" autocomplete="street-address" value="${val("address")}">
<label class="consent"><input type="checkbox" name="smsConsent" value="1"${v.smsConsent === "1" ? " checked" : ""}><span>${esc(planConsentText(name))}</span></label>
<div class="hp" aria-hidden="true"><label for="website">Website</label><input type="text" id="website" name="website" tabindex="-1" autocomplete="off"></div>
<input type="hidden" name="t" value="${esc(v.t || String(state.renderedAtMs ?? Date.now()))}">
${turnstile}
<button type="submit">${esc(button)}</button>
<p class="small">${esc(after)}</p>
</form>
</div>`;
  return page(ctx, `${plan.name} - ${name}`, body, { turnstile: Boolean(ctx.turnstileSiteKey) });
}

export function renderRequested(ctx: PlansPageContext, plan: Pick<ServicePlanRow, "name">, firstName: string): string {
  const name = ctx.content.facts.name;
  return page(
    ctx,
    `Thanks - ${name}`,
    `<h1>Thanks${firstName ? `, ${esc(firstName)}` : ""}!</h1><div class="card"><p>${esc(name)} got your sign-up for ${esc(plan.name)} and will confirm it - with your first visit - by text shortly.</p><p><a href="${esc(ctx.siteUrl)}">Back to ${esc(name)}</a></p></div>`,
    { noindex: true },
  );
}

export function renderAlreadyOn(ctx: PlansPageContext, plan: Pick<ServicePlanRow, "name">): string {
  const name = ctx.content.facts.name;
  return page(ctx, `${plan.name} - ${name}`, `<h1>You're already on this plan</h1><div class="card"><p>${esc(plan.name)} with ${esc(name)} is already set up for this number. Questions? Text or call us.</p></div>`, { noindex: true });
}

export interface RenewalView {
  agreement: Pick<ServiceAgreementRow, "plan_name" | "billing" | "term_end" | "status" | "price_cents" | "renewal_price_cents">;
  nextVisit: string | null;
  firstName: string;
  /** For a renewed plan: through when. */
  renewedThrough?: string | null;
  error?: string | null;
}

export function renderRenewal(ctx: PlansPageContext, token: string, view: RenewalView): string {
  const name = ctx.content.facts.name;
  const a = view.agreement;
  const price = a.renewal_price_cents ?? a.price_cents;
  if (a.status === "renewed") {
    return page(ctx, `Renewed - ${name}`, `<h1>You're renewed${view.firstName ? `, ${esc(view.firstName)}` : ""}!</h1><div class="card"><p>Your ${esc(a.plan_name)} plan with ${esc(name)} is renewed${view.renewedThrough ? ` through ${esc(longDate(view.renewedThrough))}` : ""}. Thanks!</p></div>`, { noindex: true });
  }
  if (a.status !== "active" && a.status !== "renewal_due") {
    return page(ctx, `${a.plan_name} - ${name}`, `<h1>This plan has ended</h1><div class="card"><p>Your ${esc(a.plan_name)} plan isn't active any more. Text or call ${esc(name)} and we'll set you up again.</p></div>`, { noindex: true });
  }
  const ends = a.term_end ? ` Your current year ends ${esc(longDate(a.term_end))}.` : "";
  const keep = view.nextVisit ? ` Renewing keeps your next visit on ${esc(dayText(view.nextVisit))}.` : "";
  const button = a.billing === "annual" ? `Pay ${money(price)} + HST and renew` : "Keep my plan for another year";
  const terms = a.billing === "annual" ? `${money(price)} + HST for the next 12 months, paid now.` : `Still ${money(price)} + HST a visit, invoiced after each visit.`;
  return page(
    ctx,
    `Renew ${a.plan_name} - ${name}`,
    `<h1>Renew your ${esc(a.plan_name)} plan</h1>
<div class="card">
${view.error ? `<div class="err" role="alert">${esc(view.error)}</div>` : ""}
<p>${view.firstName ? `Hi ${esc(view.firstName)}. ` : ""}${esc(terms)}${ends}${keep}</p>
<form method="post" action="${esc(`${ctx.siteUrl}/plans/renew/${token}`)}"><button type="submit">${esc(button)}</button></form>
<p class="small">Not renewing? You don't need to do anything - your plan just ends.</p>
</div>`,
    { noindex: true },
  );
}
