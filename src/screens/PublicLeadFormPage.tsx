import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { CheckCircle2, Loader2, Phone } from "lucide-react";
import { platformBrand } from "@/lib/platform-brand";
import { useDocumentTitle } from "@/lib/use-document-title";

import TurnstileWidget from "@/components/TurnstileWidget";
import { fetchPublicFormConfig, submitPublicForm, type PublicFormConfig } from "@/lib/website-forms-api";

/**
 * Hosted lead page — /f/:formKey. Public, no login. Works three ways:
 *   1. a plain link the owner puts on Google Business Profile / Facebook / a text message;
 *   2. inside the iframe /embed/v1.js renders on the owner's website (`?embed=1` hides
 *      the header and reports its height to the parent so the iframe auto-resizes);
 *   3. the "Send a test lead" button in Settings posts to the same endpoint.
 * Shows only display-safe company info (name, logo, public phone, service labels).
 */

/** Platform credit in the footer. Single constant — branding is centralized later. */
const POWERED_BY_NAME = platformBrand.name;

const OTHER = "__other__";
const RESIZE_MESSAGE = "evform:resize";
const SUBMITTED_MESSAGE = "evform:submitted";
const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "fbclid"];

type Status = "loading" | "ready" | "error";

function originOf(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : undefined;
  } catch {
    return undefined;
  }
}

function isFramed(): boolean {
  try {
    return window.parent !== window;
  } catch {
    return true;
  }
}

/** Read embed context once: parent page, the site embedding us, and attribution. */
function readContext() {
  const params = new URLSearchParams(window.location.search);
  const embed = params.get("embed") === "1";
  const framed = isFramed();
  const parentPage = params.get("page") || undefined;
  const utm: Record<string, string> = {};
  for (const key of UTM_KEYS) {
    const value = params.get(key);
    if (value) utm[key] = value.slice(0, 200);
  }
  // Whenever we're framed (with or without ?embed=1), take the embedding origin from the
  // BROWSER only: ancestorOrigins (Chrome/Safari), else the referrer origin (Firefox).
  // The `page` URL param is set by the embedder and is never trusted for this check.
  let embedOrigin: string | undefined;
  if (framed) {
    const ancestors = (window.location as Location & { ancestorOrigins?: DOMStringList }).ancestorOrigins;
    embedOrigin = (ancestors && ancestors.length > 0 ? ancestors[0] : undefined) ?? originOf(document.referrer);
  }
  const page = parentPage ?? (framed ? document.referrer || undefined : window.location.href);
  return { embed, framed, page, utm: Object.keys(utm).length > 0 ? utm : undefined, embedOrigin };
}

