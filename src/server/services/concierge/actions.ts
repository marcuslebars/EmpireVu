// ─────────────────────────────────────────────────────────────────────────────
// SANCTIONED EXCEPTION (service role): concierge console — audited operator actions.
// Only reachable through POST /api/concierge/accounts/:orgId/actions, which runs
// requireOperator first (OPERATOR_EMAILS; everyone else gets a 404). Each action:
//   • validates its input with its own zod schema (bad input → 400, nothing written);
//   • runs against ONE org the operator named, and ONE company resolved by resolveAccount —
//     a companyId from the request is honoured only if it belongs to that org (else 404);
//     every write is filtered by that organization_id + company id;
//   • is audited: an operator_actions row is written BEFORE the action runs (if the audit
//     can't be written, nothing happens) and then updated with the outcome (ok / failed,
//     before → after where useful).
// Listed in docs/done-for-you.md → "Concierge console".
//
// Registry: name → { label, schema, run }. The done-for-you actions (resend quick-setup link,
// re-run business lookup, build / unpublish website, forwarding text, retry number, run
// switch-on) are registered by dfy-actions.ts; routes import register-all.ts, which loads both.
// ─────────────────────────────────────────────────────────────────────────────
import { z } from "zod";

import { PHONE_CARRIERS, PHONE_KINDS, type ConciergeActionInfo } from "@/lib/concierge";
import type { Json, Tables, Updates } from "@/server/db/database.types";
import { slugify } from "@/server/db/helpers";
import { ValidationError } from "@/server/organizations/context";
import { resendWelcomeEmail } from "@/server/services/crankleads/provision";
import type { AdminClient } from "@/server/services/crankleads/purchases";
import { resolveAccount, type ResolvedAccount } from "@/server/services/concierge/accounts";
import type { OperatorIdentity } from "@/server/services/concierge/auth";
import { needsPrice } from "@/server/services/packs/apply";
import { PRICING_TYPES } from "@/server/services/quotes/catalog-items";
import { toE164 } from "@/server/services/retell/payload";
import type { TenantServiceContext } from "@/server/services/shared";
import { startOwnerForwardingTest } from "@/server/services/twilio/forwarding-test";
import { provisionMissedCallCatcher } from "@/server/services/twilio/provision";

// ── Registry ─────────────────────────────────────────────────────────────────

export interface ConciergeActionContext extends ResolvedAccount {
  admin: AdminClient;
  operator: OperatorIdentity;
  organizationId: string;
  companyId: string;
  /** Service-role context pinned to the org (for reusing tenant services). */
  tenant: TenantServiceContext;
  nowMs: number;
}

export interface ConciergeActionOutcome {
  /** One line for the operator ("Number bought: (705) 555-0100"). */
  message: string;
  /** Returned to the console. */
  result?: unknown;
  /** Merged into the audit row's detail (before/after etc.). Must be JSON-safe. */
  audit?: Record<string, unknown>;
}

export interface ConciergeActionDefinition<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  /** Button label in the console. */
  label: string;
  schema: S;
  run: (ctx: ConciergeActionContext, input: z.output<S>) => Promise<ConciergeActionOutcome>;
}

const registry = new Map<string, ConciergeActionDefinition>();

export function registerConciergeAction<S extends z.ZodTypeAny>(definition: ConciergeActionDefinition<S>): void {
  if (!/^[a-z][a-z0-9_]{1,62}$/.test(definition.name)) throw new Error(`concierge: bad action name "${definition.name}"`);
  if (registry.has(definition.name)) throw new Error(`concierge: action "${definition.name}" is already registered`);
  registry.set(definition.name, definition as unknown as ConciergeActionDefinition);
}

export function getConciergeAction(name: string): ConciergeActionDefinition | null {
  return registry.get(name) ?? null;
}

export function listConciergeActions(): ConciergeActionInfo[] {
  return [...registry.values()].map((d) => ({ name: d.name, label: d.label }));
}

export const actionRequestSchema = z.object({
  action: z.string().min(1).max(64),
  /** Optional: must belong to the org (else 404). Defaults to the org's CrankLeads company. */
  companyId: z.string().uuid().optional(),
  input: z.record(z.string(), z.unknown()).default({}),
});
export type ActionRequest = z.infer<typeof actionRequestSchema>;

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err) return String((err as { message: unknown }).message);
  return String(err);
}

function toJsonValue(value: unknown): Json {
  return JSON.parse(JSON.stringify(value ?? null)) as Json;
}

/**
 * Validate → resolve the org/company → write the audit row → run → record the outcome.
 * Throws (and the route answers) on: unknown action / bad input (400), unknown org or a
 * company outside it (404), audit write failure (500, nothing ran), action failure (its own
 * error — the audit row says "failed").
 */
