import { createHash } from "node:crypto";

import type { Inserts, Json, Tables } from "@/server/db/database.types";
import { ValidationError } from "@/server/organizations/context";
import { ALL_PACKS, getPack } from "@/server/services/packs";
import {
  parseAppliedIndustryPack,
  type AppliedIndustryPack,
  type IndustryPack,
  type PackRecipe,
} from "@/server/services/packs/types";
import { listCatalogItems } from "@/server/services/quotes/catalog-items";
import { assertCompanyInOrganization, insertRow, type TenantServiceContext } from "@/server/services/shared";
import { getRecipe, type Recipe } from "@/server/services/workflow-engine/recipes";
import { missingRequirements } from "@/server/services/workflow-engine/recipes/install";
import type { WorkflowAction, WorkflowDefinition } from "@/server/services/workflow-engine/types";
import { createWorkflow, updateWorkflow } from "@/server/services/workflows";

/**
 * Apply an industry starter pack to a company. Idempotent and re-runnable, tenant-scoped
 * through the caller's RLS client (no service role):
 *
 *   • Services — creates the pack's catalog items that the company doesn't already have
 *     (matched by label, case-insensitive, or by service_key). Items are created with NO
 *     price and `active = false`, so nothing can quote $0 before the owner prices them;
 *     pricing an item (updateCatalogItemPrices) switches it on.
 *   • Recipes — installs the pack's recipes with the trade's messages. A recipe that's
 *     already installed is updated only if the owner hasn't touched it: its definition
 *     still equals the stock recipe, or still matches the fingerprint stamped by the last
 *     pack apply. Anything else is the owner's edit — skipped and reported, never clobbered.
 *     Status (active / draft / paused) is never changed on an existing workflow.
 *   • Booking windows — only on request, and only when the company has no policy yet.
 *   • Records {id, version, appliedAt, recipes} on companies.industry_pack.
 */

export interface ApplyPackOptions {
  /** Create the pack's catalog items (default true). */
  services?: boolean;
  /** Which of the pack's recipes to install/tailor: all (default), none, or a subset of slugs. */
  recipes?: "all" | "none" | string[];
  /** Set companies.booking_policy from the pack when the company has none (default false). */
  bookingPolicy?: boolean;
}

export interface NeedsPriceItem {
  id: string;
  label: string;
  unit: string | null;
  pricingType: string;
}

export interface ApplyPackReport {
  pack: { id: string; version: number; name: string };
  services: {
    created: Array<{ id: string; label: string }>;
    skipped: Array<{ label: string; reason: "already_exists" }>;
  };
  /** Every catalog item on the company that still has no price (pack-created or not). */
  needsPrices: NeedsPriceItem[];
  recipes: {
    installed: Array<{ slug: string; workflowId: string; status: "active" | "draft"; disabledReason: string | null }>;
    updated: Array<{ slug: string; workflowId: string }>;
    unchanged: string[];
    skippedOwnerEdited: Array<{ slug: string; workflowId: string }>;
  };
  bookingPolicy: "applied" | "kept_existing" | "not_requested" | "not_in_pack";
  applied: AppliedIndustryPack;
}

type ParsedPack = IndustryPack;

// ── Pure helpers (exported for tests) ──────────────────────────────────────────

/** Stable JSON: object keys sorted recursively, so a jsonb round-trip compares equal. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** The definition minus engine/install metadata (`_disabled_reason`, `_pack`, …). */
export function definitionContent(definition: unknown): Record<string, unknown> {
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) return {};
  return Object.fromEntries(Object.entries(definition as Record<string, unknown>).filter(([k]) => !k.startsWith("_")));
}

export function definitionFingerprint(definition: unknown): string {
  return createHash("sha256").update(canonicalJson(definitionContent(definition))).digest("hex").slice(0, 16);
}