export default function PublicLeadFormPage() {
  const { formKey = "" } = useParams();
  const ctx = useMemo(readContext, []);

  const [status, setStatus] = useState<Status>("loading");
  const [config, setConfig] = useState<PublicFormConfig | null>(null);
  const [loadError, setLoadError] = useState("");

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [service, setService] = useState("");
  const [otherService, setOtherService] = useState("");
  const [message, setMessage] = useState("");
  const [preferredDate, setPreferredDate] = useState("");
  const [smsConsent, setSmsConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [done, setDone] = useState(false);

  // Abuse signals: honeypot, "form shown at" timestamp, Turnstile token when configured.
  const websiteRef = useRef<HTMLInputElement>(null);
  const [formStartedAt] = useState(() => Date.now());
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const handleTurnstileToken = useCallback((token: string | null) => setTurnstileToken(token), []);

  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    setStatus("loading");
    fetchPublicFormConfig(formKey)
      .then((data) => {
        if (!active) return;
        setConfig(data);
        setStatus("ready");
      })
      .catch((err: unknown) => {
        if (!active) return;
        const statusCode = (err as { status?: number })?.status;
        setLoadError(
          statusCode === 404
            ? "This form isn't available anymore."
            : statusCode === 403
              ? "This form isn't available on this website."
              : "Couldn't load the form. Please refresh and try again.",
        );
        setStatus("error");
      });
    return () => {
      active = false;
    };
  }, [formKey]);

  // Embedded: report our height so /embed/v1.js can size the iframe (no scrollbars).
  useEffect(() => {
    if (!ctx.embed || window.parent === window || !rootRef.current) return;
    const post = () => {
      const height = Math.ceil(rootRef.current?.getBoundingClientRect().height ?? 0);
      window.parent.postMessage({ type: RESIZE_MESSAGE, form: formKey, height }, "*");
    };
    post();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(post) : null;
    observer?.observe(rootRef.current);
    window.addEventListener("load", post);
    return () => {
      observer?.disconnect();
      window.removeEventListener("load", post);
    };
  }, [ctx.embed, formKey, status, done]);

  useDocumentTitle(config?.company.name ? `${config.company.name} — ${config.form.formType === "contact" ? "Contact us" : "Get a quote"}` : null);

  const accent = config?.company.primaryColor ?? "#0f172a";
  const isQuote = config?.form.formType !== "contact";
  const hasReach = phone.trim().length > 0 || email.trim().length > 0;
  // A form restricted to listed websites can't prove where it is embedded when the
  // browser hides the parent origin — block rather than submit blind.
  const unverifiableEmbed = Boolean(config?.form.restrictedToSites && ctx.framed && !ctx.embedOrigin);
  const canSubmit = hasReach && !submitting && !unverifiableEmbed;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!hasReach) {
      setSubmitError("Please enter a phone number or an email address so we can reach you.");
      return;
    }
    setSubmitting(true);
    setSubmitError("");
    try {
      const chosen = service === OTHER ? otherService.trim() || "Other" : service || undefined;
      await submitPublicForm(formKey, {
        name: name.trim() || undefined,
        phone: phone.trim() || undefined,
        email: email.trim() || undefined,
        service: chosen,
        message: message.trim() || undefined,
        preferredDate: preferredDate || undefined,
        smsConsent: phone.trim() ? smsConsent : undefined,
        page: ctx.page,
        embedOrigin: ctx.embedOrigin,
        framed: ctx.framed,
        utm: ctx.utm,
        website: websiteRef.current?.value || undefined,
        formStartedAt,
        turnstileToken: turnstileToken ?? undefined,
      });
      setDone(true);
      if (ctx.embed && window.parent !== window) {
        window.parent.postMessage({ type: SUBMITTED_MESSAGE, form: formKey }, "*");
      }
    } catch (err) {
      setSubmitError(err instanceof Error && err.message ? err.message : "Couldn't send your request. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const inputCls =
    "w-full px-3 py-2.5 text-base sm:text-sm bg-white border border-slate-300 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-400/40 focus:border-slate-400";
  const labelCls = "text-sm font-medium text-slate-700 mb-1 block";
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div
      className={ctx.embed ? "w-full bg-transparent text-slate-900" : "min-h-screen w-full bg-slate-100 text-slate-900 flex items-start sm:items-center justify-center p-3 sm:p-8"}
      style={{ colorScheme: "light" }}
    >
      <div ref={rootRef} className={ctx.embed ? "w-full p-1" : "w-full max-w-lg"}>
        {status === "loading" && (
          <div className="flex items-center justify-center gap-2 text-slate-500 py-16">
            <Loader2 className="w-5 h-5 animate-spin" /> Loading…
          </div>
        )}

        {status === "error" && (
          <div className="bg-white border border-slate-200 rounded-2xl p-8 text-center">
            <p className="text-sm text-slate-700">{loadError}</p>
          </div>
        )}

        {status === "ready" && config && (
          <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm">
            {!ctx.embed && (
              <div className="px-5 sm:px-6 py-5 border-b border-slate-200 flex items-center gap-3">
                {config.company.logoUrl && (
                  <img src={config.company.logoUrl} alt="" className="w-12 h-12 rounded-lg object-contain bg-white border border-slate-100" />
                )}
                <div className="min-w-0 flex-1">
                  <h1 className="text-lg font-bold text-slate-900 truncate">{config.company.name}</h1>
                  <p className="text-sm text-slate-500">{isQuote ? "Request a free quote" : "Get in touch"}</p>
                </div>
                {config.company.phone && (
                  <a
                    href={`tel:${config.company.phone.replace(/[^\d+]/g, "")}`}
                    className="shrink-0 inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold border border-slate-300 text-slate-800 hover:bg-slate-50"
                  >
                    <Phone className="w-4 h-4" /> Call
                  </a>
                )}
              </div>
            )}

            {done ? (
              <div className="p-8 text-center space-y-3">
                <CheckCircle2 className="w-12 h-12 mx-auto" style={{ color: accent }} />
                <h2 className="text-lg font-semibold text-slate-900">Thanks{name.trim() ? `, ${name.trim().split(/\s+/)[0]}` : ""} — we got it!</h2>
                <p className="text-sm text-slate-600">
                  {config.company.name} will get back to you shortly{phone.trim() ? " by phone or text" : email.trim() ? " by email" : ""}.
                </p>
                {config.company.phone && (
                  <p className="text-sm text-slate-600">
                    Need us sooner? Call{" "}
                    <a className="font-semibold underline" href={`tel:${config.company.phone.replace(/[^\d+]/g, "")}`}>{config.company.phone}</a>.
                  </p>
                )}
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="p-5 sm:p-6 space-y-4" noValidate>
                <div>
                  <label className={labelCls} htmlFor="evf-name">Your name</label>
                  <input id="evf-name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} className={inputCls} placeholder="Jane Smith" />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className={labelCls} htmlFor="evf-phone">Phone</label>
                    <input id="evf-phone" type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} className={inputCls} placeholder="(555) 555-0123" />
                  </div>
                  <div>
                    <label className={labelCls} htmlFor="evf-email">Email</label>
                    <input id="evf-email" type="email" inputMode="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputCls} placeholder="jane@example.com" />
                  </div>
                </div>
                <p className="text-xs text-slate-500 -mt-2">Phone or email — whichever you prefer.</p>

                <div>
                  <label className={labelCls} htmlFor="evf-service">What do you need?</label>
                  <select id="evf-service" value={service} onChange={(e) => setService(e.target.value)} className={inputCls}>
                    <option value="">Choose a service…</option>
                    {config.services.map((label) => (
                      <option key={label} value={label}>{label}</option>
                    ))}
                    <option value={OTHER}>Other</option>
                  </select>
                  {service === OTHER && (
                    <input value={otherService} onChange={(e) => setOtherService(e.target.value)} maxLength={120} className={`${inputCls} mt-2`} placeholder="Tell us the service" />
                  )}
                </div>

                <div>
                  <label className={labelCls} htmlFor="evf-message">Details <span className="font-normal text-slate-400">(optional)</span></label>
                  <textarea id="evf-message" value={message} onChange={(e) => setMessage(e.target.value)} rows={3} maxLength={4000} className={`${inputCls} resize-none`} placeholder="Address, size of the job, anything we should know" />
                </div>

                <div>
                  <label className={labelCls} htmlFor="evf-date">Preferred date <span className="font-normal text-slate-400">(optional)</span></label>
                  <input id="evf-date" type="date" min={today} value={preferredDate} onChange={(e) => setPreferredDate(e.target.value)} className={inputCls} />
                </div>

                {phone.trim() && (
                  <label className="flex items-start gap-2.5 text-xs text-slate-600 leading-relaxed cursor-pointer">
                    <input type="checkbox" checked={smsConsent} onChange={(e) => setSmsConsent(e.target.checked)} className="mt-0.5 w-4 h-4 shrink-0 accent-slate-800" />
                    <span>{config.form.smsConsentText}</span>
                  </label>
                )}

                {/* Honeypot — hidden from people, filled by bots. */}
                <input
                  ref={websiteRef}
                  type="text"
                  name="website"
                  tabIndex={-1}
                  autoComplete="off"
                  aria-hidden="true"
                  className="absolute -left-[9999px] w-px h-px opacity-0"
                />

                <TurnstileWidget onToken={handleTurnstileToken} />

                {unverifiableEmbed && (
                  <p className="text-sm text-amber-700" role="alert">
                    This form can&rsquo;t confirm the website it&rsquo;s on, so it can&rsquo;t send from here.
                    {config.company.phone ? ` Please call ${config.company.phone}` : " Please contact the business directly"}
                    {" "}or open the form in a new tab.
                  </p>
                )}
                {submitError && <p className="text-sm text-red-600" role="alert">{submitError}</p>}

                <button
                  type="submit"
                  disabled={!canSubmit}
                  className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg text-base font-semibold text-white disabled:opacity-50 transition-opacity"
                  style={{ backgroundColor: accent }}
                >
                  {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
                  {isQuote ? "Get my quote" : "Send"}
                </button>
              </form>
            )}
          </div>
        )}

        <p className="text-center text-[11px] text-slate-400 mt-3 mb-1">Powered by {POWERED_BY_NAME}</p>
      </div>
    </div>
  );
}