export async function runConciergeAction(
  admin: AdminClient,
  operator: OperatorIdentity,
  organizationId: string,
  request: ActionRequest,
  nowMs: number = Date.now(),
): Promise<{ action: string; message: string; result?: unknown }> {
  const definition = getConciergeAction(request.action);
  if (!definition) throw new ValidationError("Unknown action.");
  const input = definition.schema.parse(request.input ?? {});

  const resolved = await resolveAccount(admin, organizationId, request.companyId ?? null);
  const companyId = resolved.company.id;

  const { data: auditRow, error: auditError } = await admin
    .from("operator_actions")
    .insert({
      operator_email: operator.email,
      organization_id: organizationId,
      company_id: companyId,
      action: definition.name,
      detail: toJsonValue({ status: "started", input }),
    })
    .select("id")
    .single();
  if (auditError || !auditRow) {
    throw new Error(`concierge: audit write failed: ${auditError ? errorMessage(auditError) : "no row"}`);
  }
  const auditId = (auditRow as { id: string }).id;

  const finish = async (detail: Record<string, unknown>): Promise<void> => {
    const { error } = await admin
      .from("operator_actions")
      .update({ detail: toJsonValue({ input, ...detail }) })
      .eq("id", auditId)
      .eq("organization_id", organizationId);
    if (error) console.error(`[concierge] audit update for ${auditId} failed:`, errorMessage(error));
  };

  const ctx: ConciergeActionContext = {
    ...resolved,
    admin,
    operator,
    organizationId,
    companyId,
    tenant: { organizationId, actorProfileId: null, supabase: admin },
    nowMs,
  };

  try {
    const outcome = await definition.run(ctx, input);
    await finish({ ...(outcome.audit ?? {}), status: "ok", message: outcome.message });
    return { action: definition.name, message: outcome.message, result: outcome.result };
  } catch (err) {
    await finish({ status: "failed", error: errorMessage(err).slice(0, 500) });
    throw err;
  }
}

// ── Input helpers ────────────────────────────────────────────────────────────

/** "" → null; anything else trimmed. */
const blankToNull = (v: unknown): unknown => (typeof v === "string" && v.trim() === "" ? null : typeof v === "string" ? v.trim() : v);

