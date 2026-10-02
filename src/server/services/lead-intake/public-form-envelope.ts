import { z } from "zod";

import type { LeadEnvelope } from "./envelope";

/**
 * Website lead forms (hosted page /f/:formKey + /embed/v1.js) — the pure parts: the
 * publishable key format, origin normalization, the submission schema, the SMS-consent
 * wording, and the mapping from a browser submission to a schemaVersion-1 lead envelope.
 * No I/O here; the service-role lookups live in ./public-forms.ts.
 */

export const PUBLIC_FORM_KEY_PREFIX = "evpk_";
export const PUBLIC_FORM_KEY_PATTERN = /^evpk_[0-9a-f]{24,64}$/;

/** The `source` stamped on the envelope AND on the contact.created trigger event, so the
 *  paid-action guard (workflow-engine/guards.ts) treats these leads as unauthenticated. */
export const PUBLIC_FORM_SOURCE = "public_form";

export const PUBLIC_FORM_TYPES = ["quote", "contact"] as const;
export type PublicFormType = (typeof PUBLIC_FORM_TYPES)[number];

/** Hard cap on the request body. A real submission is well under 4 KB. */
export const PUBLIC_FORM_MAX_BODY_BYTES = 16 * 1024;

export function isPublicFormKeyFormat(key: string): boolean {
  return PUBLIC_FORM_KEY_PATTERN.test(key);
}

/**
 * Normalize an origin (or a full URL) to `scheme://host[:port]`, lowercase, no trailing
 * slash. Only http(s). Returns null for anything that isn't a usable web origin.
 * "example.com" (no scheme) is treated as https.
 */
export function normalizeOrigin(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "null") return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (!url.hostname) return null;
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * The exact SMS opt-in wording shown on the form. Kept server-side and handed to the page
 * by the public GET, so what the visitor reads and what raw_leads records are the same
 * string. Plain CASL/CTIA language: who, what, frequency, cost, how to stop.
 */
export function smsConsentText(companyName: string): string {
  return (
    `Yes, ${companyName} may text me about my request at the number above. ` +
    "Message frequency varies. Message and data rates may apply. Reply STOP to opt out, HELP for help. " +
    "Consent is not a condition of purchase."
  );
}

const optionalTrimmed = (max: number) =>
  z
    .string()
    .max(max)
    .optional()
    .transform((v) => (typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined));

/**
 * What the browser posts. Tenant fields are NOT part of this schema — any
 * organizationId/companyId/sourceSite in the body is stripped and ignored; the tenant
 * comes from the key row only.
 */
export const publicFormSubmissionSchema = z
  .object({
    name: optionalTrimmed(200),
    phone: optionalTrimmed(40),
    email: z
      .string()
      .max(320)
      .optional()
      .transform((v) => (typeof v === "string" && v.trim().length > 0 ? v.trim().toLowerCase() : undefined))
      .pipe(z.string().email().optional()),
    service: optionalTrimmed(120),
    message: optionalTrimmed(4000),
    preferredDate: z
      .string()
      .max(40)
      .optional()
      .transform((v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? v.trim() : undefined)),
    smsConsent: z.boolean().optional(),
    /** The page the form sits on (parent page when embedded). */
    page: optionalTrimmed(2000),
    /** Origin of the site embedding the iframe, as observed by the hosted page. */
    embedOrigin: optionalTrimmed(300),
    utm: z.record(z.string().max(40), z.string().max(200)).optional(),
    // Abuse signals (see turnstile.ts).
    website: z.string().max(500).optional(),
    formStartedAt: z.union([z.number(), z.string().max(40)]).optional(),
    turnstileToken: z.string().max(4000).optional(),
  })
  .refine((v) => Boolean(v.phone || v.email), {
    message: "Please enter a phone number or an email address so we can reach you.",
    path: ["phone"],
  })
  .refine((v) => !v.phone || v.phone.replace(/\D/g, "").length >= 7, {
    message: "Please enter a valid phone number.",
    path: ["phone"],
  });

export type PublicFormSubmission = z.infer<typeof publicFormSubmissionSchema>;

const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "fbclid"];