/** The base recipe with the pack's message / wait / schedule overrides applied. Pure. */
export function buildPackRecipeDefinition(
  recipe: Recipe,
  override: PackRecipe,
  pack: { id: string; reviewRequest: { delay: string } },
): WorkflowDefinition {
  const definition = JSON.parse(JSON.stringify(recipe.definition)) as WorkflowDefinition;
  const actions: WorkflowAction[] = definition.actions;

  for (const message of override.messages ?? []) {
    const action = actions[message.actionIndex];
    if (!action || (action.type !== "send_sms" && action.type !== "send_email")) {
      throw new Error(`Pack ${pack.id}: ${recipe.slug} action ${message.actionIndex} is not a send_sms/send_email.`);
    }
    action.body = message.body;
    if (message.subject !== undefined) {
      if (action.type !== "send_email") throw new Error(`Pack ${pack.id}: ${recipe.slug} subject on a non-email action.`);
      action.subject = message.subject;
    }
  }

  const waits = [...(override.waits ?? [])];
  // Review timing is a pack-level setting; it lands on review-request's opening wait.
  if (recipe.slug === "review-request") waits.push({ actionIndex: 0, duration: pack.reviewRequest.delay });
  for (const wait of waits) {
    const action = actions[wait.actionIndex];
    if (!action || action.type !== "wait" || action.duration === undefined) {
      throw new Error(`Pack ${pack.id}: ${recipe.slug} action ${wait.actionIndex} is not a duration wait.`);
    }
    action.duration = wait.duration;
  }

  if (override.schedule) definition.schedule = { ...(definition.schedule ?? {}), ...override.schedule };
  return definition;
}

function selectedPackRecipes(pack: ParsedPack, selection: ApplyPackOptions["recipes"]): ParsedPack["recipes"] {
  if (selection === "none") return [];
  if (!selection || selection === "all") return pack.recipes;
  const wanted = new Set(selection);
  return pack.recipes.filter((r) => wanted.has(r.slug));
}

function needsPrice(item: Tables<"service_catalog_items">): boolean {
  return item.rate_cents === 0 && item.minimum_cents === 0 && item.tiers == null && item.rate_bands == null;
}

function toNeedsPrice(items: Tables<"service_catalog_items">[]): NeedsPriceItem[] {
  return items
    .filter(needsPrice)
    .map((i) => ({ id: i.id, label: i.label, unit: i.unit_label, pricingType: i.pricing_type }));
}

// ── JSON mapping (explicit fields — no casts; Working Protocol #13) ───────────

export function appliedPackJson(applied: AppliedIndustryPack): Json {
  return { id: applied.id, version: applied.version, appliedAt: applied.appliedAt, recipes: [...applied.recipes] };
}

export function bookingPolicyJson(policy: NonNullable<IndustryPack["booking"]>): Json {
  const out: { [key: string]: Json } = { mode: policy.mode };
  if (policy.windows) {
    out.windows = policy.windows.map((w) => ({ key: w.key, start: w.start, durationMinutes: w.durationMinutes, spoken: w.spoken }));
  }
  if (policy.capacityPerWindow !== undefined) out.capacityPerWindow = policy.capacityPerWindow;
  if (policy.leadTimeHours !== undefined) out.leadTimeHours = policy.leadTimeHours;
  if (policy.horizonDays !== undefined) out.horizonDays = policy.horizonDays;
  if (policy.workingDays) out.workingDays = [...policy.workingDays];
  return out;
}

// ── Data access ────────────────────────────────────────────────────────────────

async function loadCompanyPackState(
  context: TenantServiceContext,
  companyId: string,
): Promise<{ booking_policy: Json | null; industry_pack: Json | null }> {
  const { data, error } = await context.supabase
    .from("companies")
    .select("booking_policy, industry_pack")
    .eq("organization_id", context.organizationId)
    .eq("id", companyId)
    .single();
  if (error) throw error;
  return data as { booking_policy: Json | null; industry_pack: Json | null };
}

async function updateCompany(
  context: TenantServiceContext,
  companyId: string,
  patch: { booking_policy?: Json; industry_pack?: Json },
): Promise<void> {
  const { error } = await context.supabase
    .from("companies")
    .update(patch)
    .eq("organization_id", context.organizationId)
    .eq("id", companyId);
  if (error) throw error;
}

