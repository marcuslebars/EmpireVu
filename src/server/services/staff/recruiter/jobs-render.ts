/**
 * The public jobs pages on a company's generated site (docs/ai-staff.md → "Hiring & payroll"):
 *   /s/<slug>/jobs          open jobs
 *   /s/<slug>/jobs/<id>     one job + the apply form (a plain HTML form POST, works without JS)
 * Server-rendered HTML in the site's colours. Every value goes through esc() / safeHref(); the
 * only script is the optional Turnstile widget. PURE.
 */
import { esc, safeHref, siteTheme } from "@/server/services/dfy/site-render";
import type { SiteContent } from "@/server/services/dfy/site-content";
import type { JobPostingRow } from "./db-types";
import { AI_DISCLOSURE, VACANCY_STATEMENT } from "./jobs";

export interface JobsPageContext {
  content: SiteContent;
  /** Public URL of the company site (…/s/<slug> or the pages host). */
  siteUrl: string;
  turnstileSiteKey: string | null;
}

export interface FormState {
  values?: Record<string, string>;
  error?: string | null;
  /** When the form was rendered (the timing check's start without JS). */
  renderedAtMs?: number;
}

function page(ctx: JobsPageContext, title: string, body: string, opts: { noindex?: boolean; turnstile?: boolean } = {}): string {
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
main .wrap{padding-top:24px;padding-bottom:48px}h1{font-size:1.6rem;line-height:1.2;margin:0 0 6px}h2{font-size:1.1rem;margin:22px 0 6px}
.card{background:#fff;border-radius:12px;padding:18px 20px;margin:14px 0;box-shadow:0 1px 2px rgba(0,0,0,.06)}
.meta{color:#46525e;margin:0 0 10px}ul{margin:4px 0 0;padding-left:1.2em}li{margin:2px 0}
label{display:block;font-weight:600;margin:14px 0 4px}.hint{font-weight:400;color:#5b6772;font-size:.9rem}
input[type=text],input[type=tel],input[type=email],textarea{width:100%;font:inherit;padding:10px 12px;border:1px solid #c9d1d9;border-radius:8px;background:#fff}
textarea{min-height:110px}.choices{display:flex;gap:18px}.choices label{display:inline-flex;gap:6px;font-weight:400;margin:4px 0}
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

function facts(job: JobPostingRow): string {
  return [job.pay_text, job.employment_type, job.location, job.start_text ? `Starts ${job.start_text.replace(/^start(ing)?\s+/i, "")}` : null].filter(Boolean).map(esc).join(" · ");
}

function bullets(items: string[]): string {
  return items.length ? `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : "";
}

export function renderJobsList(ctx: JobsPageContext, jobs: JobPostingRow[]): string {
  const name = ctx.content.facts.name;
  const list = jobs.length
    ? jobs
        .map(
          (j) => `<div class="card"><h2><a href="${esc(`${ctx.siteUrl}/jobs/${j.id}`)}">${esc(j.title)}</a></h2><p class="meta">${facts(j)}</p>${j.summary ? `<p>${esc(j.summary)}</p>` : ""}<a class="btn" href="${esc(`${ctx.siteUrl}/jobs/${j.id}`)}">View and apply</a></div>`,
        )
        .join("\n")
    : `<div class="card"><p>${esc(name)} isn't hiring right now. Check back soon.</p></div>`;
  return page(ctx, `Jobs at ${name}`, `<h1>Jobs at ${esc(name)}</h1>\n${list}`);
}

function radio(name: string, value: string | undefined): string {
  return `<div class="choices"><label><input type="radio" name="${name}" value="yes"${value === "yes" ? " checked" : ""}> Yes</label><label><input type="radio" name="${name}" value="no"${value === "no" ? " checked" : ""}> No</label></div>`;
}

export function renderJobPage(ctx: JobsPageContext, job: JobPostingRow, state: FormState = {}): string {
  const name = ctx.content.facts.name;
  const v = state.values ?? {};
  const val = (k: string) => esc(v[k] ?? "");
  const questions = job.custom_questions
    .slice(0, 3)
    .map((q, i) => `<label for="q${i}">${esc(q)}</label><input type="text" id="q${i}" name="q${i}" maxlength="500" value="${val(`q${i}`)}">`)
    .join("\n");
  const turnstile = ctx.turnstileSiteKey ? `<div class="cf-turnstile" data-sitekey="${esc(ctx.turnstileSiteKey)}"></div>` : "";
  const body = `<p class="small"><a href="${esc(`${ctx.siteUrl}/jobs`)}">All jobs at ${esc(name)}</a></p>
<h1>${esc(job.title)}</h1>
<p class="meta">${esc(name)}${facts(job) ? ` · ${facts(job)}` : ""}</p>
<div class="card">
${job.summary ? `<p>${esc(job.summary)}</p>` : ""}
${job.duties.length ? `<h2>What you'll do</h2>${bullets(job.duties)}` : ""}
${job.requirements.length ? `<h2>What you need</h2>${bullets(job.requirements)}` : ""}
${job.nice_to_have.length ? `<h2>Nice to have</h2>${bullets(job.nice_to_have)}` : ""}
<p class="small">${esc(VACANCY_STATEMENT)} ${esc(AI_DISCLOSURE)}</p>
</div>
<div class="card">
<h2>Apply</h2>
${state.error ? `<div class="err" role="alert">${esc(state.error)}</div>` : ""}
<form method="post" action="${esc(`${ctx.siteUrl}/jobs/${job.id}`)}">
<label for="name">Your name</label><input type="text" id="name" name="name" required maxlength="120" autocomplete="name" value="${val("name")}">
<label for="phone">Cell phone <span class="hint">(we'll text you about your application)</span></label><input type="tel" id="phone" name="phone" required maxlength="20" autocomplete="tel" value="${val("phone")}">
<label for="email">Email <span class="hint">(optional)</span></label><input type="email" id="email" name="email" maxlength="254" autocomplete="email" value="${val("email")}">
<label for="experience">Your experience <span class="hint">(jobs, skills, tickets)</span></label><textarea id="experience" name="experience" maxlength="2000">${val("experience")}</textarea>
<label for="availability">When can you start, and what days can you work?</label><input type="text" id="availability" name="availability" maxlength="500" value="${val("availability")}">
<label>Do you have a valid driver's licence?</label>${radio("licence", v.licence)}
<label>Do you have your own vehicle to get to job sites?</label>${radio("vehicle", v.vehicle)}
${questions}
<div class="hp" aria-hidden="true"><label for="website">Website</label><input type="text" id="website" name="website" tabindex="-1" autocomplete="off"></div>
<input type="hidden" name="t" value="${esc(v.t || String(state.renderedAtMs ?? Date.now()))}">
${turnstile}
<button type="submit">Send my application</button>
<p class="small">By applying you agree that ${esc(name)} may text or email you about this job. Reply STOP to opt out.</p>
</form>
</div>`;
  return page(ctx, `${job.title} - ${name}`, body, { turnstile: Boolean(ctx.turnstileSiteKey) });
}

export function renderApplied(ctx: JobsPageContext, job: JobPostingRow, firstName: string): string {
  const name = ctx.content.facts.name;
  return page(
    ctx,
    `Thanks for applying - ${name}`,
    `<h1>Thanks, ${esc(firstName)}!</h1><div class="card"><p>${esc(name)} got your application for the ${esc(job.title)} job. We'll be in touch by text.</p><p><a href="${esc(ctx.siteUrl)}">Back to ${esc(name)}</a></p></div>`,
    { noindex: true },
  );
}

export function renderJobClosed(ctx: JobsPageContext): string {
  const name = ctx.content.facts.name;
  return page(ctx, `Jobs at ${name}`, `<h1>This job is closed</h1><div class="card"><p>${esc(name)} isn't taking applications for it any more.</p><p><a href="${esc(`${ctx.siteUrl}/jobs`)}">See open jobs</a></p></div>`, { noindex: true });
}
