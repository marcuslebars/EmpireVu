/**
 * CrankLeads setup checklist — "is this buyer's system actually working yet?" One function,
 * several callers: the setup follow-up job (reminders + live detection), the done-for-you
 * orchestrator (24h escalation), the in-app "We're setting you up" view and dashboard card
 * (GET /api/organizations/{orgId}/setup-checklist, normal RLS auth), and the daily operator
 * health email (services/operator-health/load.ts).
 *
 *   computeSetupChecklist(input)   — PURE: tier + facts → ordered REQUIRED steps (live = all
 *                                    done), optional extras, deep links, isLive, nextStep.
 *   loadSetupFacts(ctx, companyId) — reads the facts for one company (every query filtered by
 *                                    organization_id + company_id; works on an RLS client or
 *                                    the worker's service-role client).
 *   loadSetupChecklist(ctx, opts)  — org → tier + company → facts → checklist; null when the
 *                                    org is not a CrankLeads org or has no company yet.
 *
 * "Live" (done-for-you, docs/done-for-you.md → "Automatic switch-on"):
 *
 *   catch / close              phone (text-back number active) · forwarding (verified) ·
 *                              automations (missed-call text-back active)
 *   front_desk (AI)            phone (AI number active) · forwarding (verified, OR a call to the
 *                              AI receptionist that shows forwarding from the business line —
 *                              dfy/front-desk-forwarding.ts; a call alone doesn't count)
 *   front_desk (catcher chosen instead of the AI) — as catch / close
 *
 * Prices, payments (Stripe), the website form and the team are NOT required: they are
 * optional `extras` (shown, never chased). Forwarding is done ONLY when a forwarded call
 * actually arrived (voice_numbers.forwarding_verified_at, stamped by a passing forwarding
 * test or a real forwarded call) — tapping the link never counts by itself. Every step is
 * judged from real state, not from onboarding_progress.
 */
import { prettyPhone } from "@/lib/carrier-forwarding";
import type { Tables } from "@/server/db/database.types";
import { isCrankleadsTier, type CrankleadsTier } from "@/server/services/crankleads/config";
import type { OnboardingStep } from "@/server/services/onboarding";
import { businessLineOf, hasFrontDeskForwardingEvidence } from "@/server/services/dfy/front-desk-forwarding";
import { needsPrice } from "@/server/services/packs/apply";
import type { TenantServiceContext } from "@/server/services/shared";
import { appBaseUrlFor } from "@/server/services/platform-brand";

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
  /** The AI number's voice_numbers.forwarding_verified_at is set. Optional (defaults false). */
  aiForwardingVerified?: boolean;
  /** At least one call answered by the AI receptionist (retell_calls) for the company. */
  receptionistCallReceived: boolean;
  /**
   * A call to the AI receptionist that shows the business line forwards to it (diversion from
   * the business line, or a call after the forwarding tap from someone other than the business
   * line — dfy/front-desk-forwarding.ts). Optional (defaults false). A call alone is NOT enough.
   */
  receptionistForwardedCall?: boolean;
  /** companies.stripe_charges_enabled (Stripe Connect ready). */
  paymentsConnected: boolean;
  /** A lead has arrived through the website form (public form key or intake key used). */
  websiteLeadReceived: boolean;
  /** The missed-call text-back automation is installed AND active. */
  textBackActive: boolean;
}

