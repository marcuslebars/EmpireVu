/**
 * CrankLeads setup checklist — "what does this buyer still have to do before the system
 * actually works?" One function, three callers: the setup follow-up job (reminders + live
 * detection), the dashboard "Setup: 3 of 5 done" card (GET /api/organizations/{orgId}/setup-checklist,
 * normal RLS auth), and the daily operator health email (services/operator-health/load.ts).
 *
 *   computeSetupChecklist(input)   — PURE: tier + facts → ordered required steps, done/not,
 *                                    deep link per step, isLive, nextStep.
 *   loadSetupFacts(ctx, companyId) — reads the facts for one company (every query filtered by
 *                                    organization_id + company_id; works on an RLS client or
 *                                    the worker's service-role client).
 *   loadSetupChecklist(ctx, opts)  — org → tier + company → facts → checklist; null when the
 *                                    org is not a CrankLeads org or has no company yet.
 *
 * Required steps per tier (in wizard order) — see docs/crankleads-purchase.md "Setup follow-ups":
 *
 *   catch              services · phone (catcher number) · forwarding · website · automations
 *   close              services · phone (catcher number) · forwarding · payments · website · automations
 *   front_desk (AI)    services · phone (AI number) · test_call · payments · website
 *   front_desk (catcher chosen instead of the AI)   services · phone · forwarding · payments · website · automations
 *
 * Team invites are never required. Payments are required for Close + Front Desk because their
 * starter packs include the quote / deposit automations (deposit links need Stripe Connect);
 * Catch's automations never take money.
 *
 * Forwarding is done ONLY when the company's active missed-call-catcher number has
 * voice_numbers.forwarding_verified_at set (stamped by feat/forwarding-verify when a forwarded
 * call actually arrives) — the wizard's "mark done / skip" never counts. Likewise every other
 * step is judged from real state, not from onboarding_progress (which "Skip for now" can set).
 */
import { buildForwardingInstructions, prettyPhone } from "@/lib/carrier-forwarding";
import type { Tables } from "@/server/db/database.types";
import { isCrankleadsTier, type CrankleadsTier } from "@/server/services/crankleads/config";
import type { OnboardingStep } from "@/server/services/onboarding";
import { needsPrice } from "@/server/services/packs/apply";
import type { TenantServiceContext } from "@/server/services/shared";

export const SETUP_STEP_KEYS = ["services", "phone", "forwarding", "test_call", "payments", "website", "automations"] as const;
export type SetupStepKey = (typeof SETUP_STEP_KEYS)[number];

/** How the company's calls are handled: forwarded-missed-calls catcher, or Marina answers. */
export type PhonePath = "missed_call_catcher" | "ai_receptionist";

/** The recipe that makes the catcher useful (installed by catcher provisioning / the packs). */
export const TEXT_BACK_RECIPE_SLUG = "missed-call-text-back";

/** Observed state of one company. Pure data — built by loadSetupFacts, or by hand in tests. */
export interface SetupFacts {
  /** Catalog items with any price set. */
  pricedServices: number;
  /** Catalog items still waiting for a price. */
  servicesNeedingPrices: number;
  /** Active Twilio missed-call-catcher number (E.164), if any. */
  catcherNumber: string | null;
  /** That catcher number's voice_numbers.forwarding_verified_at is set. */
  forwardingVerified: boolean;
  /** Active AI-receptionist number (E.164), if any. */
  aiNumber: string | null;
  /** At least one call answered by the AI receptionist (retell_calls) for the company. */
  receptionistCallReceived: boolean;
  /** companies.stripe_charges_enabled (Stripe Connect ready). */
  paymentsConnected: boolean;
  /** A lead has arrived through the website form (public form key or intake key used). */
  websiteLeadReceived: boolean;
  /** The missed-call text-back automation is installed AND active. */
  textBackActive: boolean;
}

