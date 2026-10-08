import { smsConsentText } from "@/server/services/lead-intake/public-form-envelope";

import {
  effectiveCopy,
  hexColor,
  tradeProfile,
  type SiteContent,
  type SiteFacts,
  type SiteService,
} from "./site-content";

/**
 * Generated sites — the HTML renderer (docs/done-for-you.md → "Generated sites").
 *
 * One complete, self-contained HTML document: inline CSS, one variable Google font (Archivo,
 * whose width axis gives the truck-door lettering), a few hundred bytes of inline JS for the
 * quote form. No framework, so it is fast on a phone on a job site.
 *
 * Design: the page reads like the contractor's truck door and counter price sheet — the name
 * set wide and heavy, the phone number big enough to tap, and services as a ruled rate sheet
 * with tabular prices. Colour comes from the brand (or a palette per trade), used in one place
 * with conviction (the hero band or rail) plus the call-to-action.
 *
 * SAFETY: every company/owner/model string goes through esc(); URLs through safeHref()
 * (http/https only); colours through hexColor(); JSON-LD through jsonForScript(). Nothing
 * from content is ever placed in a <script> except via jsonForScript.
 */

export interface SiteRenderOptions {
  /** Canonical public URL of the page. */
  url: string;
  /** Active public form key for the quote form; null → no form (call-only). */
  formKey: string | null;
  /** Live booking page URL when online booking is on. */
  bookingUrl: string | null;
  turnstileSiteKey: string | null;
  /** Owner preview from Settings: a banner + noindex. */
  preview?: boolean;
  /** Link for the small "Site by CrankLeads" credit (CrankLeads orgs only); null hides it. */
  creditUrl?: string | null;
}

// ── Escaping ─────────────────────────────────────────────────────────────────

export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** http(s) URLs only (escaped for an attribute); anything else → null. */
export function safeHref(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return esc(url.toString());
  } catch {
    return null;
  }
}

/** JSON safe to embed inside <script type="application/ld+json">. */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function telHref(e164: string | null): string | null {
  if (!e164) return null;
  const digits = e164.replace(/[^\d+]/g, "");
  return digits.length >= 7 ? `tel:${digits}` : null;
}

// ── Colour ───────────────────────────────────────────────────────────────────