export interface SetupChecklistStep {
  key: SetupStepKey;
  /** Required for "live" (false = an optional extra). */
  required: boolean;
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
  /** The REQUIRED steps (live = all done). */
  steps: SetupChecklistStep[];
  /** Optional extras (prices, payments, website form) — never block "live". */
  extras: SetupChecklistStep[];
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

/** The REQUIRED steps for a tier + phone path ("live" = all done). */
export function requiredSetupSteps(_tier: CrankleadsTier, phonePath: PhonePath): SetupStepKey[] {
  return phonePath === "missed_call_catcher" ? ["phone", "forwarding", "automations"] : ["phone", "forwarding"];
}

/** Optional extras, shown but never required (payments only where deposits exist: Close / Front Desk). */
export function optionalSetupSteps(tier: CrankleadsTier, _phonePath: PhonePath): SetupStepKey[] {
  return tier === "catch" ? ["services", "website"] : ["services", "payments", "website"];
}

function stepDone(key: SetupStepKey, facts: SetupFacts, phonePath: PhonePath): boolean {
  switch (key) {
    case "services":
      return facts.pricedServices > 0;
    case "phone":
      return phonePath === "missed_call_catcher" ? Boolean(facts.catcherNumber) : Boolean(facts.aiNumber);
    case "forwarding":
      return phonePath === "missed_call_catcher"
        ? Boolean(facts.catcherNumber) && facts.forwardingVerified
        : Boolean(facts.aiNumber) && (Boolean(facts.aiForwardingVerified) || Boolean(facts.receptionistForwardedCall));
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
        ? { title: "Text-back number", action: "get your text-back number (we buy it for you)" }
        : { title: "AI receptionist number", action: "get your AI receptionist number (we buy it for you)" };
    case "forwarding":
      return { title: "Turn on call forwarding", action: "turn on call forwarding (one tap from your business phone)" };
    case "test_call":
      return {
        title: "Make a test call",
        action: facts.aiNumber
          ? `call your AI receptionist at ${prettyPhone(facts.aiNumber)} to test it`
          : "make a test call to your AI receptionist",
      };
    case "payments":
      return { title: "Connect payments", action: "connect Stripe so you can take deposits and card payments" };
    case "website":
      return { title: "Add the form to your website", action: "add your lead form to your website" };
    case "automations":
      return { title: "Missed-call text-back on", action: "turn on the missed-call text-back" };
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
  /** Absolute app origin for deep links (the CrankLeads host), no trailing slash needed. */
  appBaseUrl: string;
  /** The one-tap forwarding page (/forward/:token) — the forwarding step's deep link when set. */
  forwardUrl?: string | null;
}

/** PURE. The ordered required steps (+ optional extras) for the tier, each done or not, with deep links. */
export function computeSetupChecklist(input: ComputeSetupChecklistInput): SetupChecklist {
  const base = input.appBaseUrl.replace(/\/+$/, "");
  const phonePath = phonePathFor(input.tier, input.facts);
  const toStep = (key: SetupStepKey, required: boolean): SetupChecklistStep => {
    const wizardStep = WIZARD_STEP[key];
    const path = setupStepPath(input.organizationId, wizardStep);
    const deepLink = key === "forwarding" && input.forwardUrl ? input.forwardUrl : `${base}${path}`;
    return {
      key,
      required,
      ...stepCopy(key, input.facts, phonePath),
      done: stepDone(key, input.facts, phonePath),
      wizardStep,
      path,
      deepLink,
    };
  };
  const steps = requiredSetupSteps(input.tier, phonePath).map((key) => toStep(key, true));
  const extras = optionalSetupSteps(input.tier, phonePath).map((key) => toStep(key, false));
  const doneCount = steps.filter((s) => s.done).length;
  const nextStep = steps.find((s) => !s.done) ?? null;
  return {
    organizationId: input.organizationId,
    companyId: input.companyId,
    tier: input.tier,
    phonePath,
    steps,
    extras,
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
    db
      .from("companies")
      .select("stripe_charges_enabled, brand_reply_phone, owner_phone_e164")
      .eq("organization_id", org)
      .eq("id", companyId)
      .maybeSingle(),
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

  const companyRow = company.data as { stripe_charges_enabled: boolean; brand_reply_phone: string | null; owner_phone_e164: string | null } | null;
  const receptionistForwardedCall =
    ai && (calls.data ?? []).length > 0 && !ai.forwarding_verified_at
      ? await hasFrontDeskForwardingEvidence(db, {
          organizationId: org,
          companyId,
          aiNumber: ai.phone_e164,
          businessLine: businessLineOf(companyRow),
        })
      : false;

  return {
    pricedServices: items.length - unpriced,
    servicesNeedingPrices: unpriced,
    catcherNumber: catcher?.phone_e164 ?? null,
    forwardingVerified: Boolean(catcher?.forwarding_verified_at),
    aiNumber: ai?.phone_e164 ?? null,
    aiForwardingVerified: Boolean(ai?.forwarding_verified_at),
    receptionistCallReceived: (calls.data ?? []).length > 0,
    receptionistForwardedCall,
    paymentsConnected: Boolean(companyRow?.stripe_charges_enabled),
    websiteLeadReceived: (forms.data ?? []).length > 0 || (!intakeKeys.error && (intakeKeys.data ?? []).length > 0),
    textBackActive: (textBack.data ?? []).length > 0,
  };
}

/** Only CrankLeads orgs have a setup checklist, so its deep links default to the CrankLeads host. */
function defaultAppBaseUrl(): string {
  return appBaseUrlFor("crankleads");
}

export interface LoadSetupChecklistOptions {
  /** The CrankLeads company (crankleads_purchases.company_id). Default: the org's first company. */
  companyId?: string | null;
  /** Skip the organizations lookup when the caller already knows the tier. */
  tier?: CrankleadsTier | null;
  appBaseUrl?: string;
  /** One-tap forwarding page for the forwarding step's link (null → the in-app path). */
  forwardUrl?: string | null;
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
    forwardUrl: options.forwardUrl ?? null,
  });
}
