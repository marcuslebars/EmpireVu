// ─────────────────────────────────────────────────────────────────────────────
// SANCTIONED EXCEPTION #4 (Retell, continued): Marina's mid-call quote tool runs with
// the service-role client because Retell has no user session. The tenant is resolved
// from the CALL (dialled number → agent id → legacy env) in resolveRetellTenant; the
// tool's arguments can never name an organization or company. The quote is written with
// organizationId pinned from that resolution, exactly as auto-quote does for web leads.
// ─────────────────────────────────────────────────────────────────────────────
import { loadCatalog } from "@/server/services/quotes/catalog-repo";
import type { ServiceCatalog } from "@/server/services/quotes/catalog";
import { getQuotesConfig } from "@/server/services/quotes/config";
import { createQuote, sendQuote, type QuoteRow } from "@/server/services/quotes/service";
import type { TenantServiceContext } from "@/server/services/shared";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { getRetellConfig } from "../config";
import type { RetellFunctionRequest } from "../functions";
import { captureRetellLead } from "../lead-adapter";
import { createRetellAdminClient, resolveRetellTenant, type RetellTenant } from "../tenant";
import {
  manualReviewSummary,
  missingInfoSummary,
  phoneQuoteSummary,
  planPhoneQuote,
  toCaptureLeadPayload,
  type PhoneQuoteArgs,
  type PhoneQuotePlan,
} from "./phone-quote";

export type PhoneQuoteResponse =
  | {
      ok: true;
      quote_id: string;
      quote_number: string | null;
      total_dollars: number;
      deposit_dollars: number;
      line_items: { label: string; dollars: number }[];
      requires_manual_review: false;
      say: string;
    }
  | {
      ok: false;
      reason: "missing_info" | "manual_review" | "unsupported" | "error";
      missing?: string[];
      requires_manual_review?: boolean;
      say: string;
    };

export interface PhoneQuoteDeps {
  resolveTenant(req: RetellFunctionRequest<PhoneQuoteArgs>): Promise<RetellTenant>;
  loadCatalog(companyId: string): Promise<ServiceCatalog | null>;
  /** Files the phone lead (idempotent on call_id); returns the lead + its contact. */
  captureLead(payload: unknown, callId: string | null): Promise<{ leadId: string | null; contactId: string | null }>;
  createAndSendQuote(
    tenant: { organizationId: string; companyId: string },
    input: {
      contactId: string | null;
      leadId: string | null;
      plan: Extract<PhoneQuotePlan, { status: "ready" }>;
      notes: string;
    },
  ): Promise<QuoteRow>;
}

const SAY_ERROR = "I hit a snag pricing that. Someone from the team will text you the number within the hour.";
const SAY_UNSUPPORTED =
  "I can't price that one on the phone, but I've got your details and someone will call you back with a number.";

const dollars = (cents: number) => Math.round(cents) / 100;