/** Only the known attribution keys survive, each capped. */
export function pickUtm(utm: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!utm) return undefined;
  const out: Record<string, string> = {};
  for (const key of UTM_KEYS) {
    const value = utm[key];
    if (typeof value === "string" && value.trim()) out[key] = value.trim().slice(0, 200);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Split a page URL into site (host) + page (path) for the envelope's meta. */
export function splitPage(page: string | undefined): { site?: string; page?: string } {
  if (!page) return {};
  try {
    const url = new URL(page);
    if (url.protocol !== "https:" && url.protocol !== "http:") return {};
    return {
      site: url.host.slice(0, 200),
      page: `${url.pathname}`.slice(0, 300),
    };
  } catch {
    return {};
  }
}

export interface PublicFormEnvelopeContext {
  formType: PublicFormType;
  companyName: string;
  companySlug: string | null;
  now?: Date;
}

/**
 * Map a validated submission onto the canonical schemaVersion-1 envelope. `sourceSite`
 * is the company slug (a free-text tag in pinned mode — it does NOT route), falling back
 * to "embed". The chosen service rides in `services` and in the human-readable message.
 */
export function buildPublicFormEnvelope(
  input: PublicFormSubmission,
  context: PublicFormEnvelopeContext,
): LeadEnvelope {
  const now = (context.now ?? new Date()).toISOString();
  const lines: string[] = [];
  if (input.service) lines.push(`Service: ${input.service}`);
  if (input.preferredDate) lines.push(`Preferred date: ${input.preferredDate}`);
  if (input.message) lines.push(input.message);
  const message = lines.length > 0 ? lines.join("\n").slice(0, 10000) : undefined;

  const { site, page } = splitPage(input.page);
  const utm = pickUtm(input.utm);

  const contact: LeadEnvelope["contact"] = {};
  if (input.name) contact.name = input.name;
  if (input.email) contact.email = input.email;
  if (input.phone) contact.phone = input.phone;

  const meta: NonNullable<LeadEnvelope["meta"]> = {};
  if (site) meta.site = site;
  if (page) meta.page = page;
  if (utm) meta.utm = utm;
  if (input.preferredDate) meta.preferredDate = input.preferredDate;
  // Only record consent when a phone was given — there is nothing to text otherwise.
  if (input.phone) {
    meta.smsConsent = {
      granted: input.smsConsent === true,
      ...(input.smsConsent === true ? { text: smsConsentText(context.companyName).slice(0, 600) } : {}),
      capturedAt: now,
    };
  }

  const sourceSite = (context.companySlug && context.companySlug.trim()) || "embed";

  return {
    schemaVersion: 1,
    source: PUBLIC_FORM_SOURCE,
    sourceSite: sourceSite.slice(0, 80),
    formType: context.formType,
    receivedAt: now,
    contact,
    ...(message ? { message } : {}),
    ...(input.service ? { services: [input.service] } : {}),
    ...(Object.keys(meta).length > 0 ? { meta } : {}),
  };
}

// ── Origin policy ────────────────────────────────────────────────────────────

/**
 * The app's own origins: APP_BASE_URL, the forwarded/Host origin of this request, and the
 * request URL's origin. A submission from one of these is the hosted page (/f/:key, or
 * the iframe the embed script renders) and is always allowed.
 */
export function selfOrigins(request: Request, appBaseUrl: string | undefined = process.env.APP_BASE_URL): string[] {
  const out = new Set<string>();
  const add = (value: string | null | undefined) => {
    const origin = normalizeOrigin(value);
    if (origin) out.add(origin);
  };
  add(appBaseUrl);
  try {
    add(new URL(request.url).origin);
  } catch {
    /* ignore */
  }
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (host) {
    const proto = (request.headers.get("x-forwarded-proto") ?? "https").split(",")[0]?.trim() || "https";
    add(`${proto}://${host.split(",")[0]?.trim()}`);
  }
  return [...out];
}

export interface OriginDecision {
  ok: boolean;
  /** The origin to echo in Access-Control-Allow-Origin (cross-origin callers only). */
  corsOrigin: string | null;
  reason?: "missing_origin" | "origin_not_allowed" | "embed_origin_not_allowed";
}

/**
 * Decide whether a request may use this form.
 *  - Same-origin (the hosted page / embed iframe): allowed. When the form has an
 *    allowed_origins list and the page reports the site it is embedded in, that site must
 *    be on the list (stops a copied snippet working on someone else's site).
 *  - Cross-origin (a site posting directly): allowed when the list is empty or contains
 *    the Origin; CORS echoes it.
 *  - No Origin: refused for writes (every browser sends Origin on POST); allowed for reads
 *    (same-origin GETs carry no Origin).
 * This is a browser-level control, not the security boundary — the key is publishable by
 * design; rate limits, Turnstile, honeypot and tenant pinning are what protect the tenant.
 */
export function evaluateOrigin(args: {
  requestOrigin: string | null;
  embedOrigin?: string | null;
  allowedOrigins: string[];
  selfOrigins: string[];
  write: boolean;
}): OriginDecision {
  const allowed = args.allowedOrigins.map((o) => normalizeOrigin(o)).filter((o): o is string => Boolean(o));
  const origin = normalizeOrigin(args.requestOrigin);

  if (!origin) {
    return args.write ? { ok: false, corsOrigin: null, reason: "missing_origin" } : { ok: true, corsOrigin: null };
  }

  if (args.selfOrigins.includes(origin)) {
    const embed = normalizeOrigin(args.embedOrigin);
    if (allowed.length > 0 && embed && !args.selfOrigins.includes(embed) && !allowed.includes(embed)) {
      return { ok: false, corsOrigin: null, reason: "embed_origin_not_allowed" };
    }
    return { ok: true, corsOrigin: null };
  }

  if (allowed.length === 0 || allowed.includes(origin)) {
    return { ok: true, corsOrigin: origin };
  }
  return { ok: false, corsOrigin: null, reason: "origin_not_allowed" };
}

export function publicFormCorsHeaders(corsOrigin: string | null): Record<string, string> {
  const headers: Record<string, string> = { Vary: "Origin" };
  if (corsOrigin) {
    headers["Access-Control-Allow-Origin"] = corsOrigin;
    headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type";
    headers["Access-Control-Max-Age"] = "600";
  }
  return headers;
}
