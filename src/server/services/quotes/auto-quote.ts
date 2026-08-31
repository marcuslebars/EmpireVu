/**
 * Phase 5 — turn an eligible lead into a sent, payable quote.
 *
 * An additive step AFTER intake, deliberately mirroring how the Jobber enqueue
 * worked: the lead is already durably written and notified before this runs, and
 * nothing here can fail an intake. A lead that cannot be auto-quoted is not a
 * failed lead — it is a normal lead, handled the way every lead is today.
 *
 * The quote it creates is a real one: same table, same lifecycle, same hosted
 * page, same Stripe checkout. It is flagged `auto_generated` so it can be found
 * and voided before anyone approves it.
 */
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import type { TenantServiceContext } from "@/server/services/shared";
import type { LeadEnvelope } from "@/server/services/lead-intake/envelope";
import { decideAutoQuote, type AutoQuoteDecision } from "./auto-quote-eligibility";
import { loadCatalog } from "./catalog-repo";
import { getQuotesConfig } from "./config";
import { createQuote, sendQuote, type QuoteRow } from "./service";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

export interface AutoQuoteContext {
  organizationId: string;
  companyId: string | null;
  contactId: string | null;
  leadId: string;
}

export interface AutoQuoteOutcome {
  created: boolean;
  decision: AutoQuoteDecision;
  quote?: QuoteRow;
  /** The customer-facing link, when one was created. */
  quoteUrl?: string;
}

/** Self-serve is its own switch, on top of the quotes flag. */
export function selfServeEnabled(): boolean {
  return getQuotesConfig().enabled && process.env.SELF_SERVE_QUOTES_ENABLED === "1";
}

/** Has this lead already produced an auto-quote? The DB index is the real guard. */
async function alreadyQuoted(organizationId: string, leadId: string): Promise<boolean> {
  const db = createSupabaseAdminClient() as Db;
  const { data } = await db
    .from("quotes")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("source_lead_id", leadId)
    .eq("auto_generated", true)
    .maybeSingle();
  return Boolean(data);
}

/**
 * Free text the guardrails scan. Pulled from everywhere a customer can type,
 * because a Care request or a haul-out mention can land in any of them.
 */
function freeTextOf(envelope: LeadEnvelope): string {
  return [envelope.message, envelope.asset?.location, envelope.asset?.makeModel]
    .filter(Boolean)
    .join(" \n ");
}

/** Selection -> the shape createQuote wants. Keys pass straight through. */
function servicesFrom(envelope: LeadEnvelope) {
  const sel = envelope.meta?.selection;
  return (sel?.services ?? []).map((s) => ({
    serviceId: s.serviceKey,
    lengthFt: s.measure,
    quantity: s.quantity,
  }));
}

/**
 * Create and send an auto-quote for a lead, if it qualifies.
 *
 * NEVER THROWS. Intake has already succeeded by the time this runs, and a
 * failure here must not turn a captured lead into an error response. Everything
 * is reported through the return value and the logs.
 */
export async function maybeAutoQuoteLead(
  envelope: LeadEnvelope,
  ctx: AutoQuoteContext,
): Promise<AutoQuoteOutcome> {
  try {
    const enabled = selfServeEnabled();

    // Load the catalog only when there is a company and the feature is on —
    // otherwise this is a needless query on every single lead.
    let catalog = null;
    if (enabled && ctx.companyId) {
      catalog = await loadCatalog(ctx.companyId).catch(() => null);
    }

    const decision = decideAutoQuote({
      enabled,
      formType: envelope.formType ?? null,
      companyId: ctx.companyId,
      catalog,
      boatLengthFt: envelope.asset?.lengthFt ?? null,
      engineType: envelope.asset?.engineType ?? null,
      requestedServiceKeys: (envelope.meta?.selection?.services ?? []).map((s) => s.serviceKey),
      freeText: freeTextOf(envelope),
      transportBand: envelope.meta?.logistics?.transportBand ?? null,
      alreadyQuoted:
        enabled && ctx.companyId ? await alreadyQuoted(ctx.organizationId, ctx.leadId) : false,
    });

    if (!decision.eligible) {
      // Recorded at info, not error: declining is the designed outcome for most
      // leads, and logging it as a failure would bury the ones that matter.
      console.log(
        `[auto-quote] lead ${ctx.leadId} not auto-quoted (${decision.reason}): ${decision.detail ?? ""}`,
      );
      return { created: false, decision };
    }

    // Service-role, because there is no signed-in user on an intake request —
    // RLS would refuse the insert. organizationId is passed explicitly, so the
    // quote is still scoped to the tenant that owns the lead.
    //
    // The cast is a package-typing artifact, not a real mismatch: the admin
    // client comes from @supabase/supabase-js and the request-scoped one from
    // the SSR helper, and their generics have different arity. Both are ordinary
    // Supabase clients at runtime, and every other admin call in this module
    // takes the same escape hatch.
    const serviceCtx: TenantServiceContext = {
      organizationId: ctx.organizationId,
      actorProfileId: null, // system-created
      supabase: createSupabaseAdminClient() as unknown as TenantServiceContext["supabase"],
    };

    const log = envelope.meta?.logistics;
    const draft = await createQuote(serviceCtx, {
      contactId: ctx.contactId,
      companyId: ctx.companyId,
      services: servicesFrom(envelope),
      bundleId: envelope.meta?.selection?.bundleKey,
      hullType: envelope.meta?.selection?.variant,
      title: "Winter storage quote",
      source: "self_serve",
      autoGenerated: true,
      sourceLeadId: ctx.leadId,
      notes: log
        ? `Auto-quoted from a web lead. Transport band: ${log.transportBand ?? "none"}.`
        : "Auto-quoted from a web lead.",
    });

    // sendQuote allocates the customer-facing number, stamps valid_until, and
    // sends the branded quote email carrying the /q/{token} link. That email IS
    // the instant confirmation — there is no second one to write.
    const sent = await sendQuote(serviceCtx, draft.id);

    console.log(`[auto-quote] lead ${ctx.leadId} -> quote ${sent.quote_number} (${sent.id})`);
    return {
      created: true,
      decision,
      quote: sent,
      quoteUrl: `${getQuotesConfig().publicBaseUrl}/q/${sent.public_token}`,
    };
  } catch (err) {
    // A lead that fails to auto-quote is still a captured lead. It reaches a
    // human exactly as it would have without this feature.
    console.error(
      `[auto-quote] lead ${ctx.leadId} failed; lead is unaffected:`,
      err instanceof Error ? err.message : err,
    );
    return {
      created: false,
      decision: { eligible: false, reason: "no_catalog", detail: "auto-quote errored; see logs" },
    };
  }
}