/** Accepts "smithsnow.ca" → "https://smithsnow.ca". http(s) only. */
export function normalizeUrl(raw: string, { httpsOnly = false } = {}): string | null {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withScheme);
    if (httpsOnly ? url.protocol !== "https:" : !["http:", "https:"].includes(url.protocol)) return null;
    if (!url.hostname.includes(".")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function urlField(label: string, opts: { httpsOnly?: boolean } = {}) {
  return z.preprocess(
    blankToNull,
    z
      .string()
      .max(500)
      .transform((v, ctx) => {
        const url = normalizeUrl(v, opts);
        if (!url) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label} must be a valid ${opts.httpsOnly ? "https://" : "web"} address` });
          return z.NEVER;
        }
        return url;
      })
      .nullable(),
  );
}

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Times must look like 08:00");
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

/**
 * companies.hours as the app already stores it: the wizard's `{ summary: "Mon–Fri 8am–5pm" }`,
 * or per-day `{ mon: { open: "08:00", close: "17:00" }, sun: "closed" }`.
 */
export const hoursSchema = z.union([
  z.object({ summary: z.string().trim().min(1).max(300) }).strict(),
  z
    .record(z.enum(DAYS), z.union([z.object({ open: hhmm, close: hhmm }).strict(), z.literal("closed")]))
    .refine((r) => Object.keys(r).length > 0, "Add at least one day"),
]);

const FACT_KEYS = [
  "website",
  "hours",
  "serviceArea",
  "brandReviewUrl",
  "ownerPhone",
  "businessPhoneKind",
  "businessPhoneCarrier",
  "logoUrl",
] as const;

export const businessFactsSchema = z
  .object({
    website: urlField("Website").optional(),
    hours: hoursSchema.nullable().optional(),
    serviceArea: z.preprocess(blankToNull, z.string().max(500).nullable()).optional(),
    brandReviewUrl: urlField("Review link").optional(),
    ownerPhone: z
      .preprocess(
        blankToNull,
        z
          .string()
          .max(40)
          .transform((v, ctx) => {
            const e164 = toE164(v);
            if (!e164 || !/^\+\d{10,15}$/.test(e164)) {
              ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Owner phone must be a valid phone number" });
              return z.NEVER;
            }
            return e164;
          })
          .nullable(),
      )
      .optional(),
    businessPhoneKind: z.preprocess(blankToNull, z.enum(PHONE_KINDS).nullable()).optional(),
    businessPhoneCarrier: z.preprocess(
      (v) => (typeof blankToNull(v) === "string" ? String(blankToNull(v)).toLowerCase() : blankToNull(v)),
      z.enum(PHONE_CARRIERS as [string, ...string[]]).nullable(),
    ).optional(),
    logoUrl: urlField("Logo", { httpsOnly: true }).optional(),
  })
  .strict()
  .refine((v) => FACT_KEYS.some((k) => v[k] !== undefined), "Change at least one fact");

const FACT_COLUMNS: Record<(typeof FACT_KEYS)[number], keyof Tables<"companies">> = {
  website: "website",
  hours: "hours",
  serviceArea: "service_area",
  brandReviewUrl: "brand_review_url",
  ownerPhone: "owner_phone_e164",
  businessPhoneKind: "business_phone_kind",
  businessPhoneCarrier: "business_phone_carrier",
  logoUrl: "brand_logo_url",
};

const cents = z.number().int().nonnegative().max(100_000_000);

export const servicePriceSchema = z
  .object({
    serviceId: z.string().uuid(),
    /** null clears the price (the service switches off — nothing is ever quoted at $0). */
    rateCents: cents.nullable().optional(),
    minimumCents: cents.nullable().optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((v) => v.rateCents !== undefined || v.minimumCents !== undefined || v.active !== undefined, "Nothing to change");

export const addServiceSchema = z
  .object({
    label: z.string().trim().min(1).max(200),
    description: z.preprocess(blankToNull, z.string().max(2000).nullable()).optional(),
    pricingType: z.enum(PRICING_TYPES).default("flat"),
    rateCents: cents.default(0),
    minimumCents: cents.default(0),
    unitLabel: z.preprocess(blankToNull, z.string().max(60).nullable()).optional(),
  })
  .strict();

export const provisionNumberSchema = z
  .object({ areaCode: z.number().int().min(200).max(999).optional() })
  .strict();

export const emptySchema = z.object({}).strict();

export const noteSchema = z.object({ note: z.string().trim().min(1).max(2000) }).strict();

/** NANP area code of the company's business line (or owner phone), for buying a local number. */
export function areaCodeFor(...phones: Array<string | null | undefined>): number | null {
  for (const phone of phones) {
    const e164 = toE164(phone);
    const m = e164 ? /^\+1([2-9]\d{2})\d{7}$/.exec(e164) : null;
    if (m) return Number(m[1]);
  }
  return null;
}

// ── Built-in actions ─────────────────────────────────────────────────────────

type CatalogRow = Tables<"service_catalog_items">;

registerConciergeAction({
  name: "update_business_facts",
  label: "Save business facts",
  schema: businessFactsSchema,
  async run(ctx, input) {
    const patch: Updates<"companies"> = {};
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const key of FACT_KEYS) {
      const value = input[key];
      if (value === undefined) continue;
      const column = FACT_COLUMNS[key];
      const current = ctx.company[column] ?? null;
      if (JSON.stringify(current) === JSON.stringify(value)) continue;
      (patch as Record<string, unknown>)[column] = value;
      before[key] = current;
      after[key] = value;
    }
    if (Object.keys(patch).length === 0) return { message: "Nothing changed.", audit: { changed: [] } };
    patch.updated_at = new Date(ctx.nowMs).toISOString();
    const { error } = await ctx.admin
      .from("companies")
      .update(patch)
      .eq("organization_id", ctx.organizationId)
      .eq("id", ctx.companyId);
    if (error) throw error;
    return { message: `Saved ${Object.keys(after).length} fact${Object.keys(after).length === 1 ? "" : "s"}.`, audit: { before, after } };
  },
});

registerConciergeAction({
  name: "set_service_price",
  label: "Set price",
  schema: servicePriceSchema,
  async run(ctx, input) {
    const { data, error } = await ctx.admin
      .from("service_catalog_items")
      .select("*")
      .eq("organization_id", ctx.organizationId)
      .eq("company_id", ctx.companyId)
      .eq("id", input.serviceId)
      .maybeSingle();
    if (error) throw error;
    const item = data as CatalogRow | null;
    if (!item) throw new ValidationError("That service isn't on this account.");
    const before = { rateCents: item.rate_cents, minimumCents: item.minimum_cents, active: item.active };

    const next = { rate_cents: item.rate_cents, minimum_cents: item.minimum_cents, active: item.active };
    if (input.rateCents !== undefined) next.rate_cents = input.rateCents ?? 0;
    if (input.minimumCents !== undefined) next.minimum_cents = input.minimumCents ?? 0;
    const unpriced = needsPrice({ ...item, rate_cents: next.rate_cents, minimum_cents: next.minimum_cents });
    if (input.active !== undefined) {
      if (input.active && unpriced) throw new ValidationError("Set a price before switching this service on.");
      next.active = input.active;
    } else if (input.rateCents !== undefined || input.minimumCents !== undefined) {
      // Same rule as the owner's price screen: priced → on, cleared → off.
      next.active = !unpriced;
    }

    const { error: updateError } = await ctx.admin
      .from("service_catalog_items")
      .update({ ...next, updated_at: new Date(ctx.nowMs).toISOString() })
      .eq("organization_id", ctx.organizationId)
      .eq("company_id", ctx.companyId)
      .eq("id", item.id);
    if (updateError) throw updateError;
    return {
      message: `${item.label} updated.`,
      audit: {
        serviceId: item.id,
        label: item.label,
        before,
        after: { rateCents: next.rate_cents, minimumCents: next.minimum_cents, active: next.active },
      },
    };
  },
});

registerConciergeAction({
  name: "add_service",
  label: "Add service",
  schema: addServiceSchema,
  async run(ctx, input) {
    const { data, error } = await ctx.admin
      .from("service_catalog_items")
      .select("service_key, sort_order")
      .eq("organization_id", ctx.organizationId)
      .eq("company_id", ctx.companyId);
    if (error) throw error;
    const existing = (data ?? []) as Array<Pick<CatalogRow, "service_key" | "sort_order">>;
    const keys = new Set(existing.map((r) => r.service_key));
    const base = (slugify(input.label) || "service").slice(0, 74);
    let key = base;
    for (let n = 2; keys.has(key); n++) key = `${base}-${n}`;
    const sortOrder = existing.reduce((max, r) => Math.max(max, r.sort_order ?? 0), 0) + 1;
    const priced = input.rateCents > 0 || input.minimumCents > 0;

    const { data: inserted, error: insertError } = await ctx.admin
      .from("service_catalog_items")
      .insert({
        organization_id: ctx.organizationId,
        company_id: ctx.companyId,
        label: input.label,
        description: input.description ?? null,
        pricing_type: input.pricingType,
        service_key: key,
        rate_cents: input.rateCents,
        minimum_cents: input.minimumCents,
        unit_label: input.unitLabel ?? null,
        sort_order: sortOrder,
        active: priced,
      })
      .select("id")
      .single();
    if (insertError) throw insertError;
    const id = (inserted as { id: string } | null)?.id ?? null;
    return {
      message: `${input.label} added${priced ? "" : " (no price yet, so it's off)"}.`,
      result: { id },
      audit: { serviceId: id, after: { label: input.label, rateCents: input.rateCents, minimumCents: input.minimumCents, active: priced } },
    };
  },
});

registerConciergeAction({
  name: "provision_text_back_number",
  label: "Buy text-back number directly (Twilio)",
  schema: provisionNumberSchema,
  async run(ctx, input) {
    const areaCode =
      input.areaCode ?? areaCodeFor(ctx.company.brand_reply_phone, ctx.company.owner_phone_e164, ctx.purchase?.owner_phone);
    const result = await provisionMissedCallCatcher(ctx.tenant, { companyId: ctx.companyId, areaCode });
    return {
      message: `${result.purchased ? "Number bought" : "Number re-connected"}: ${result.phoneNumberPretty}`,
      result: { phoneNumber: result.phoneNumber, purchased: result.purchased, forwardingCode: result.instructions.recommended.activate },
      audit: { areaCode, after: { phoneNumber: result.phoneNumber, purchased: result.purchased } },
    };
  },
});

registerConciergeAction({
  name: "run_forwarding_test",
  label: "Run forwarding test now",
  schema: emptySchema,
  async run(ctx) {
    const test = await startOwnerForwardingTest(ctx.tenant, ctx.companyId);
    return {
      message: "Test call placed — don't answer the business line. The result shows here in about a minute.",
      result: test,
      audit: { testId: test.id, testStatus: test.status },
    };
  },
});

registerConciergeAction({
  name: "resend_welcome_email",
  label: "Resend welcome / set-password email",
  schema: emptySchema,
  async run(ctx) {
    const sessionId = ctx.purchase?.stripe_checkout_session_id;
    if (!sessionId) throw new ValidationError("This account has no CrankLeads purchase to resend from.");
    const outcome = await resendWelcomeEmail(ctx.admin, sessionId);
    if (outcome === "use_forgot_password") {
      throw new ValidationError("They've already signed in (or it's been over a week) — have them use Forgot password.");
    }
    if (outcome !== "sent") throw new ValidationError("The purchase isn't fully set up yet, so there's nothing to resend.");
    return { message: `Welcome email sent to ${ctx.purchase?.owner_email ?? "the owner"}.`, audit: { outcome, to: ctx.purchase?.owner_email ?? null } };
  },
});

registerConciergeAction({
  name: "add_note",
  label: "Add note",
  schema: noteSchema,
  async run(_ctx, input) {
    return { message: "Note added.", audit: { note: input.note } };
  },
});