export interface SetupChecklistStep {
  key: SetupStepKey;
  /** Short title for the card ("Turn on call forwarding"). */
  title: string;
  /** Lower-case action phrase for messages ("set call forwarding (dial **004*… from your business phone)"). */
  action: string;
  done: boolean;
  /** The onboarding wizard step that finishes it. */
  wizardStep: OnboardingStep;
  /** App-relative deep link: `/onboarding?step=<wizardStep>&org=<orgId>`. */
  path: string;
  /** Absolute deep link (appBaseUrl + path). */
  deepLink: string;
}

export interface SetupChecklist {
  organizationId: string;
  companyId: string;
  tier: CrankleadsTier;
  phonePath: PhonePath;
  steps: SetupChecklistStep[];
  doneCount: number;
  totalCount: number;
  /** Every required step is done. */
  isLive: boolean;
  /** The first required step not done (null when live). */
  nextStep: SetupChecklistStep | null;
}

const WIZARD_STEP: Record<SetupStepKey, OnboardingStep> = {
  services: "services",
  phone: "phone",
  forwarding: "phone",
  test_call: "test_call",
  payments: "payments",
  website: "website",
  automations: "recipes",
};

/**
 * Catch / Close only ever get the catcher (AI receptionist is Front Desk only). Front Desk is
 * on the AI path unless the owner chose the catcher instead (catcher number, no AI number).
 */
export function phonePathFor(tier: CrankleadsTier, facts: Pick<SetupFacts, "catcherNumber" | "aiNumber">): PhonePath {
  if (tier !== "front_desk") return "missed_call_catcher";
  if (!facts.aiNumber && facts.catcherNumber) return "missed_call_catcher";
  return "ai_receptionist";
}

/** The required steps for a tier + phone path, in wizard order. */
export function requiredSetupSteps(tier: CrankleadsTier, phonePath: PhonePath): SetupStepKey[] {
  const steps: SetupStepKey[] = ["services", "phone"];
  steps.push(phonePath === "missed_call_catcher" ? "forwarding" : "test_call");
  if (tier !== "catch") steps.push("payments");
  steps.push("website");
  if (phonePath === "missed_call_catcher") steps.push("automations");
  return steps;
}