function luminance(hex: string): number {
  const n = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(n.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function onColor(hex: string): string {
  return luminance(hex) > 0.3 ? "#111820" : "#ffffff";
}

function mix(hex: string, withHex: string, amount: number): string {
  const a = hex.replace("#", "");
  const b = withHex.replace("#", "");
  const out = [0, 2, 4].map((i) => {
    const v = Math.round(parseInt(a.slice(i, i + 2), 16) * (1 - amount) + parseInt(b.slice(i, i + 2), 16) * amount);
    return v.toString(16).padStart(2, "0");
  });
  return `#${out.join("")}`;
}

export interface SiteTheme {
  primary: string;
  onPrimary: string;
  accent: string;
  onAccent: string;
  primarySoft: string;
  primaryDeep: string;
  variant: "bold" | "plain";
}

export function siteTheme(facts: SiteFacts): SiteTheme {
  const trade = tradeProfile(facts.tradeId);
  const primary = hexColor(facts.primaryColor) ?? trade.primary;
  let accent = hexColor(facts.accentColor) ?? trade.accent;
  if (accent === primary) accent = trade.accent === primary ? "#e07a1f" : trade.accent;
  return {
    primary,
    onPrimary: onColor(primary),
    accent,
    onAccent: onColor(accent),
    primarySoft: mix(primary, "#ffffff", 0.9),
    primaryDeep: mix(primary, "#000000", 0.25),
    variant: trade.variant,
  };
}

// ── JSON-LD ──────────────────────────────────────────────────────────────────

/** LocalBusiness (or the trade's subtype). Deliberately NO aggregateRating (self-serving review markup). */
export function buildJsonLd(content: SiteContent, opts: Pick<SiteRenderOptions, "url">): Record<string, unknown> {
  const f = content.facts;
  const copy = effectiveCopy(content);
  const ld: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": tradeProfile(f.tradeId).schemaType,
    name: f.name,
    url: opts.url,
    description: copy.about,
  };
  if (f.phoneE164) ld.telephone = f.phoneE164;
  if (f.serviceArea) ld.areaServed = f.serviceArea;
  if (f.address) ld.address = f.address;
  if (f.logoUrl) {
    ld.logo = f.logoUrl;
    ld.image = f.logoUrl;
  } else if (f.photos[0]) {
    ld.image = f.photos[0];
  }
  if (f.openingHours.length) {
    ld.openingHoursSpecification = f.openingHours.map((s) => ({
      "@type": "OpeningHoursSpecification",
      dayOfWeek: s.days,
      opens: s.opens,
      closes: s.closes,
    }));
  }
  const sameAs = [f.website, f.mapsUrl].filter((u): u is string => Boolean(u));
  if (sameAs.length) ld.sameAs = sameAs;
  return ld;
}

// ── Icons (inline SVG, decorative) ───────────────────────────────────────────

const ICON = {
  phone: '<svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z"/></svg>',
  pin: '<svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M12 2a7 7 0 0 0-7 7c0 5.25 7 13 7 13s7-7.75 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/></svg>',
  clock: '<svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 10.4 3.3 2-1 1.7L11 13V7h2z"/></svg>',
  star: '<svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="m12 2.5 2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.3 1.3-6.6L2.5 9.4l6.6-.8z"/></svg>',
  calendar: '<svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M7 2h2v2h6V2h2v2h3a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3zm12 8H5v9h14z"/></svg>',
};

// ── Sections ─────────────────────────────────────────────────────────────────

function ratingBadge(f: SiteFacts, cls: string): string {
  if (!f.rating || !f.reviewCount) return "";
  const href = safeHref(f.reviewUrl) ?? safeHref(f.mapsUrl);
  const label = `${f.rating.toFixed(1)} on Google from ${f.reviewCount} review${f.reviewCount === 1 ? "" : "s"}`;
  const inner = `<span class="stars">${ICON.star}</span><strong>${esc(f.rating.toFixed(1))}</strong><span>from ${esc(f.reviewCount)} Google review${f.reviewCount === 1 ? "" : "s"}</span>`;
  return href
    ? `<a class="${cls}" href="${href}" rel="noopener" target="_blank" aria-label="${esc(label)}">${inner}</a>`
    : `<p class="${cls}" aria-label="${esc(label)}">${inner}</p>`;
}

/** "$65 / visit" → amount + unit (the unit drops to its own line on phones). */
function priceHtml(text: string): string {
  const i = text.indexOf(" / ");
  return i > 0 ? `${esc(text.slice(0, i))}<span class="unit"> / ${esc(text.slice(i + 3))}</span>` : esc(text);
}

function serviceRow(s: SiteService, blurb: string | undefined, showPrices: boolean, hasForm: boolean): string {
  const price = showPrices && s.priceText
    ? `<span class="price">${priceHtml(s.priceText)}</span>${s.priceNote ? `<span class="price-note">${esc(s.priceNote)}</span>` : ""}`
    : hasForm
      ? `<a class="quote-link" href="#quote" data-service="${esc(s.label)}">Get a quote</a>`
      : `<span class="quote-text">Call for a price</span>`;
  return `<li class="rate">
  <div class="rate-main"><h3>${esc(s.label)}</h3>${blurb ? `<p>${esc(blurb)}</p>` : ""}</div>
  <div class="rate-price">${price}</div>
</li>`;
}

function hoursBlock(f: SiteFacts): string {
  if (!f.hoursLines.length) return "";
  return `<div class="fact">
  <h3>${ICON.clock}<span>Hours</span></h3>
  <ul class="hours">${f.hoursLines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>
</div>`;
}

function areaBlock(f: SiteFacts): string {
  if (!f.serviceArea && !f.mapsUrl && !f.address) return "";
  const maps = safeHref(f.mapsUrl);
  return `<div class="fact">
  <h3>${ICON.pin}<span>Where we work</span></h3>
  ${f.serviceArea ? `<p class="fact-big">${esc(f.serviceArea)}</p>` : ""}
  ${f.address ? `<p>${esc(f.address)}</p>` : ""}
  ${maps ? `<p><a href="${maps}" rel="noopener" target="_blank">Find us on Google Maps</a></p>` : ""}
</div>`;
}

function quoteForm(content: SiteContent, opts: SiteRenderOptions): string {
  const f = content.facts;
  const tel = telHref(f.phoneE164);
  if (!opts.formKey) {
    if (!tel) return "";
    return `<section class="section quote" id="quote" aria-labelledby="quote-title">
  <div class="wrap quote-wrap">
    <div class="quote-intro"><h2 id="quote-title">Get a price</h2><p>Call us and tell us about the job.</p></div>
    <a class="btn btn-accent btn-big" href="${esc(tel)}">${ICON.phone}<span>Call ${esc(f.phoneDisplay)}</span></a>
  </div>
</section>`;
  }
  const options = f.services
    .map((s) => `<option value="${esc(s.label)}">${esc(s.label)}</option>`)
    .join("");
  const endpoint = `/api/public/forms/${encodeURIComponent(opts.formKey)}`;
  const turnstile = opts.turnstileSiteKey
    ? `<div class="cf-turnstile" data-sitekey="${esc(opts.turnstileSiteKey)}"></div>`
    : "";
  return `<section class="section quote" id="quote" aria-labelledby="quote-title">
  <div class="wrap quote-wrap">
    <div class="quote-intro">
      <h2 id="quote-title">Ask for a quote</h2>
      <p>Tell us what you need and where. We'll get back to you with a price.</p>
      ${tel ? `<p class="quote-call">Rather talk? <a href="${esc(tel)}">Call ${esc(f.phoneDisplay)}</a></p>` : ""}
    </div>
    <form class="form" id="quote-form" data-endpoint="${esc(endpoint)}"${opts.preview ? ' data-preview="1"' : ""} novalidate>
      <div class="field"><label for="q-name">Your name</label><input id="q-name" name="name" autocomplete="name" maxlength="200"></div>
      <div class="field-row">
        <div class="field"><label for="q-phone">Phone</label><input id="q-phone" name="phone" type="tel" autocomplete="tel" inputmode="tel" maxlength="40"></div>
        <div class="field"><label for="q-email">Email</label><input id="q-email" name="email" type="email" autocomplete="email" maxlength="320"></div>
      </div>
      ${f.services.length ? `<div class="field"><label for="q-service">What do you need?</label><select id="q-service" name="service"><option value="">Choose a service</option>${options}<option value="Something else">Something else</option></select></div>` : ""}
      <div class="field"><label for="q-message">Details</label><textarea id="q-message" name="message" rows="4" maxlength="4000" placeholder="Address, size of the job, timing"></textarea></div>
      <div class="hp" aria-hidden="true"><label for="q-website">Leave this empty</label><input id="q-website" name="website" tabindex="-1" autocomplete="off"></div>
      <label class="consent"><input type="checkbox" name="smsConsent" value="1"><span>${esc(smsConsentText(f.name))}</span></label>
      ${turnstile}
      <p class="form-error" role="alert" hidden></p>
      <button class="btn btn-accent btn-big" type="submit">Send my request</button>
      <p class="form-hint">We need a phone number or an email to reach you.</p>
    </form>
    <div class="form-done" hidden role="status" tabindex="-1"><h3>Thanks, we got it.</h3><p>We'll be in touch soon${tel ? `. If it's urgent, call <a href="${esc(tel)}">${esc(f.phoneDisplay)}</a>` : ""}.</p></div>
  </div>
</section>`;
}

const FORM_JS = `(function(){var f=document.getElementById("quote-form");if(!f)return;var t0=Date.now();
document.querySelectorAll("[data-service]").forEach(function(a){a.addEventListener("click",function(){var s=document.getElementById("q-service");if(s)s.value=a.getAttribute("data-service")||"";});});
f.addEventListener("submit",function(e){e.preventDefault();var err=f.querySelector(".form-error"),b=f.querySelector("button[type=submit]");var v=function(n){var el=f.elements[n];return el&&el.value?el.value.trim():"";};
if(f.getAttribute("data-preview")){err.textContent="This is a preview. The form sends requests once the page is published.";err.hidden=false;return;}var phone=v("phone"),email=v("email");if(!phone&&!email){err.textContent="Please enter a phone number or an email so we can reach you.";err.hidden=false;return;}
var q=new URLSearchParams(location.search),utm={};["utm_source","utm_medium","utm_campaign","utm_term","utm_content","gclid","fbclid"].forEach(function(k){var x=q.get(k);if(x)utm[k]=x.slice(0,200);});
var ts=f.querySelector("[name=cf-turnstile-response]");var body={name:v("name")||undefined,phone:phone||undefined,email:email||undefined,service:v("service")||undefined,message:v("message")||undefined,smsConsent:phone?f.elements.smsConsent.checked:undefined,page:location.href.slice(0,2000),utm:Object.keys(utm).length?utm:undefined,website:v("website")||undefined,formStartedAt:t0,turnstileToken:ts&&ts.value?ts.value:undefined};
b.disabled=true;b.textContent="Sending…";err.hidden=true;
fetch(f.getAttribute("data-endpoint"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}).then(function(r){return r.json().catch(function(){return {};}).then(function(j){if(!r.ok)throw new Error(j&&j.error||"Couldn't send. Please try again.");});})
.then(function(){f.hidden=true;var d=document.querySelector(".form-done");d.hidden=false;d.focus();})
.catch(function(x){err.textContent=x.message||"Couldn't send. Please try again.";err.hidden=false;b.disabled=false;b.textContent="Send my request";});});})();`;

// ── CSS ──────────────────────────────────────────────────────────────────────

function css(t: SiteTheme): string {
  return `:root{--ink:#15202a;--ink-2:#46525e;--paper:#f2f4f6;--card:#fff;--rule:#d7dde3;--p:${t.primary};--on-p:${t.onPrimary};--p-soft:${t.primarySoft};--p-deep:${t.primaryDeep};--a:${t.accent};--on-a:${t.onAccent};
--wide:"wdth" 118;--narrow:"wdth" 82}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%;scroll-behavior:smooth}
body{margin:0;background:var(--paper);color:var(--ink);font:400 17px/1.55 Archivo,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-variation-settings:"wdth" 100}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
a{color:var(--p-deep)}a:hover{text-decoration-thickness:2px}
:focus-visible{outline:3px solid var(--a);outline-offset:2px}
img{max-width:100%;display:block}
h1,h2,h3{line-height:1.08;margin:0;font-weight:800}
h2{font-size:clamp(1.6rem,4.6vw,2.3rem);font-variation-settings:var(--wide);letter-spacing:-.01em}
.wrap{width:100%;max-width:1080px;margin:0 auto;padding:0 20px}
.skip{position:absolute;left:-999px}.skip:focus{left:12px;top:12px;background:#fff;padding:8px 12px;z-index:50}
.preview{background:#fff4c2;color:#4a3b00;text-align:center;font-size:14px;padding:8px 12px;border-bottom:1px solid #e9d27a}
/* top bar */
.top{background:var(--card);border-bottom:1px solid var(--rule)}
.top .wrap{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:64px}
.brand{display:flex;align-items:center;gap:12px;text-decoration:none;color:var(--ink);min-width:0}
.brand img{max-height:44px;width:auto;max-width:180px;object-fit:contain}
.wordmark{font-weight:900;font-size:1.15rem;font-variation-settings:var(--wide);letter-spacing:-.01em;line-height:1.1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.top-links{display:flex;align-items:center;gap:18px;font-weight:600;font-size:15px}
.top-links a{text-decoration:none;color:var(--ink)}.top-links a:hover{color:var(--p-deep)}
.top-phone{display:none;align-items:center;gap:8px;font-variant-numeric:tabular-nums}
/* hero */
.hero{position:relative;padding:44px 0 40px}
.hero.bold{background:var(--p);color:var(--on-p)}
.hero.plain{background:var(--card);border-bottom:1px solid var(--rule)}
.hero.plain::before{content:"";position:absolute;left:0;top:0;bottom:0;width:8px;background:var(--p)}
.hero-grid{display:grid;gap:28px}
.hero-name{margin:0 0 14px;font-weight:700;font-size:15px;font-variation-settings:var(--wide);opacity:.85}
.hero h1{font-size:clamp(2.1rem,8.4vw,3.9rem);font-weight:900;font-variation-settings:"wdth" 112;letter-spacing:-.02em;max-width:17ch;text-wrap:balance}
.hero.plain h1{color:var(--ink)}
.sub{font-size:clamp(1.05rem,2.6vw,1.25rem);margin:16px 0 0;max-width:38em;opacity:.92}
.ctas{display:flex;flex-wrap:wrap;gap:12px;margin-top:26px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:10px;min-height:52px;padding:0 22px;border-radius:6px;font:inherit;font-weight:700;font-size:17px;text-decoration:none;border:2px solid transparent;cursor:pointer;line-height:1.1}
.btn-accent{background:var(--a);color:var(--on-a)}.btn-accent:hover{filter:brightness(1.06)}
.btn-ghost{border-color:currentColor;color:inherit;background:transparent}
.hero.plain .btn-ghost{color:var(--ink)}
.btn-big{min-height:58px;font-size:18px}
.btn[disabled]{opacity:.6;cursor:progress}
.phone-num{font-variant-numeric:tabular-nums;font-variation-settings:"wdth" 108;letter-spacing:.01em}
.rating{display:inline-flex;align-items:center;gap:8px;margin:22px 0 0;font-size:15px;color:inherit;text-decoration:none;padding:7px 12px;border-radius:999px;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.28)}
.hero.plain .rating{background:var(--p-soft);border-color:transparent;color:var(--ink)}
.rating .stars{color:#f5b400;display:inline-flex}
.rating strong{font-size:16px}
a.rating:hover span:last-child{text-decoration:underline}
.door{display:none;background:rgba(0,0,0,.16);border:1px solid rgba(255,255,255,.18);border-radius:10px;padding:22px}
.hero.plain .door{background:var(--paper);border-color:var(--rule)}
.door h2{font-size:15px;font-weight:700;font-variation-settings:"wdth" 100;letter-spacing:0;opacity:.8;margin-bottom:8px}
.door .big-phone{display:block;font-size:clamp(1.8rem,5vw,2.4rem);font-weight:900;color:inherit;text-decoration:none;font-variant-numeric:tabular-nums;font-variation-settings:"wdth" 110}
.door ul{list-style:none;margin:16px 0 0;padding:0;display:grid;gap:10px;font-size:15px}
.door li{display:flex;gap:10px;align-items:flex-start}.door li svg{flex:none;margin-top:2px;opacity:.85}
.hero-photo{border-radius:10px;overflow:hidden;aspect-ratio:4/3;background:var(--p-deep)}
.hero-photo img{width:100%;height:100%;object-fit:cover}
/* sections */
.section{padding:56px 0}.flow+.flow{padding-top:0}
.section-head{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:8px 20px;margin-bottom:22px}
.section-head p{margin:0;color:var(--ink-2)}
/* rate sheet */
.sheet{background:var(--card);border:1px solid var(--rule);border-top:6px solid var(--p);border-radius:4px;padding:6px 0;margin:0;list-style:none}
.rate{display:grid;grid-template-columns:1fr auto;gap:6px 18px;align-items:baseline;padding:16px 20px;border-bottom:1px dashed var(--rule)}
.rate:last-child{border-bottom:0}
.rate h3{font-size:1.06rem;font-weight:700;font-variation-settings:"wdth" 100;line-height:1.3}
.rate p{margin:4px 0 0;color:var(--ink-2);font-size:15px;line-height:1.45}
.rate-price{text-align:right;display:flex;flex-direction:column;align-items:flex-end}
.price{font-weight:800;font-size:1.12rem;font-variant-numeric:tabular-nums;white-space:nowrap;font-variation-settings:"wdth" 104}.price .unit{display:block;font-weight:500;font-size:13px;color:var(--ink-2);font-variation-settings:"wdth" 100}
.price-note{font-size:13px;color:var(--ink-2);white-space:nowrap}
.quote-link{font-weight:700;font-size:15px;white-space:nowrap;color:var(--p-deep)}
.quote-text{font-size:15px;color:var(--ink-2);white-space:nowrap}
.sheet-foot{margin:14px 2px 0;font-size:15px;color:var(--ink-2)}
/* steps */
.steps{list-style:none;margin:0;padding:0;display:grid;gap:14px;counter-reset:s}
.steps li{counter-increment:s;background:var(--card);border:1px solid var(--rule);border-radius:6px;padding:18px 18px 18px 64px;position:relative}
.steps li::before{content:counter(s);position:absolute;left:18px;top:16px;width:32px;height:32px;border-radius:50%;background:var(--p);color:var(--on-p);font-weight:800;display:grid;place-items:center;font-size:16px}
.steps h3{font-size:1.05rem;font-variation-settings:"wdth" 100;margin-bottom:4px}
.steps p{margin:0;color:var(--ink-2);font-size:15px}
/* about + facts */
.about{display:grid;gap:28px}
.about-copy p{margin:14px 0 0;font-size:1.08rem;max-width:36em}
.highlights{margin:18px 0 0;padding:0;list-style:none;display:grid;gap:8px}
.highlights li{padding-left:22px;position:relative}.highlights li::before{content:"";position:absolute;left:0;top:.6em;width:10px;height:4px;background:var(--a)}
.facts{display:grid;gap:14px}
.fact{background:var(--card);border:1px solid var(--rule);border-radius:6px;padding:18px 20px}
.fact h3{display:flex;align-items:center;gap:8px;font-size:15px;font-variation-settings:"wdth" 100;color:var(--p-deep);margin-bottom:8px}
.fact p{margin:6px 0 0}.fact-big{font-weight:700;font-size:1.1rem}
.hours{list-style:none;margin:0;padding:0;font-variant-numeric:tabular-nums}.hours li{padding:3px 0}
/* reviews */
.reviews{background:var(--p-soft)}
.reviews .wrap{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:20px}
.score{display:flex;align-items:center;gap:16px}
.score-num{font-size:3.4rem;font-weight:900;font-variation-settings:"wdth" 112;line-height:1;color:var(--p-deep)}
.score-stars{color:#f5b400;display:flex;gap:2px}.score-stars svg{width:22px;height:22px}
.score p{margin:4px 0 0;color:var(--ink-2)}
/* faq */
.faq>*{max-width:760px}
.faq details{border-bottom:1px solid var(--rule)}
.faq summary{cursor:pointer;list-style:none;padding:18px 36px 18px 0;font-weight:700;font-size:1.06rem;position:relative}
.faq summary::-webkit-details-marker{display:none}
.faq summary::after{content:"";position:absolute;right:6px;top:50%;width:10px;height:10px;border-right:2.5px solid var(--p);border-bottom:2.5px solid var(--p);transform:translateY(-70%) rotate(45deg);transition:transform .15s}
.faq details[open] summary::after{transform:translateY(-30%) rotate(-135deg)}
.faq details p{margin:0 0 18px;color:var(--ink-2);max-width:40em}
/* quote */
.quote{background:var(--card);border-top:1px solid var(--rule)}
.quote-wrap{display:grid;gap:28px}
.quote-intro p{margin:12px 0 0;color:var(--ink-2);max-width:30em}
.quote-call{font-weight:600}
.form{display:grid;gap:16px;max-width:620px}
.field{display:grid;gap:6px}.field-row{display:grid;gap:16px}
.field label{font-weight:600;font-size:15px}
input,select,textarea{font:inherit;font-size:16px;width:100%;padding:12px 14px;border:1.5px solid #b9c3cc;border-radius:6px;background:#fff;color:var(--ink)}
input:focus,select:focus,textarea:focus{border-color:var(--p);outline:3px solid var(--p-soft);outline-offset:0}
.hp{position:absolute;left:-5000px;width:1px;height:1px;overflow:hidden}
.consent{display:flex;gap:10px;align-items:flex-start;font-size:13px;color:var(--ink-2);line-height:1.45}
.consent input{width:18px;height:18px;margin-top:2px;flex:none}
.form-error{margin:0;color:#b42318;font-weight:600}
.form-hint{margin:-4px 0 0;font-size:14px;color:var(--ink-2)}
.form-done{background:var(--p-soft);border-radius:8px;padding:24px;max-width:620px}.form-done p{margin:8px 0 0}
/* footer */
.foot{background:var(--p-deep);color:#fff;padding:36px 0 110px;font-size:15px}
.foot a{color:#fff}
.foot .wrap{display:grid;gap:14px}
.foot-name{font-weight:900;font-size:1.2rem;font-variation-settings:var(--wide)}
.foot p{margin:0;opacity:.88}
.credit{font-size:13px;opacity:.7}
/* sticky mobile bar */
.bar{position:fixed;left:0;right:0;bottom:0;z-index:20;display:flex;gap:8px;padding:10px 12px calc(10px + env(safe-area-inset-bottom));background:rgba(255,255,255,.96);border-top:1px solid var(--rule);box-shadow:0 -6px 20px rgba(16,24,32,.08)}
.bar .btn{flex:1;min-height:50px;font-size:16px;padding:0 12px}
.bar .btn-call{background:var(--p);color:var(--on-p)}
@media (min-width:700px){
  .field-row{grid-template-columns:1fr 1fr}
  .steps{grid-template-columns:repeat(3,1fr)}
  .facts{grid-template-columns:1fr 1fr}
}
@media (min-width:900px){
  body{font-size:18px}
  .top-phone{display:inline-flex}
  .door{display:block}
  .price .unit{display:inline;font-size:inherit;font-weight:inherit;color:inherit}
  .hero{padding:72px 0 68px}
  .hero-grid{grid-template-columns:minmax(0,1.45fr) minmax(0,1fr);align-items:center;gap:56px}
  .section{padding:80px 0}
  .about{grid-template-columns:1.3fr 1fr;align-items:start;gap:56px}
  .facts{grid-template-columns:1fr}
  .about-facts{grid-template-columns:1fr;gap:22px}.about-facts .facts{grid-template-columns:1fr 1fr}
  .quote-wrap{grid-template-columns:1fr 1.4fr;gap:56px}
  .bar{display:none}
  .foot{padding-bottom:40px}
  .foot .wrap{grid-template-columns:1fr auto;align-items:end}
}`;
}

// ── Page ─────────────────────────────────────────────────────────────────────

function head(content: SiteContent, opts: SiteRenderOptions, theme: SiteTheme): string {
  const f = content.facts;
  const copy = effectiveCopy(content);
  const trade = f.tradeId ? tradeProfile(f.tradeId).noun : null;
  const titleBits = [f.name, content.mode === "price_page" ? "Services and prices" : trade && f.serviceArea ? `${trade} in ${f.serviceArea}` : trade ?? f.serviceArea];
  const title = titleBits.filter(Boolean).join(" | ").slice(0, 120);
  const description = (copy.subhead.length >= 60 ? copy.subhead : `${copy.subhead} ${copy.about}`).slice(0, 300);
  const image = safeHref(f.photos[0]) ?? safeHref(f.logoUrl);
  const canonical = safeHref(opts.url);
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
${canonical ? `<link rel="canonical" href="${canonical}">` : ""}
${opts.preview ? '<meta name="robots" content="noindex,nofollow">' : ""}
<meta name="theme-color" content="${esc(theme.primary)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
${canonical ? `<meta property="og:url" content="${canonical}">` : ""}
<meta property="og:site_name" content="${esc(f.name)}">
<meta property="og:locale" content="en_CA">
${image ? `<meta property="og:image" content="${image}">` : ""}
<meta name="twitter:card" content="${image ? "summary_large_image" : "summary"}">
${safeHref(f.logoUrl) ? `<link rel="icon" href="${safeHref(f.logoUrl)}">` : ""}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..900&display=swap">
<style>${css(theme)}</style>
<script type="application/ld+json">${jsonForScript(buildJsonLd(content, opts))}</script>`;
}

export function renderSitePage(content: SiteContent, opts: SiteRenderOptions): string {
  const f = content.facts;
  const copy = effectiveCopy(content);
  const theme = siteTheme(f);
  const isPricePage = content.mode === "price_page";
  const tel = telHref(f.phoneE164);
  const hasForm = Boolean(opts.formKey);
  const booking = safeHref(opts.bookingUrl);
  const website = safeHref(f.website);
  const logo = safeHref(f.logoUrl);
  const photo = safeHref(f.photos[0]);
  const showPrices = content.settings.showPrices;
  const anyPrice = showPrices && f.services.some((s) => s.priceText);
  const quoteHref = hasForm || tel ? "#quote" : null;

  const topLinks = [
    website && isPricePage ? `<a href="${website}" rel="noopener">Visit our main site</a>` : "",
    tel ? `<a class="top-phone" href="${esc(tel)}">${ICON.phone}<span class="phone-num">${esc(f.phoneDisplay)}</span></a>` : "",
  ].join("");

  const ctas = [
    tel ? `<a class="btn btn-accent btn-big" href="${esc(tel)}">${ICON.phone}<span>Call <span class="phone-num">${esc(f.phoneDisplay)}</span></span></a>` : "",
    hasForm ? `<a class="btn ${tel ? "btn-ghost" : "btn-accent"} btn-big" href="#quote">Get a quote</a>` : "",
    booking ? `<a class="btn btn-ghost btn-big" href="${booking}">${ICON.calendar}<span>Book online</span></a>` : "",
  ].join("");

  const doorItems = [
    f.serviceArea ? `<li>${ICON.pin}<span>${esc(f.serviceArea)}</span></li>` : "",
    f.hoursLines.length ? `<li>${ICON.clock}<span>${f.hoursLines.map(esc).join("<br>")}</span></li>` : "",
  ].join("");
  const heroAside = photo
    ? `<div class="hero-photo"><img src="${photo}" alt="" loading="eager" decoding="async"></div>`
    : tel || doorItems
      ? `<aside class="door" aria-label="Contact">
      ${tel ? `<h2>Call or text</h2><a class="big-phone" href="${esc(tel)}">${esc(f.phoneDisplay)}</a>` : `<h2>${esc(f.name)}</h2>`}
      ${doorItems ? `<ul>${doorItems}</ul>` : ""}
    </aside>`
      : "";

  const hero = `<header class="hero ${theme.variant}">
  <div class="wrap hero-grid">
    <div>
      <h1>${esc(copy.headline)}</h1>
      <p class="sub">${esc(copy.subhead)}</p>
      ${ctas ? `<div class="ctas">${ctas}</div>` : ""}
      ${ratingBadge(f, "rating")}
    </div>
    ${heroAside}
  </div>
</header>`;

  const services = f.services.length
    ? `<section class="section flow" id="services" aria-labelledby="services-title">
  <div class="wrap">
    <div class="section-head"><h2 id="services-title">${anyPrice ? "Services and prices" : "Services"}</h2>${anyPrice && hasForm ? `<p>Don't see your job? <a href="#quote">Ask for a quote</a>.</p>` : ""}</div>
    <ul class="sheet">${f.services.map((s) => serviceRow(s, copy.serviceBlurbs[s.key], showPrices, hasForm)).join("")}</ul>
  </div>
</section>`
    : "";

  const steps = `<section class="section flow" aria-labelledby="how-title">
  <div class="wrap">
    <div class="section-head"><h2 id="how-title">How it works</h2></div>
    <ol class="steps">
      <li><h3>Tell us about the job</h3><p>${tel && hasForm ? "Call us or send a request with the form below." : tel ? "Give us a call." : "Send a request with the form below."}</p></li>
      <li><h3>Get your price</h3><p>${anyPrice ? "Regular services are priced above. Anything else, we price for you." : "We look at what you need and give you a price."}</p></li>
      <li><h3>${booking ? "Book a time" : "Pick a time"}</h3><p>${booking ? "Book online, or we'll set a time with you." : "We set a time that works for you."}</p></li>
    </ol>
  </div>
</section>`;

  const facts = [areaBlock(f), hoursBlock(f)].filter(Boolean).join("");
  const about = !isPricePage || facts
    ? `<section class="section flow" id="about" aria-labelledby="about-title"${f.services.length ? '' : ""}>
  <div class="wrap about${isPricePage ? " about-facts" : ""}">
    ${!isPricePage ? `<div class="about-copy"><h2 id="about-title">About ${esc(f.name)}</h2><p>${esc(copy.about)}</p>${f.highlights.length ? `<ul class="highlights">${f.highlights.map((h) => `<li>${esc(h)}</li>`).join("")}</ul>` : ""}</div>` : `<h2 id="about-title" class="about-copy">Where and when we work</h2>`}
    ${facts ? `<div class="facts">${facts}</div>` : ""}
  </div>
</section>`
    : "";

  const reviewHref = safeHref(f.reviewUrl) ?? safeHref(f.mapsUrl);
  const reviews = f.rating && f.reviewCount
    ? `<section class="section reviews" aria-labelledby="reviews-title">
  <div class="wrap">
    <div class="score">
      <span class="score-num">${esc(f.rating.toFixed(1))}</span>
      <div><div class="score-stars">${ICON.star.repeat(5)}</div><h2 id="reviews-title" style="font-size:1.1rem;font-variation-settings:'wdth' 100">${esc(f.reviewCount)} Google review${f.reviewCount === 1 ? "" : "s"}</h2><p>See what customers wrote, in their own words.</p></div>
    </div>
    ${reviewHref ? `<a class="btn btn-accent" href="${reviewHref}" rel="noopener" target="_blank">Read our Google reviews</a>` : ""}
  </div>
</section>`
    : "";

  const faqs = copy.faqs.length
    ? `<section class="section flow" aria-labelledby="faq-title"${reviews ? "" : ''}>
  <div class="wrap faq">
    <div class="section-head"><h2 id="faq-title">Questions</h2></div>
    ${copy.faqs.map((q) => `<details><summary>${esc(q.question)}</summary><p>${esc(q.answer)}</p></details>`).join("")}
  </div>
</section>`
    : "";

  const credit = opts.creditUrl ? safeHref(opts.creditUrl) : null;
  const footer = `<footer class="foot">
  <div class="wrap">
    <div>
      <p class="foot-name">${esc(f.name)}</p>
      ${tel ? `<p><a href="${esc(tel)}" class="phone-num">${esc(f.phoneDisplay)}</a></p>` : ""}
      ${f.serviceArea ? `<p>${esc(f.serviceArea)}</p>` : ""}
      ${website ? `<p><a href="${website}" rel="noopener">${isPricePage ? "Visit our main site" : "Our website"}</a></p>` : ""}
    </div>
    ${credit ? `<p class="credit"><a href="${credit}" rel="noopener">Site by CrankLeads</a></p>` : ""}
  </div>
</footer>`;

  const bar = tel || quoteHref
    ? `<nav class="bar" aria-label="Quick actions">${tel ? `<a class="btn btn-call" href="${esc(tel)}">${ICON.phone}<span>Call</span></a>` : ""}${quoteHref && hasForm ? `<a class="btn btn-accent" href="#quote">Get a quote</a>` : ""}${!hasForm && booking ? `<a class="btn btn-accent" href="${booking}">Book online</a>` : ""}</nav>`
    : "";

  const body = isPricePage ? [hero, services, about, reviews, faqs, quoteForm(content, opts)] : [hero, services, steps, about, reviews, faqs, quoteForm(content, opts)];

  return `<!doctype html>
<html lang="en-CA">
<head>
${head(content, opts, theme)}
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
${opts.preview ? '<div class="preview">Preview. Only you can see this until the page is published.</div>' : ""}
<div class="top"><div class="wrap">
  <a class="brand" href="#main" aria-label="${esc(f.name)}">${logo ? `<img src="${logo}" alt="${esc(f.name)} logo">` : `<span class="wordmark">${esc(f.name)}</span>`}</a>
  ${topLinks ? `<div class="top-links">${topLinks}</div>` : ""}
</div></div>
<main id="main">
${body.filter(Boolean).join("\n")}
</main>
${footer}
${bar}
${hasForm && opts.turnstileSiteKey ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>' : ""}
${hasForm ? `<script>${FORM_JS}</script>` : ""}
</body>
</html>`;
}

/** Neutral not-found page (unknown, draft and unpublished slugs all look the same). */
export function renderSiteNotFound(): string {
  return `<!doctype html><html lang="en-CA"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Page not found</title>
<style>body{margin:0;font:400 17px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#f2f4f6;color:#15202a;display:grid;place-items:center;min-height:100vh;padding:24px;box-sizing:border-box}main{max-width:26rem}h1{font-size:1.4rem;margin:0 0 8px}p{margin:0;color:#46525e}</style></head>
<body><main><h1>This page isn't available</h1><p>The address may be mistyped, or the page has been taken down.</p></main></body></html>`;
}