async function installedWorkflows(
  context: TenantServiceContext,
  companyId: string,
): Promise<Map<string, { id: string; definition: Json }>> {
  const { data, error } = await context.supabase
    .from("workflows")
    .select("id, slug, definition")
    .eq("organization_id", context.organizationId)
    .eq("company_id", companyId);
  if (error) throw error;
  return new Map(
    ((data ?? []) as Array<{ id: string; slug: string; definition: Json }>).map((row) => [
      row.slug,
      { id: row.id, definition: row.definition },
    ]),
  );
}

// ── Apply ──────────────────────────────────────────────────────────────────────

export async function applyIndustryPack(
  context: TenantServiceContext,
  companyId: string,
  packId: string,
  options: ApplyPackOptions = {},
): Promise<ApplyPackReport> {
  const pack = getPack(packId);
  if (!pack) throw new ValidationError(`Unknown industry pack "${packId}".`);
  await assertCompanyInOrganization(context, companyId);

  const company = await loadCompanyPackState(context, companyId);
  const report: ApplyPackReport = {
    pack: { id: pack.id, version: pack.version, name: pack.name },
    services: { created: [], skipped: [] },
    needsPrices: [],
    recipes: { installed: [], updated: [], unchanged: [], skippedOwnerEdited: [] },
    bookingPolicy: "not_requested",
    applied: { id: pack.id, version: pack.version, appliedAt: "", recipes: [] },
  };

  // 1) Services — create what's missing, price-less and inactive until the owner prices it.
  let catalog = await listCatalogItems(context, companyId);
  if (options.services !== false) {
    const labels = new Set(catalog.map((i) => i.label.trim().toLowerCase()));
    const keys = new Set(catalog.map((i) => i.service_key));
    const nextSort = catalog.reduce((max, i) => Math.max(max, i.sort_order), 0) + 1;

    for (const [index, service] of pack.services.entries()) {
      if (labels.has(service.label.trim().toLowerCase()) || keys.has(service.key)) {
        report.services.skipped.push({ label: service.label, reason: "already_exists" });
        continue;
      }
      const row: Inserts<"service_catalog_items"> = {
        organization_id: context.organizationId,
        company_id: companyId,
        service_key: service.key,
        label: service.label,
        description: service.description,
        pricing_type: service.pricingType,
        rate_cents: 0,
        minimum_cents: 0,
        unit_label: service.unit,
        active: false,
        sort_order: nextSort + index,
      };
      const created = await insertRow(context, "service_catalog_items", row);
      report.services.created.push({ id: created.id, label: created.label });
      labels.add(service.label.trim().toLowerCase());
      keys.add(service.key);
    }
    if (report.services.created.length > 0) catalog = await listCatalogItems(context, companyId);
  }
  report.needsPrices = toNeedsPrice(catalog);

  // 2) Recipes — install or tailor, never clobbering the owner's edits.
  const recipes = selectedPackRecipes(pack, options.recipes);
  const existing = recipes.length > 0 ? await installedWorkflows(context, companyId) : new Map<string, { id: string; definition: Json }>();

  for (const packRecipe of recipes) {
    const recipe = getRecipe(packRecipe.slug);
    if (!recipe) throw new Error(`Pack ${pack.id} references unknown recipe "${packRecipe.slug}".`);
    const target = buildPackRecipeDefinition(recipe, packRecipe, pack);
    const targetFingerprint = definitionFingerprint(target);
    const stamp = { id: pack.id, version: pack.version, fingerprint: targetFingerprint };
    const current = existing.get(recipe.slug);

    if (!current) {
      const missing = missingRequirements(recipe);
      const status: "active" | "draft" = missing.length > 0 ? "draft" : recipe.default_status;
      const disabledReason = missing.length > 0 ? `Needs ${missing.join(" + ")} configured before it can run.` : null;
      const workflow = await createWorkflow(context, {
        companyId,
        name: recipe.name,
        slug: recipe.slug,
        description: recipe.description,
        triggerEvent: recipe.trigger_event,
        definition: { ...target, ...(disabledReason ? { _disabled_reason: disabledReason } : {}), _pack: stamp },
        status,
      });
      report.recipes.installed.push({ slug: recipe.slug, workflowId: workflow.id, status, disabledReason });
      continue;
    }

    const currentDef = (current.definition ?? {}) as Record<string, unknown>;
    const currentFingerprint = definitionFingerprint(currentDef);
    if (currentFingerprint === targetFingerprint) {
      report.recipes.unchanged.push(recipe.slug);
      continue;
    }

    const lastStamp = currentDef._pack as { fingerprint?: unknown } | undefined;
    const isStock = currentFingerprint === definitionFingerprint(recipe.definition);
    const isUntouchedPackVersion = typeof lastStamp?.fingerprint === "string" && lastStamp.fingerprint === currentFingerprint;
    if (!isStock && !isUntouchedPackVersion) {
      report.recipes.skippedOwnerEdited.push({ slug: recipe.slug, workflowId: current.id });
      continue;
    }

    // Keep install metadata (e.g. _disabled_reason); replace the content; re-stamp.
    const preservedMeta = Object.fromEntries(Object.entries(currentDef).filter(([k]) => k.startsWith("_") && k !== "_pack"));
    await updateWorkflow(context, {
      workflowId: current.id,
      definition: { ...preservedMeta, ...target, _pack: stamp } as Record<string, unknown>,
    });
    report.recipes.updated.push({ slug: recipe.slug, workflowId: current.id });
  }

  // 3) Booking windows — opt-in, never over an existing policy.
  if (options.bookingPolicy) {
    if (!pack.booking) report.bookingPolicy = "not_in_pack";
    else if (company.booking_policy != null) report.bookingPolicy = "kept_existing";
    else {
      await updateCompany(context, companyId, { booking_policy: bookingPolicyJson(pack.booking) });
      report.bookingPolicy = "applied";
    }
  }

  // 4) Record what the company was given.
  const previous = parseAppliedIndustryPack(company.industry_pack);
  const touched = [
    ...report.recipes.installed.map((r) => r.slug),
    ...report.recipes.updated.map((r) => r.slug),
    ...report.recipes.unchanged,
  ];
  const recipeSlugs = [...new Set([...(previous?.id === pack.id ? previous.recipes : []), ...touched])];
  report.applied = { id: pack.id, version: pack.version, appliedAt: new Date().toISOString(), recipes: recipeSlugs };
  await updateCompany(context, companyId, { industry_pack: appliedPackJson(report.applied) });

  return report;
}

