import { randomBytes } from "node:crypto";

import { NextResponse } from "next/server";
import type { z } from "zod";
import { ZodError } from "zod";

import { GENERIC_ERROR_MESSAGE, UserFacingError } from "@/server/errors";
import { TooManyRequestsError, ValidationError } from "@/server/organizations/context";

/**
 * Run a route handler and turn whatever it throws into a response a person can read.
 *
 *   • UserFacingError (and its subclasses — ValidationError, AuthorizationError, the
 *     invoice / quote domain errors…): its message, status, code and details go to
 *     the client as written. Those messages were written for the user.
 *   • ZodError (bad request body): a sentence naming the field ("Length (ft) is
 *     required"), never a path like "services.0.lengthFt".
 *   • Anything else — a database error, a Stripe error, a bug: logged here with the
 *     route and a short error id, and the client gets a generic apology plus that
 *     `errorId`, so support can find the log line without the user ever seeing
 *     internals.
 *
 * `label` names the route in the log; it defaults to the request's method + path
 * when a Request is passed instead.
 */
export async function handleRoute(
  handler: () => Promise<NextResponse>,
  label?: string | Request,
): Promise<NextResponse> {
  try {
    return await handler();
  } catch (error) {
    return errorResponse(error, label);
  }
}

/** The response handleRoute gives for a thrown error. Exported for routes that catch first. */
export function errorResponse(error: unknown, label?: string | Request): NextResponse {
  if (error instanceof ZodError) {
    return NextResponse.json({ error: readableZodMessage(error) }, { status: 400 });
  }

  if (error instanceof UserFacingError) {
    const headers =
      error instanceof TooManyRequestsError ? { "Retry-After": String(Math.max(1, Math.ceil(error.retryAfterSeconds))) } : undefined;
    return NextResponse.json(
      { ...(error.details ?? {}), error: error.message, ...(error.code ? { code: error.code } : {}) },
      { status: error.status, headers },
    );
  }

  const errorId = newErrorId();
  const where = typeof label === "string" ? label : label ? `${label.method} ${safePath(label.url)}` : "api";
  console.error(`[api] ${where} failed (errorId ${errorId}):`, error);
  return NextResponse.json({ error: GENERIC_ERROR_MESSAGE, errorId }, { status: 500 });
}

/** Short and unambiguous enough to read out over the phone. */
function newErrorId(): string {
  return randomBytes(4).toString("hex");
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "api";
  }
}

export async function parseJsonBody<S extends z.ZodTypeAny>(
  request: Request,
  schema: S,
): Promise<z.output<S>> {
  const body = await request.json();
  return schema.parse(body);
}

export function parseLimit(value: string | null, fallback = 50): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);

  if (Number.isNaN(parsed) || parsed < 1) {
    throw new ValidationError("limit must be a positive integer.");
  }

  return Math.min(parsed, 100);
}

export function parsePage(value: string | null, fallback = 1): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);

  if (Number.isNaN(parsed) || parsed < 1) {
    throw new ValidationError("page must be a positive integer.");
  }

  return parsed;
}

export function parseBoolean(value: string | null, fallback?: boolean): boolean | undefined {
  if (value === null) {
    return fallback;
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  throw new ValidationError("boolean query parameters must be 'true' or 'false'.");
}

export function parseIsoDate(value: string | null, fieldName: string, fallback?: string): string {
  const candidate = value ?? fallback;

  if (!candidate) {
    throw new ValidationError(`${fieldName} is required.`);
  }

  const parsed = new Date(candidate);

  if (Number.isNaN(parsed.getTime())) {
    throw new ValidationError(`${fieldName} must be a valid ISO date.`);
  }

  return parsed.toISOString();
}

/**
 * Field names as a person would say them. Keyed by the LAST path segment of a Zod
 * issue, so "services.0.lengthFt" reads as "Length (ft)". Anything not listed is
 * turned from camelCase into words ("introMessage" → "Intro message").
 */
const FIELD_LABELS: Record<string, string> = {
  lengthFt: "Length (ft)",
  distanceKm: "Distance (km)",
  engineType: "Engine type",
  engineCount: "Number of engines",
  quantity: "Quantity",
  serviceId: "Service",
  amountCents: "Amount",
  unitPriceCents: "Unit price",
  label: "Description",
  description: "Details",
  contactId: "Customer",
  companyId: "Company",
  customerAccountId: "Business account",
  bookingId: "Job",
  quoteId: "Quote",
  hullType: "Hull type",
  bundleId: "Package",
  title: "Title",
  introMessage: "Intro message",
  notes: "Notes",
  services: "Services",
  customLines: "Custom lines",
  lines: "Line items",
  email: "Email",
  phone: "Phone",
  name: "Name",
  fullName: "Full name",
  dueDate: "Due date",
  issueDate: "Issue date",
  paymentTermsDays: "Payment terms",
  taxRateBps: "Tax rate",
  method: "Payment method",
  reason: "Reason",
  url: "Website address",
};

export function fieldLabel(path: ReadonlyArray<string | number>): string | null {
  const last = [...path].reverse().find((p): p is string => typeof p === "string");
  if (!last) return null;
  if (FIELD_LABELS[last]) return FIELD_LABELS[last];
  const words = last
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : null;
}

type Issue = ZodError["issues"][number];

function issueSentence(issue: Issue): string {
  const field = fieldLabel(issue.path);
  if (!field) return issue.message;

  const missing =
    (issue.code === "invalid_type" && (issue.received === "undefined" || issue.received === "null")) ||
    (issue.code === "too_small" && issue.type === "string" && Number(issue.minimum) <= 1);
  if (missing) return `${field} is required`;

  switch (issue.code) {
    case "invalid_type":
      return `${field} ${issue.expected === "number" || issue.expected === "integer" ? "must be a number" : "isn't valid"}`;
    case "too_small":
      if (issue.type === "number") return `${field} must be ${issue.inclusive ? "at least" : "more than"} ${String(issue.minimum)}`;
      if (issue.type === "string") return `${field} must be at least ${String(issue.minimum)} characters`;
      if (issue.type === "array") return `${field} needs at least ${String(issue.minimum)}`;
      return `${field} is too small`;
    case "too_big":
      if (issue.type === "number") return `${field} must be ${issue.inclusive ? "at most" : "less than"} ${String(issue.maximum)}`;
      if (issue.type === "string") return `${field} must be ${String(issue.maximum)} characters or fewer`;
      if (issue.type === "array") return `${field} can have at most ${String(issue.maximum)}`;
      return `${field} is too big`;
    case "invalid_enum_value":
      return `${field} isn't one of the allowed choices`;
    case "invalid_string":
      return issue.validation === "email" ? `${field} must be a valid email address` : `${field} isn't valid`;
    case "custom":
      // A refine() message is written by us, for people — keep it.
      return issue.message;
    default:
      return `${field} isn't valid`;
  }
}

/**
 * "Length (ft) is required" rather than "services.0.lengthFt: Required" or a JSON
 * dump: names the field the way the form does and never exposes array indexes.
 */
export function readableZodMessage(error: ZodError): string {
  const sentences = [...new Set(error.issues.slice(0, 3).map((i) => issueSentence(i).replace(/[.\s]+$/, "")))].filter(Boolean);
  return sentences.length ? `${sentences.join(". ")}.` : "Invalid request.";
}
