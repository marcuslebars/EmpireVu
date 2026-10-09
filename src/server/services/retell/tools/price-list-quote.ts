// ─────────────────────────────────────────────────────────────────────────────
// SANCTIONED EXCEPTION #4 (Retell, continued): the generic price-list quote tool runs with
// the service-role client because Retell has no user session. The tenant is resolved from
// the CALL (signed AI-answer metadata, else dialled number → agent id; NEVER the legacy env
// guess) and the tool's arguments can never name an organization or company. Prices come
// ONLY from that company's catalog — the tool never invents one.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * `quote_services` — the Front Desk receptionist's quote tool for NON-marine trades
 * (docs/front-desk-ai.md → "## Phone answering" → Front Desk tools). The marine
 * `quote_shrink_wrap` (run-phone-quote.ts) is unchanged and still used for marine companies.
 *
 *   services by name (+ quantity / measurement) → matched to the company's catalog
 *     exact name/key ............ quoted
 *     one clear fuzzy match ..... quoted
 *     several close / a weak one  ask the caller which they mean (nothing created)
 *     not on the price list ..... no price — the team follows up (lead filed)
 *     needs a measurement/count . ask for it (nothing created)
 *   → priceQuoteForCompany (dry run: refuses combos the owner prices by hand)
 *   → file the phone lead → createQuote + sendQuote → text the caller the quote link.
 */
import type { CatalogItem, ServiceCatalog } from "@/server/services/quotes/catalog";
import { loadCatalog } from "@/server/services/quotes/catalog-repo";
import { getQuotesConfig } from "@/server/services/quotes/config";
import { priceQuoteForCompany, type QuoteServiceInput } from "@/server/services/quotes/pricing";
import { quoteLinkForCompanyId } from "@/server/services/quotes/public-url";
import { createQuote, sendQuote, type QuoteRow } from "@/server/services/quotes/service";
import type { TenantServiceContext } from "@/server/services/shared";
import { deliverMessage, type ConsentContact } from "@/server/services/workflow-engine/messaging";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { isVerifiedAnswerTenant, readAnswerMetadata } from "@/server/services/voice/ai-answer";
import { getRetellConfig } from "../config";
import type { RetellFunctionRequest } from "../functions";
import { captureRetellLead } from "../lead-adapter";
import { toE164 } from "../payload";
import { createRetellAdminClient, pinnedRetellTenant, resolveRetellTenant, type RetellTenant } from "../tenant";
import { spokenDollars } from "./phone-quote";

export interface PriceListServiceArg {
  name?: unknown;
  quantity?: unknown;
  /** Feet, square feet, km, hours… whatever the item's unit is. */
  measure?: unknown;
}

export interface PriceListQuoteArgs {
  services?: unknown;
  caller_name?: unknown;
  phone?: unknown;
  email?: unknown;
  address?: unknown;
  notes?: unknown;
}

// ── Matching (pure) ──────────────────────────────────────────────────────────────

const STOPWORDS = new Set(["a", "an", "the", "of", "for", "and", "my", "our", "to", "please", "some", "job", "service", "services", "i", "need", "want", "get"]);

function stem(token: string): string {
  if (token.length > 5 && token.endsWith("ing")) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && /(ches|shes|xes|sses)$/.test(token)) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

export function normalizeServiceName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[_/]+/g, " ")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/-/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map(stem)
    .join(" ");
}

function tokens(value: string): Set<string> {
  return new Set(normalizeServiceName(value).split(" ").filter((t) => t && !STOPWORDS.has(t)));
}