// ── Listing (for the picker / Settings) ────────────────────────────────────────

export interface IndustryPackSummary {
  id: string;
  version: number;
  name: string;
  tagline: string;
  description: string;
  services: Array<{ key: string; label: string; unit: string; pricingType: string; category: string; description: string }>;
  recipes: string[];
  reviewRequestDelay: string;
  hasBookingDefaults: boolean;
}

export function summarizePack(pack: IndustryPack): IndustryPackSummary {
  return {
    id: pack.id,
    version: pack.version,
    name: pack.name,
    tagline: pack.tagline,
    description: pack.description,
    services: pack.services.map((s) => ({ ...s })),
    recipes: pack.recipes.map((r) => r.slug),
    reviewRequestDelay: pack.reviewRequest.delay,
    hasBookingDefaults: Boolean(pack.booking),
  };
}

export interface IndustryPackListing {
  packs: IndustryPackSummary[];
  /** The pack recorded on the company (when companyId is given). */
  applied: AppliedIndustryPack | null;
  needsPrices: NeedsPriceItem[];
}

export async function listIndustryPacks(
  context: TenantServiceContext,
  companyId: string | null,
): Promise<IndustryPackListing> {
  const packs = ALL_PACKS.map(summarizePack);
  if (!companyId) return { packs, applied: null, needsPrices: [] };
  await assertCompanyInOrganization(context, companyId);
  const [company, catalog] = await Promise.all([
    loadCompanyPackState(context, companyId),
    listCatalogItems(context, companyId),
  ]);
  return { packs, applied: parseAppliedIndustryPack(company.industry_pack), needsPrices: toNeedsPrice(catalog) };
}