export async function runPhoneQuote(
  req: RetellFunctionRequest<PhoneQuoteArgs>,
  deps: PhoneQuoteDeps = defaultPhoneQuoteDeps,
): Promise<PhoneQuoteResponse> {
  const { args, call } = req;

  const tenant = await deps.resolveTenant(req);
  // Price only for a company the CALL was mapped to. The legacy env fallback is a guess
  // (it routes every unmapped number to one brand) — good enough to file a lead under,
  // never good enough to quote that brand's prices to someone who called another.
  const priceable = Boolean(tenant.organizationId && tenant.companyId && tenant.resolvedBy !== "legacy");
  if (tenant.resolvedBy === "legacy") {
    console.warn(
      "[retell:quote] call resolved via legacy RETELL_SOURCE_SITE — not pricing. " +
        "Add a voice_numbers row for this number/agent (docs/marina-tools.md).",
    );
  }
  const catalog = priceable ? await deps.loadCatalog(tenant.companyId!) : null;

  const plan = planPhoneQuote(args, catalog, call.fromNumber);

  // Nothing is filed until Marina has a name and a number to file it under — she asks,
  // then calls again. (The post-call webhook still files every call regardless.)
  if (plan.status === "missing_info") {
    return { ok: false, reason: "missing_info", missing: plan.missing, say: missingInfoSummary(plan.missing) };
  }

  // Every other outcome is a real enquiry: file the lead first, so the owner sees it
  // even when the quote itself can't be produced.
  let lead: { leadId: string | null; contactId: string | null } = { leadId: null, contactId: null };
  try {
    lead = await deps.captureLead(toCaptureLeadPayload(args, call, readCall(req.raw), plan), call.callId);
  } catch (err) {
    console.error("[retell:quote] lead capture failed:", err instanceof Error ? err.message : err);
  }

  if (plan.status === "unsupported") {
    console.log(`[retell:quote] unsupported for company ${tenant.companyId ?? "none"}: ${plan.reason}`);
    return { ok: false, reason: "unsupported", say: SAY_UNSUPPORTED };
  }
  if (plan.status === "manual_review") {
    return {
      ok: false,
      reason: "manual_review",
      requires_manual_review: true,
      say: manualReviewSummary(plan.reasons),
    };
  }

  try {
    const quote = await deps.createAndSendQuote(
      { organizationId: tenant.organizationId!, companyId: tenant.companyId! },
      { contactId: lead.contactId, leadId: lead.leadId, plan, notes: quoteNotes(args, call.callId) },
    );
    const lineItems = asLines(quote.line_items);
    return {
      ok: true,
      quote_id: quote.id,
      quote_number: quote.quote_number,
      total_dollars: dollars(quote.subtotal_cents),
      deposit_dollars: dollars(quote.deposit_cents),
      line_items: lineItems.filter((l) => l.selected).map((l) => ({ label: l.label, dollars: dollars(l.amountCents) })),
      requires_manual_review: false,
      say: phoneQuoteSummary({
        plan,
        lineItems,
        subtotalCents: quote.subtotal_cents,
        depositCents: quote.deposit_cents,
        depositIsFlat: quote.deposit_flat_cents != null,
      }),
    };
  } catch (err) {
    console.error("[retell:quote] quote failed:", err instanceof Error ? err.message : err);
    return { ok: false, reason: "error", say: SAY_ERROR };
  }
}

function readCall(raw: unknown): unknown {
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>).call : undefined;
}

function asLines(value: unknown): { serviceId: string; label: string; amountCents: number; selected: boolean }[] {
  return Array.isArray(value)
    ? value.map((l) => ({
        serviceId: String(l?.serviceId ?? ""),
        label: String(l?.label ?? ""),
        amountCents: Number(l?.amountCents ?? 0),
        selected: l?.selected !== false,
      }))
    : [];
}

function quoteNotes(args: PhoneQuoteArgs, callId: string | null): string {
  const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return [
    "Quoted by Marina on the phone.",
    s(args.boat_location) ? `Boat is: ${s(args.boat_location)}` : null,
    s(args.town) ? `Area: ${s(args.town)}` : null,
    s(args.phone) ? `Best number to text: ${s(args.phone)}` : null,
    s(args.notes),
    callId ? `Retell call ${callId}.` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

// ── Production wiring ───────────────────────────────────────────────────────────

export const defaultPhoneQuoteDeps: PhoneQuoteDeps = {
  async resolveTenant(req) {
    return resolveRetellTenant(createRetellAdminClient(), {
      toNumber: req.call.toNumber,
      agentId: req.call.agentId,
      legacySourceSite: getRetellConfig().sourceSite,
    });
  },

  async loadCatalog(companyId) {
    return loadCatalog(companyId).catch((): null => null);
  },

  async captureLead(payload, callId) {
    const result = await captureRetellLead(payload);
    const admin = createRetellAdminClient();
    // The intake linked the call row to its contact; read it back rather than
    // re-deriving the contact (dedup may have matched an existing one).
    const { data } = await admin
      .from("retell_calls")
      .select("contact_id")
      .eq("call_id", callId ?? result.callId)
      .maybeSingle();
    return { leadId: result.leadId, contactId: (data as { contact_id: string | null } | null)?.contact_id ?? null };
  },

  async createAndSendQuote(tenant, input) {
    const ctx: TenantServiceContext = {
      organizationId: tenant.organizationId,
      actorProfileId: null, // system-created, like auto-quote
      supabase: createSupabaseAdminClient(),
    };
    const draft = await createQuote(ctx, {
      contactId: input.contactId,
      companyId: tenant.companyId,
      services: input.plan.services,
      hullType: input.plan.hullType,
      title: `${input.plan.primaryLabel} — ${input.plan.lengthFt} ft ${input.plan.hullType === "other" ? "boat" : input.plan.hullType}`,
      source: "phone",
      sourceLeadId: input.leadId,
      notes: input.notes,
    });
    if (!getQuotesConfig().enabled) return draft;
    // Numbered + live on the hosted page; emails the customer only if we have an address.
    const { quote } = await sendQuote(ctx, draft.id);
    return quote;
  },
};