/** 0..1 similarity of a spoken name to a catalog item (label, key, description words). */
export function serviceScore(requested: string, item: Pick<CatalogItem, "label" | "serviceKey">): number {
  const req = normalizeServiceName(requested);
  if (!req) return 0;
  if (req === normalizeServiceName(item.label) || req === normalizeServiceName(item.serviceKey)) return 1;
  const a = tokens(requested);
  const b = new Set([...tokens(item.label), ...tokens(item.serviceKey)]);
  const labelTokens = tokens(item.label);
  if (a.size === 0 || labelTokens.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared += 1;
  if (shared === 0) return 0;
  // Every word of the label was said (or everything said is in the label) → strong.
  const allLabelSaid = [...labelTokens].every((t) => a.has(t));
  const allSaidInItem = [...a].every((t) => b.has(t));
  const dice = (2 * shared) / (a.size + labelTokens.size);
  if (allLabelSaid) return Math.max(0.9, dice);
  if (allSaidInItem) return Math.max(0.8, dice);
  return dice;
}

export const MATCH_THRESHOLD = 0.75;
export const CANDIDATE_THRESHOLD = 0.4;
const MARGIN = 0.15;

export type ServiceMatch =
  | { status: "matched"; requested: string; item: CatalogItem; quantity?: number; measure?: number }
  | { status: "ambiguous"; requested: string; options: string[] }
  | { status: "no_match"; requested: string }
  | { status: "needs_detail"; requested: string; item: CatalogItem; detail: "quantity" | "measure"; unitLabel: string | null }
  | { status: "owner_prices"; requested: string; item: CatalogItem };

function positiveNumber(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Match one spoken service to the catalog. Only catalog items can ever be returned. Pure. */
export function matchService(catalog: ServiceCatalog, arg: PriceListServiceArg): ServiceMatch {
  const requested = typeof arg.name === "string" ? arg.name.trim() : "";
  if (!requested) return { status: "no_match", requested: "" };
  const scored = Object.values(catalog.items)
    .map((item) => ({ item, score: serviceScore(requested, item) }))
    .filter((s) => s.score >= CANDIDATE_THRESHOLD)
    .sort((x, y) => y.score - x.score);
  if (scored.length === 0) return { status: "no_match", requested };
  const [best, second] = scored;
  const close = scored.filter((s) => s.score >= best.score - MARGIN);
  const tie = second !== undefined && second.score >= best.score - MARGIN && !(best.score === 1 && second.score < 1);
  if (best.score < MATCH_THRESHOLD || tie) {
    return { status: "ambiguous", requested, options: close.slice(0, 3).map((s) => s.item.label) };
  }
  const item = best.item;
  if ((item.modifierGroups ?? []).some((g) => g.required)) return { status: "owner_prices", requested, item };
  const quantity = positiveNumber(arg.quantity);
  const measure = positiveNumber(arg.measure);
  switch (item.pricingType) {
    case "flat":
      return { status: "matched", requested, item };
    case "per_unit":
    case "per_unit_declining":
      if (quantity === undefined) return { status: "needs_detail", requested, item, detail: "quantity", unitLabel: item.unitLabel ?? null };
      return { status: "matched", requested, item, quantity: Math.round(quantity) };
    default:
      if (measure === undefined) return { status: "needs_detail", requested, item, detail: "measure", unitLabel: item.unitLabel ?? null };
      return { status: "matched", requested, item, measure };
  }
}

export type PriceListPlan =
  | { status: "ready"; services: QuoteServiceInput[]; labels: string[] }
  | { status: "clarify"; questions: string[] }
  | { status: "not_on_price_list"; missing: string[]; matchedLabels: string[] }
  | { status: "owner_prices"; labels: string[] }
  | { status: "no_services" };

function readServiceArgs(raw: unknown): PriceListServiceArg[] {
  if (Array.isArray(raw)) return raw.filter((s): s is PriceListServiceArg => Boolean(s) && typeof s === "object");
  if (typeof raw === "string" && raw.trim()) return raw.split(/,|\band\b/).map((name) => ({ name: name.trim() })).filter((s) => s.name);
  return [];
}

/** All the caller's services → one plan. Nothing is quoted unless EVERY line is certain. Pure. */
export function planPriceListQuote(catalog: ServiceCatalog, rawServices: unknown): PriceListPlan {
  const args = readServiceArgs(rawServices).slice(0, 10);
  if (args.length === 0) return { status: "no_services" };
  const matches = args.map((arg) => matchService(catalog, arg));
  const questions: string[] = [];
  for (const m of matches) {
    if (m.status === "ambiguous") {
      questions.push(
        m.options.length > 1
          ? `For "${m.requested}", did you mean ${m.options.slice(0, -1).join(", ")} or ${m.options[m.options.length - 1]}?`
          : `For "${m.requested}", did you mean ${m.options[0]}?`,
      );
    } else if (m.status === "needs_detail") {
      const unit = m.unitLabel ? `${m.unitLabel.replace(/s$/i, "")}s` : null;
      questions.push(
        m.detail === "quantity"
          ? unit
            ? `How many ${unit} for ${m.item.label}?`
            : `What quantity for ${m.item.label}?`
          : unit
            ? `How many ${unit} is it, for ${m.item.label}?`
            : `What's the size for ${m.item.label}?`,
      );
    }
  }
  if (questions.length > 0) return { status: "clarify", questions };
  const missing = matches.filter((m) => m.status === "no_match").map((m) => m.requested || "that");
  const ready = matches.filter((m): m is Extract<ServiceMatch, { status: "matched" }> => m.status === "matched");
  if (missing.length > 0) return { status: "not_on_price_list", missing, matchedLabels: ready.map((m) => m.item.label) };
  const ownerPrices = matches.filter((m): m is Extract<ServiceMatch, { status: "owner_prices" }> => m.status === "owner_prices");
  if (ownerPrices.length > 0) return { status: "owner_prices", labels: ownerPrices.map((m) => m.item.label) };
  // Same service twice → keep the first (a duplicate line would double the price).
  const seen = new Set<string>();
  const services: QuoteServiceInput[] = [];
  const labels: string[] = [];
  for (const m of ready) {
    if (seen.has(m.item.serviceKey)) continue;
    seen.add(m.item.serviceKey);
    services.push({
      serviceId: m.item.serviceKey,
      ...(m.quantity !== undefined ? { quantity: m.quantity } : {}),
      ...(m.measure !== undefined ? { distanceKm: m.measure } : {}),
    });
    labels.push(m.item.label);
  }
  return { status: "ready", services, labels };
}

// ── The tool ─────────────────────────────────────────────────────────────────────

export type PriceListQuoteResponse =
  | { ok: true; quote_id: string; quote_number: string | null; total_dollars: number; texted: boolean; say: string }
  | {
      ok: false;
      reason: "missing_info" | "clarify" | "not_on_price_list" | "manual_review" | "unsupported" | "error";
      questions?: string[];
      say: string;
    };

export interface PriceListQuoteDeps {
  resolveTenant(req: RetellFunctionRequest<PriceListQuoteArgs>): Promise<RetellTenant | null>;
  loadCatalog(companyId: string): Promise<ServiceCatalog | null>;
  /** Dry-run pricing — throws when the catalog refuses the combination (owner prices it). */
  price(companyId: string, services: QuoteServiceInput[]): Promise<{ subtotalCents: number }>;
  captureLead(payload: unknown, callId: string | null): Promise<{ leadId: string | null; contactId: string | null }>;
  createAndSendQuote(
    tenant: { organizationId: string; companyId: string },
    input: { contactId: string | null; leadId: string | null; services: QuoteServiceInput[]; title: string; notes: string },
  ): Promise<QuoteRow>;
  textQuoteLink(
    tenant: { organizationId: string; companyId: string },
    input: { quote: QuoteRow; phone: string; contactId: string | null; companyName: string | null },
  ): Promise<boolean>;
}

const s = (v: unknown, max = 200): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

const SAY_UNSUPPORTED = "I can't price that on the phone, but I've got your details and someone will follow up with a number.";
const SAY_ERROR = "I hit a snag pricing that. Someone from the team will text you the number shortly.";

export async function runPriceListQuote(
  req: RetellFunctionRequest<PriceListQuoteArgs>,
  deps: PriceListQuoteDeps = defaultPriceListQuoteDeps,
): Promise<PriceListQuoteResponse> {
  const { args, call } = req;
  const tenant = await deps.resolveTenant(req);
  if (!tenant?.organizationId || !tenant.companyId || tenant.resolvedBy === "legacy") {
    return { ok: false, reason: "unsupported", say: SAY_UNSUPPORTED };
  }
  const catalog = await deps.loadCatalog(tenant.companyId);
  if (!catalog || Object.keys(catalog.items).length === 0) return { ok: false, reason: "unsupported", say: SAY_UNSUPPORTED };

  const plan = planPriceListQuote(catalog, args.services);
  if (plan.status === "no_services") {
    return { ok: false, reason: "missing_info", say: "What would you like a price on?" };
  }
  if (plan.status === "clarify") {
    return { ok: false, reason: "clarify", questions: plan.questions, say: plan.questions.join(" ") };
  }
  const name = s(args.caller_name, 80);
  // The number the caller SAYS is kept on the lead (the team can call it back), but the quote is
  // only ever texted to the number actually calling (caller ID): a caller can't make the
  // business text arbitrary numbers.
  const callerId = toE164(call.fromNumber);
  const phone = toE164(s(args.phone, 30)) ?? callerId;
  if (!name || !phone) {
    const missing = [!name ? "their name" : null, !phone ? "a mobile number to text the quote to" : null].filter(Boolean).join(" and ");
    return { ok: false, reason: "missing_info", say: `Before I price it, I just need ${missing}.` };
  }

  const leadPayload = {
    call: readCall(req.raw) ?? { call_id: call.callId, from_number: call.fromNumber, to_number: call.toNumber, agent_id: call.agentId },
    args: {
      caller_name: name,
      ...(s(args.email) ? { caller_email: s(args.email) } : {}),
      phone,
      services_requested: plan.status === "ready" ? plan.labels : plan.status === "owner_prices" ? plan.labels : [...plan.matchedLabels, ...plan.missing],
      ...(s(args.address) ? { service_address: s(args.address) } : {}),
      summary: s(args.notes, 500) ?? undefined,
    },
  };
  let lead: { leadId: string | null; contactId: string | null } = { leadId: null, contactId: null };
  try {
    lead = await deps.captureLead(leadPayload, call.callId);
  } catch (err) {
    console.error("[retell:price-quote] lead capture failed:", err instanceof Error ? err.message : err);
  }

  if (plan.status === "not_on_price_list") {
    return {
      ok: false,
      reason: "not_on_price_list",
      say: `I don't have a price for ${plan.missing.join(" or ")} on our list, so I won't guess — someone from the team will follow up with a number.`,
    };
  }
  if (plan.status === "owner_prices") {
    return { ok: false, reason: "manual_review", say: `${plan.labels.join(" and ")} gets priced by the team — someone will follow up with a number.` };
  }

  try {
    await deps.price(tenant.companyId, plan.services);
  } catch (err) {
    console.log(`[retell:price-quote] catalog refused for ${tenant.companyId}: ${err instanceof Error ? err.message : err}`);
    return { ok: false, reason: "manual_review", say: "That one needs the team to price it — someone will follow up with a number." };
  }

  try {
    const quote = await deps.createAndSendQuote(
      { organizationId: tenant.organizationId, companyId: tenant.companyId },
      {
        contactId: lead.contactId,
        leadId: lead.leadId,
        services: plan.services,
        title: plan.labels.join(", "),
        notes: ["Quoted by the AI receptionist on the phone.", s(args.address) ? `Address: ${s(args.address)}` : null, s(args.notes, 500), call.callId ? `Retell call ${call.callId}.` : null]
          .filter(Boolean)
          .join("\n"),
      },
    );
    let texted = false;
    try {
      if (callerId) {
        // Consent/opt-out is checked against the contact only when it IS the caller's number.
        const contactId = phone === callerId ? lead.contactId ?? quote.contact_id ?? null : null;
        texted = await deps.textQuoteLink(
          { organizationId: tenant.organizationId, companyId: tenant.companyId },
          { quote, phone: callerId, contactId, companyName: null },
        );
      }
    } catch (err) {
      console.error("[retell:price-quote] quote text failed:", err instanceof Error ? err.message : err);
    }
    const total = spokenDollars(quote.subtotal_cents);
    return {
      ok: true,
      quote_id: quote.id,
      quote_number: quote.quote_number,
      total_dollars: Math.round(quote.subtotal_cents) / 100,
      texted,
      say: `That comes to ${total} plus HST for ${plan.labels.join(" and ")}. ${
        texted ? "I've just texted the quote to the number you're calling from — you can approve it right from the link." : "The team will send you the quote link shortly."
      }`,
    };
  } catch (err) {
    console.error("[retell:price-quote] quote failed:", err instanceof Error ? err.message : err);
    return { ok: false, reason: "error", say: SAY_ERROR };
  }
}

function readCall(raw: unknown): unknown {
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>).call : undefined;
}

// ── Production wiring ───────────────────────────────────────────────────────────

export const defaultPriceListQuoteDeps: PriceListQuoteDeps = {
  async resolveTenant(req) {
    const admin = createRetellAdminClient();
    const call = readCall(req.raw);
    const metadata = call && typeof call === "object" ? (call as Record<string, unknown>).metadata : undefined;
    const answered = readAnswerMetadata(metadata);
    if (answered) return isVerifiedAnswerTenant(answered) ? pinnedRetellTenant(admin, answered.organizationId, answered.companyId) : null;
    return resolveRetellTenant(admin, { toNumber: req.call.toNumber, agentId: req.call.agentId, legacySourceSite: getRetellConfig().sourceSite });
  },

  async loadCatalog(companyId) {
    return loadCatalog(companyId).catch((): null => null);
  },

  async price(companyId, services) {
    return priceQuoteForCompany(companyId, { services });
  },

  async captureLead(payload, callId) {
    const result = await captureRetellLead(payload);
    const { data } = await createRetellAdminClient()
      .from("retell_calls")
      .select("contact_id")
      .eq("call_id", callId ?? result.callId)
      .maybeSingle();
    return { leadId: result.leadId, contactId: (data as { contact_id: string | null } | null)?.contact_id ?? null };
  },

  async createAndSendQuote(tenant, input) {
    const ctx: TenantServiceContext = { organizationId: tenant.organizationId, actorProfileId: null, supabase: createSupabaseAdminClient() };
    const draft = await createQuote(ctx, {
      contactId: input.contactId,
      companyId: tenant.companyId,
      services: input.services,
      title: input.title,
      source: "phone",
      sourceLeadId: input.leadId,
      notes: input.notes,
    });
    if (!getQuotesConfig().enabled) return draft;
    const { quote } = await sendQuote(ctx, draft.id);
    return quote;
  },

  async textQuoteLink(tenant, input) {
    const admin = createSupabaseAdminClient();
    const [{ data: company }, { data: contact }] = await Promise.all([
      admin.from("companies").select("name").eq("organization_id", tenant.organizationId).eq("id", tenant.companyId).maybeSingle(),
      input.contactId
        ? admin
            .from("contacts")
            .select("id, first_name, sms_opt_out_at, email_opt_out_at, sms_consent_at, consent_source")
            .eq("organization_id", tenant.organizationId)
            .eq("id", input.contactId)
            .maybeSingle()
        : Promise.resolve({ data: null }),
    ]);
    const url = await quoteLinkForCompanyId(tenant.companyId, input.quote.public_token, admin);
    const companyName = (company as { name: string } | null)?.name ?? "us";
    const first = (contact as { first_name: string | null } | null)?.first_name?.trim() || "there";
    const body = `Hi ${first}, it's ${companyName} — here's your quote: ${spokenDollars(input.quote.subtotal_cents)} + HST. Tap to see it and approve: ${url}`;
    const result = await deliverMessage({
      context: { organizationId: tenant.organizationId, actorProfileId: null, supabase: admin },
      channel: "sms",
      to: input.phone,
      body,
      companyId: tenant.companyId,
      contactId: input.contactId,
      consentContact: (contact as ConsentContact | null) ?? null,
    });
    return result.status === "sent";
  },
};