function stepDone(key: SetupStepKey, facts: SetupFacts, phonePath: PhonePath): boolean {
  switch (key) {
    case "services":
      return facts.pricedServices > 0;
    case "phone":
      return phonePath === "missed_call_catcher" ? Boolean(facts.catcherNumber) : Boolean(facts.aiNumber);
    case "forwarding":
      return Boolean(facts.catcherNumber) && facts.forwardingVerified;
    case "test_call":
      return Boolean(facts.aiNumber) && facts.receptionistCallReceived;
    case "payments":
      return facts.paymentsConnected;
    case "website":
      return facts.websiteLeadReceived;
    case "automations":
      return facts.textBackActive;
  }
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function stepCopy(key: SetupStepKey, facts: SetupFacts, phonePath: PhonePath): { title: string; action: string } {
  switch (key) {
    case "services":
      return {
        title: "Add your prices",
        action:
          facts.servicesNeedingPrices > 0
            ? `add prices to your ${plural(facts.servicesNeedingPrices, "service")}`
            : "add your services and prices",
      };
    case "phone":
      return phonePath === "missed_call_catcher"
        ? { title: "Get your missed-call number", action: "pick your missed-call number" }
        : { title: "Get your AI receptionist number", action: "get your AI receptionist number" };
    case "forwarding": {
      const code = facts.catcherNumber ? buildForwardingInstructions(facts.catcherNumber).recommended.activate : null;
      return {
        title: "Turn on call forwarding",
        action: code
          ? `set call forwarding (dial ${code} from your business phone)`
          : "set call forwarding from your business phone",
      };
    }
    case "test_call":
      return {
        title: "Make a test call",
        action: facts.aiNumber
          ? `call your AI receptionist at ${prettyPhone(facts.aiNumber)} to test it`
          : "make a test call to your AI receptionist",
      };
    case "payments":
      return { title: "Connect payments", action: "connect Stripe so you can take deposits" };
    case "website":
      return { title: "Add your website form", action: "add your website form and send a test lead" };
    case "automations":
      return { title: "Turn on missed-call text-back", action: "turn on the missed-call text-back" };
  }
}

/** `/onboarding?step=<wizardStep>&org=<orgId>` — the wizard opens on that step for that org. */
export function setupStepPath(organizationId: string, wizardStep: OnboardingStep): string {
  const params = new URLSearchParams({ step: wizardStep, org: organizationId });
  return `/onboarding?${params.toString()}`;
}

export interface ComputeSetupChecklistInput {
  organizationId: string;
  companyId: string;
  tier: CrankleadsTier;
  facts: SetupFacts;
  /** Absolute app origin for deep links (APP_BASE_URL), no trailing slash needed. */
  appBaseUrl: string;
}

/** PURE. The ordered required steps for the tier, each done or not, with deep links. */
export function computeSetupChecklist(input: ComputeSetupChecklistInput): SetupChecklist {
  const base = input.appBaseUrl.replace(/\/+$/, "");
  const phonePath = phonePathFor(input.tier, input.facts);
  const steps = requiredSetupSteps(input.tier, phonePath).map((key): SetupChecklistStep => {
    const wizardStep = WIZARD_STEP[key];
    const path = setupStepPath(input.organizationId, wizardStep);
    return {
      key,
      ...stepCopy(key, input.facts, phonePath),
      done: stepDone(key, input.facts, phonePath),
      wizardStep,
      path,
      deepLink: `${base}${path}`,
    };
  });
  const doneCount = steps.filter((s) => s.done).length;
  const nextStep = steps.find((s) => !s.done) ?? null;
  return {
    organizationId: input.organizationId,
    companyId: input.companyId,
    tier: input.tier,
    phonePath,
    steps,
    doneCount,
    totalCount: steps.length,
    isLive: nextStep === null,
    nextStep,
  };
}

// ── Loader ────────────────────────────────────────────────────────────────────

function throwIf(error: unknown, what: string): void {
  if (error) {
    const message = error && typeof error === "object" && "message" in error ? String((error as { message: unknown }).message) : String(error);
    throw new Error(`setup checklist: ${what} lookup failed: ${message}`);
  }
}

type VoiceNumberFacts = Pick<Tables<"voice_numbers">, "phone_e164" | "mode" | "provider" | "forwarding_verified_at">;

/** Read the facts for one company. Every query is filtered by organization_id + company_id. */
export async function loadSetupFacts(ctx: TenantServiceContext, companyId: string): Promise<SetupFacts> {
  const org = ctx.organizationId;
  const db = ctx.supabase;

  const [catalog, numbers, calls, company, forms, intakeKeys, textBack] = await Promise.all([
    db
      .from("service_catalog_items")
      .select("rate_cents, minimum_cents, tiers, rate_bands")
      .eq("organization_id", org)
      .eq("company_id", companyId),
    db
      .from("voice_numbers")
      .select("phone_e164, mode, provider, forwarding_verified_at")
      .eq("organization_id", org)
      .eq("company_id", companyId)
      .eq("active", true),
    db.from("retell_calls").select("id").eq("organization_id", org).eq("company_id", companyId).limit(1),
    db.from("companies").select("stripe_charges_enabled").eq("organization_id", org).eq("id", companyId).maybeSingle(),
    db
      .from("public_form_keys")
      .select("id")
      .eq("organization_id", org)
      .eq("company_id", companyId)
      .not("last_used_at", "is", null)
      .limit(1),
    db
      .from("intake_keys")
      .select("id")
      .eq("organization_id", org)
      .eq("company_id", companyId)
      .not("last_used_at", "is", null)
      .limit(1),
    db
      .from("workflows")
      .select("id")
      .eq("organization_id", org)
      .eq("company_id", companyId)
      .eq("slug", TEXT_BACK_RECIPE_SLUG)
      .eq("status", "active")
      .limit(1),
  ]);
  throwIf(catalog.error, "catalog");
  throwIf(numbers.error, "voice numbers");
  throwIf(calls.error, "calls");
  throwIf(company.error, "company");
  throwIf(forms.error, "website forms");
  throwIf(textBack.error, "automations");
  // intake_keys is admin-readable only under RLS; a member's empty/denied read just means "not via an intake key".

  const items = (catalog.data ?? []) as Array<Pick<Tables<"service_catalog_items">, "rate_cents" | "minimum_cents" | "tiers" | "rate_bands">>;
  const unpriced = items.filter((item) => needsPrice(item)).length;
  const voiceRows = (numbers.data ?? []) as VoiceNumberFacts[];
  const catcher = voiceRows.find((row) => row.provider === "twilio" && row.mode === "missed_call_catcher") ?? null;
  const ai = voiceRows.find((row) => row.mode === "ai_receptionist") ?? null;

  return {
    pricedServices: items.length - unpriced,
    servicesNeedingPrices: unpriced,
    catcherNumber: catcher?.phone_e164 ?? null,
    forwardingVerified: Boolean(catcher?.forwarding_verified_at),
    aiNumber: ai?.phone_e164 ?? null,
    receptionistCallReceived: (calls.data ?? []).length > 0,
    paymentsConnected: Boolean((company.data as { stripe_charges_enabled: boolean } | null)?.stripe_charges_enabled),
    websiteLeadReceived: (forms.data ?? []).length > 0 || (!intakeKeys.error && (intakeKeys.data ?? []).length > 0),
    textBackActive: (textBack.data ?? []).length > 0,
  };
}

function defaultAppBaseUrl(): string {
  return (process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}

export interface LoadSetupChecklistOptions {
  /** The CrankLeads company (crankleads_purchases.company_id). Default: the org's first company. */
  companyId?: string | null;
  /** Skip the organizations lookup when the caller already knows the tier. */
  tier?: CrankleadsTier | null;
  appBaseUrl?: string;
}

/**
 * The checklist for `ctx.organizationId`, or null when the org is not a CrankLeads org
 * (organizations.crankleads_tier null) or has no company yet.
 */
export async function loadSetupChecklist(
  ctx: TenantServiceContext,
  options: LoadSetupChecklistOptions = {},
): Promise<SetupChecklist | null> {
  let tier: CrankleadsTier | null = options.tier ?? null;
  if (!tier) {
    const { data, error } = await ctx.supabase
      .from("organizations")
      .select("crankleads_tier")
      .eq("id", ctx.organizationId)
      .maybeSingle();
    throwIf(error, "organization");
    const raw = (data as { crankleads_tier: string | null } | null)?.crankleads_tier ?? null;
    tier = isCrankleadsTier(raw) ? raw : null;
  }
  if (!tier) return null;

  let companyId = options.companyId ?? null;
  if (!companyId) {
    // Same company the onboarding wizard uses (its progress route: the org's first company).
    const { data, error } = await ctx.supabase
      .from("companies")
      .select("id")
      .eq("organization_id", ctx.organizationId)
      .order("created_at", { ascending: false })
      .limit(1);
    throwIf(error, "company");
    companyId = ((data ?? []) as Array<{ id: string }>)[0]?.id ?? null;
  }
  if (!companyId) return null;

  const facts = await loadSetupFacts(ctx, companyId);
  return computeSetupChecklist({
    organizationId: ctx.organizationId,
    companyId,
    tier,
    facts,
    appBaseUrl: options.appBaseUrl ?? defaultAppBaseUrl(),
  });
}
