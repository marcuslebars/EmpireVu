// ─────────────────────────────────────────────────────────────────────────────
// SANCTIONED EXCEPTION (service role): done-for-you enrichment.
// Runs from the scheduler (no user session) on a quick-setup intake the buyer submitted.
// Every write is scoped to the intake's own organization_id + company_id.
// See docs/done-for-you.md, "Intake & enrichment".
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Fill in the buyer's company from what they told us (the intake) plus their Google listing
 * and their own website. Hard rules: never invent facts or prices — prices come only from the
 * owner (intake) or text stated on their own site; don't overwrite what an owner set by hand
 * (companies.profile.source records where each auto-filled value came from).
 *
 * The planners (planCompanyUpdate, planServicePrices, matchServiceName) are pure and tested;
 * enrichCompany / processPendingEnrichments do the I/O.
 */
import { NEW_SERVICE_UNITS, type IntakeAnswers } from "@/lib/setup-intake";
import { combinePageTexts, draftCatalogFromText, type CatalogDraft } from "@/server/ai/catalog-parser";
import { isAIConfigured, type AiUsageMeta } from "@/server/ai/claude";
import type { Inserts, Json, Tables } from "@/server/db/database.types";
import { slugify } from "@/server/db/helpers";
import type { AdminClient } from "@/server/services/crankleads/purchases";
import { crawlWebsite, type CrawlDeps, type CrawlResult } from "@/server/services/dfy/crawl";
import { readAnswers, type SetupIntake } from "@/server/services/dfy/intake";
import { getPlaceDetails, serviceAreaFromPlace, type PlaceDetails } from "@/server/services/dfy/places";
import { insertRow, type TenantServiceContext } from "@/server/services/shared";
import { recordAiUsageSafe } from "@/server/services/usage";

type CompanyRow = Tables<"companies">;
type CatalogRow = Pick<
  Tables<"service_catalog_items">,
  "id" | "label" | "pricing_type" | "unit_label" | "rate_cents" | "minimum_cents" | "active" | "sort_order" | "service_key"
>;

export const MAX_ENRICH_ATTEMPTS = 3;
/** An 'enriching' claim older than this is a crashed run — reclaimable. */
export const ENRICH_STALE_MS = 15 * 60 * 1000;
/** Wait between a failed run and its retry. */
export const ENRICH_RETRY_AFTER_MS = 10 * 60 * 1000;

export type FactSource = "intake" | "google" | "website";
/** Later sources in this list outrank earlier ones when both are automatic. */
const SOURCE_RANK: Record<FactSource, number> = { website: 1, google: 2, intake: 3 };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (typeof value === "object") return Object.keys(value as object).length === 0;
  return false;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

// ── Company facts ────────────────────────────────────────────────────────────

export interface EnrichmentFacts {
  answers: IntakeAnswers | null;
  place: PlaceDetails | null;
  crawl: Pick<CrawlResult, "homepageUrl" | "logoUrl" | "description" | "hoursText" | "phones"> | null;
}

export interface AppliedField {
  field: string;
  value: unknown;
  source: FactSource;
}

export interface CompanyPlan {
  patch: Partial<CompanyRow>;
  applied: AppliedField[];
  kept: Array<{ field: string; reason: "owner_set" | "higher_source" }>;
}

/**
 * Decide what to write on companies. A field is written when it's empty, or when it was
 * auto-filled before (profile.source[field]) by a source that doesn't outrank this one.
 * Anything set by hand (non-empty, no recorded source) is kept. Pure.
 */
export function planCompanyUpdate(
  company: Pick<
    CompanyRow,
    | "website"
    | "hours"
    | "service_area"
    | "brand_logo_url"
    | "brand_review_url"
    | "brand_reply_phone"
    | "owner_phone_e164"
    | "google_place_id"
    | "profile"
  >,
  facts: EnrichmentFacts,
): CompanyPlan {
  const profile = asRecord(company.profile);
  const sources = asRecord(profile.source) as Record<string, FactSource | undefined>;
  const patch: Partial<CompanyRow> = {};
  const nextProfile: Record<string, unknown> = { ...profile };
  const nextSources: Record<string, unknown> = { ...sources };
  const applied: AppliedField[] = [];
  const kept: CompanyPlan["kept"] = [];

  const offer = (field: string, current: unknown, value: unknown, source: FactSource, write: (v: unknown) => void) => {
    if (isEmpty(value)) return;
    const prior = sources[field];
    if (!isEmpty(current) && JSON.stringify(current) !== JSON.stringify(value)) {
      if (!prior) return void kept.push({ field, reason: "owner_set" });
      if (SOURCE_RANK[prior] > SOURCE_RANK[source]) return void kept.push({ field, reason: "higher_source" });
    }
    write(value);
    nextSources[field] = source;
    applied.push({ field, value, source });
  };
  const column = <K extends keyof CompanyRow>(key: K, current: unknown, value: CompanyRow[K] | null | undefined, source: FactSource) =>
    offer(String(key), current, value, source, (v) => {
      patch[key] = v as CompanyRow[K];
    });

  const { answers, place, crawl } = facts;

  // Website: what the buyer typed > their Google listing > where the crawl landed.
  const website =
    answers?.listing.kind === "website"
      ? { value: answers.listing.url, source: "intake" as const }
      : place?.website
        ? { value: place.website, source: "google" as const }
        : null;
  if (website) column("website", company.website, website.value, website.source);

  // Hours: Google's opening hours, else hours stated on the site.
  if (place?.hours) {
    column("hours", company.hours, { summary: place.hours.summary, periods: place.hours.periods } as unknown as Json, "google");
  } else if (crawl?.hoursText) {
    column("hours", company.hours, { summary: crawl.hoursText } as unknown as Json, "website");
  }

  column("service_area", company.service_area, serviceAreaFromPlace(place), "google");
  column("brand_logo_url", company.brand_logo_url, crawl?.logoUrl ?? null, "website");

  if (place) {
    // Google facts about the listing itself — the owner can't set these by hand.
    patch.google_place_id = place.placeId;
    patch.google_rating = place.rating;
    patch.google_review_count = place.reviewCount;
    applied.push({ field: "google_place_id", value: place.placeId, source: "google" });
    if (place.rating !== null) applied.push({ field: "google_rating", value: place.rating, source: "google" });
    if (place.reviewCount !== null) applied.push({ field: "google_review_count", value: place.reviewCount, source: "google" });
    column("brand_review_url", company.brand_review_url, place.reviewUrl, "google");
  }

  if (answers) {
    // The buyer's own answers about their line.
    patch.business_phone_kind = answers.phone.kind;
    patch.business_phone_carrier = answers.phone.carrier;
    applied.push({ field: "business_phone_kind", value: answers.phone.kind, source: "intake" });
    applied.push({ field: "business_phone_carrier", value: answers.phone.carrier, source: "intake" });
    // A corrected number is where we reach the owner — unless it's a landline (texts
    // would never arrive there; the number from checkout stays our texting number).
    if (answers.phone.number !== company.owner_phone_e164 && answers.phone.kind !== "landline") {
      patch.owner_phone_e164 = answers.phone.number;
      applied.push({ field: "owner_phone_e164", value: answers.phone.number, source: "intake" });
    }
    column("brand_reply_phone", company.brand_reply_phone, answers.phone.number, "intake");
  }

  // Profile (generated-site copy) — only facts we have, rephrased by nobody.
  const tagline = place?.primaryType && place.locality ? `${place.primaryType} in ${place.locality}` : null;
  offer("tagline", profile.tagline, tagline, "google", (v) => {
    nextProfile.tagline = v;
  });
  offer("about", profile.about, crawl?.description ?? null, "website", (v) => {
    nextProfile.about = v;
  });

  if (JSON.stringify(nextSources) !== JSON.stringify(sources) || JSON.stringify(nextProfile) !== JSON.stringify(profile)) {
    patch.profile = { ...nextProfile, source: nextSources } as unknown as Json;
  }
  return { patch, applied, kept };
}

// ── Services + prices ────────────────────────────────────────────────────────

const STOP_WORDS = new Set(["service", "services", "the", "a", "an", "our", "and", "of", "for", "with", "your", "&"]);

export function serviceTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t && !STOP_WORDS.has(t))
    .map((t) => (t.length > 3 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t));
}

/** Similarity of two service names in [0, 1]; conservative (token Jaccard). Pure. */
export function matchServiceName(a: string, b: string): number {
  const ta = new Set(serviceTokens(a));
  const tb = new Set(serviceTokens(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  if ([...ta].join(" ") === [...tb].join(" ")) return 1;
  const shared = [...ta].filter((t) => tb.has(t)).length;
  return shared / new Set([...ta, ...tb]).size;
}

/** Same service? Exact after normalising, or ≥ 75% of the words shared (and at least two). */
export function isSameService(a: string, b: string): boolean {
  const score = matchServiceName(a, b);
  if (score === 1) return true;
  const shared = serviceTokens(a).filter((t) => serviceTokens(b).includes(t)).length;
  return score >= 0.75 && shared >= 2;
}

export type PriceSource = "owner" | "website";

export interface PriceOp {
  kind: "price";
  id: string;
  label: string;
  cents: number;
  source: PriceSource;
}

export interface CreateOp {
  kind: "create";
  label: string;
  pricingType: string;
  unit: string | null;
  cents: number;
  description: string | null;
  source: PriceSource;
}

export interface ServicePlan {
  ops: Array<PriceOp | CreateOp>;
  /** Services the site lists without a stated price (shown to the console; not added). */
  unpricedOnSite: string[];
  /** Site prices we didn't apply: unit doesn't match the item, or unclear. */
  notApplied: Array<{ label: string; cents: number; pricingType: string; reason: string }>;
}

/**
 * Who sets each price: the owner's intake answer > a price stated on their own site
 * (matched to an existing item by name, conservatively, and only when the unit agrees and
 * the item has no price yet) > nothing. Unmatched priced site services are added (flat
 * prices only — a per-unit price without a known unit could mislead). Never invents. Pure.
 */
export function planServicePrices(catalog: CatalogRow[], answers: IntakeAnswers | null, drafts: CatalogDraft[]): ServicePlan {
  const ops: ServicePlan["ops"] = [];
  const plan: ServicePlan = { ops, unpricedOnSite: [], notApplied: [] };
  const ownerSet = new Set<string>();
  const claimedLabels: string[] = catalog.map((c) => c.label);

  // 1) Owner prices.
  for (const item of answers?.prices.items ?? []) {
    if (!(item.priceCents > 0)) continue;
    if (item.id) {
      const row = catalog.find((c) => c.id === item.id);
      if (!row) continue;
      ownerSet.add(row.id);
      ops.push({ kind: "price", id: row.id, label: row.label, cents: item.priceCents, source: "owner" });
      continue;
    }
    const unit = NEW_SERVICE_UNITS.find((u) => u.key === (item.unit ?? "flat")) ?? NEW_SERVICE_UNITS[0];
    const existing = catalog.find((c) => !ownerSet.has(c.id) && isSameService(c.label, item.label) && c.pricing_type === unit.pricingType);
    if (existing) {
      ownerSet.add(existing.id);
      ops.push({ kind: "price", id: existing.id, label: existing.label, cents: item.priceCents, source: "owner" });
    } else {
      ops.push({ kind: "create", label: item.label, pricingType: unit.pricingType, unit: unit.unit, cents: item.priceCents, description: null, source: "owner" });
      claimedLabels.push(item.label);
    }
  }

  // 2) Prices stated on their site.
  const takenBySite = new Set<string>();
  for (const draft of drafts) {
    const cents = typeof draft.baseCents === "number" && draft.baseCents > 0 ? draft.baseCents : null;
    // Best existing match.
    let best: { row: CatalogRow; score: number } | null = null;
    for (const row of catalog) {
      if (!isSameService(row.label, draft.name)) continue;
      const score = matchServiceName(row.label, draft.name);
      if (!best || score > best.score) best = { row, score };
    }
    if (best) {
      const row = best.row;
      if (cents === null || ownerSet.has(row.id) || takenBySite.has(row.id)) continue;
      if (row.rate_cents > 0 || row.minimum_cents > 0) continue; // already priced (by hand or earlier)
      if (row.pricing_type !== draft.pricingType) {
        plan.notApplied.push({ label: draft.name, cents, pricingType: draft.pricingType, reason: `unit differs from "${row.label}"` });
        continue;
      }
      takenBySite.add(row.id);
      ops.push({ kind: "price", id: row.id, label: row.label, cents, source: "website" });
      continue;
    }
    if (claimedLabels.some((label) => isSameService(label, draft.name))) continue;
    if (cents === null) {
      plan.unpricedOnSite.push(draft.name);
      continue;
    }
    if (draft.pricingType !== "flat") {
      plan.notApplied.push({ label: draft.name, cents, pricingType: draft.pricingType, reason: "unit unclear" });
      continue;
    }
    ops.push({
      kind: "create",
      label: draft.name.slice(0, 200),
      pricingType: "flat",
      unit: null,
      cents,
      description: draft.description?.trim() || null,
      source: "website",
    });
    claimedLabels.push(draft.name);
  }
  return plan;
}

// ── The enrichment record (setup_intakes.enrichment) ─────────────────────────

export interface EnrichmentSummary {
  version: 1;
  ranAt: string;
  sources: {
    google: { placeId: string; used: boolean; error?: string } | null;
    website: { url: string; pages: string[]; error?: string } | null;
    catalogParser: { used: boolean; services: number; error?: string } | null;
  };
  company: { applied: AppliedField[]; kept: CompanyPlan["kept"] };
  services: {
    priced: Array<{ id: string; label: string; cents: number; source: PriceSource }>;
    added: Array<{ id: string; label: string; cents: number; source: PriceSource }>;
    unpricedOnSite: string[];
    notApplied: ServicePlan["notApplied"];
    skippedByOwner: boolean;
  };
  /** Facts the console / site builder can show (no Google review text or photos). */
  facts: {
    place: { name: string | null; address: string | null; phone: string | null; mapsUrl: string | null; primaryType: string | null } | null;
    site: { phones: string[]; logoUrl: string | null; description: string | null } | null;
  };
}

// ── I/O ──────────────────────────────────────────────────────────────────────

export interface EnrichDeps {
  getPlaceDetails: (placeId: string) => Promise<PlaceDetails | null>;
  crawlWebsite: (url: string, businessName: string | null) => Promise<CrawlResult>;
  /** Null when AI isn't configured (prices from the site are then skipped). */
  draftCatalog: ((text: string) => Promise<{ drafts: CatalogDraft[]; usage: AiUsageMeta | null }>) | null;
  now: () => number;
}

function defaultDeps(crawlDeps: CrawlDeps = {}): EnrichDeps {
  return {
    getPlaceDetails: (placeId) => getPlaceDetails(placeId),
    crawlWebsite: (url, name) => crawlWebsite(url, name, crawlDeps),
    draftCatalog: isAIConfigured() ? async (text) => draftCatalogFromText(text) : null,
    now: () => Date.now(),
  };
}

async function loadIntakeForCompany(admin: AdminClient, companyId: string): Promise<SetupIntake | null> {
  const { data, error } = await admin.from("setup_intakes").select("*").eq("company_id", companyId).maybeSingle();
  if (error) throw new Error(`setup_intakes lookup failed: ${error.message}`);
  return (data as SetupIntake | null) ?? null;
}

async function applyServicePlan(
  admin: AdminClient,
  intake: SetupIntake,
  catalog: CatalogRow[],
  plan: ServicePlan,
): Promise<Pick<EnrichmentSummary["services"], "priced" | "added">> {
  const priced: EnrichmentSummary["services"]["priced"] = [];
  const added: EnrichmentSummary["services"]["added"] = [];
  const ctx: TenantServiceContext = { actorProfileId: null, organizationId: intake.organization_id, supabase: admin };
  let nextSort = catalog.reduce((max, c) => Math.max(max, c.sort_order), 0) + 1;
  const keys = new Set(catalog.map((c) => c.service_key));

  for (const op of plan.ops) {
    if (op.kind === "price") {
      const { error } = await admin
        .from("service_catalog_items")
        .update({ rate_cents: op.cents, active: true })
        .eq("organization_id", intake.organization_id)
        .eq("company_id", intake.company_id)
        .eq("id", op.id);
      if (error) throw new Error(`catalog price write failed: ${error.message}`);
      priced.push({ id: op.id, label: op.label, cents: op.cents, source: op.source });
      continue;
    }
    let key = slugify(op.label).slice(0, 72) || "service";
    for (let n = 2; keys.has(key); n++) key = `${slugify(op.label).slice(0, 72) || "service"}-${n}`;
    keys.add(key);
    const row: Inserts<"service_catalog_items"> = {
      organization_id: intake.organization_id,
      company_id: intake.company_id,
      service_key: key,
      label: op.label,
      description: op.description,
      pricing_type: op.pricingType,
      rate_cents: op.cents,
      minimum_cents: 0,
      unit_label: op.unit,
      active: true,
      sort_order: nextSort++,
    };
    const created = await insertRow(ctx, "service_catalog_items", row);
    added.push({ id: created.id, label: created.label, cents: op.cents, source: op.source });
  }
  return { priced, added };
}

/**
 * Enrich one company from its submitted intake: Google listing, website crawl, stated prices.
 * Writes the company + catalog and the intake's `enrichment` record; returns the summary.
 * Re-running is safe (same facts → same writes; added services match themselves next time).
 * Status changes are processPendingEnrichments' job.
 */
export async function enrichCompany(
  admin: AdminClient,
  companyId: string,
  depsOverride: Partial<EnrichDeps> = {},
): Promise<EnrichmentSummary> {
  const deps: EnrichDeps = { ...defaultDeps(), ...depsOverride };
  const intake = await loadIntakeForCompany(admin, companyId);
  if (!intake) throw new Error(`no setup intake for company ${companyId}`);
  const answers = readAnswers(intake.answers);

  const { data: companyData, error: companyError } = await admin
    .from("companies")
    .select("*")
    .eq("organization_id", intake.organization_id)
    .eq("id", intake.company_id)
    .maybeSingle();
  if (companyError) throw new Error(`company lookup failed: ${companyError.message}`);
  if (!companyData) throw new Error(`company ${companyId} not found`);
  const company = companyData as CompanyRow;

  const sources: EnrichmentSummary["sources"] = { google: null, website: null, catalogParser: null };

  // 1) Google listing.
  let place: PlaceDetails | null = null;
  if (answers?.listing.kind === "google") {
    const placeId = answers.listing.placeId;
    try {
      place = await deps.getPlaceDetails(placeId);
      sources.google = { placeId, used: Boolean(place), ...(place ? {} : { error: "Google Places not configured or no details" }) };
    } catch (err) {
      sources.google = { placeId, used: false, error: errorMessage(err).slice(0, 300) };
    }
  }

  // 2) Their website: what they typed, else the one on their listing, else one already on file.
  const siteUrl =
    answers?.listing.kind === "website" ? answers.listing.url : place?.website ?? (answers?.listing.kind === "none" ? null : company.website);
  let crawl: CrawlResult | null = null;
  if (siteUrl) {
    try {
      crawl = await deps.crawlWebsite(siteUrl, place?.name ?? company.name);
      sources.website = { url: crawl.homepageUrl, pages: crawl.pages.map((p) => p.url) };
    } catch (err) {
      sources.website = { url: siteUrl, pages: [], error: errorMessage(err).slice(0, 300) };
    }
  }

  // 3) Services + stated prices from the site text.
  let drafts: CatalogDraft[] = [];
  if (crawl && crawl.pages.length > 0) {
    if (!deps.draftCatalog) {
      sources.catalogParser = { used: false, services: 0, error: "AI not configured" };
    } else {
      try {
        const result = await deps.draftCatalog(combinePageTexts(crawl.pages));
        drafts = result.drafts;
        sources.catalogParser = { used: true, services: drafts.length };
        if (result.usage) {
          await recordAiUsageSafe({
            organizationId: intake.organization_id,
            companyId: intake.company_id,
            model: result.usage.model,
            responseId: result.usage.responseId,
            usage: result.usage.usage,
          });
        }
      } catch (err) {
        sources.catalogParser = { used: false, services: 0, error: errorMessage(err).slice(0, 300) };
      }
    }
  }

  // 4) Company facts.
  const companyPlan = planCompanyUpdate(company, { answers, place, crawl });
  if (Object.keys(companyPlan.patch).length > 0) {
    const { error } = await admin
      .from("companies")
      .update(companyPlan.patch)
      .eq("organization_id", intake.organization_id)
      .eq("id", intake.company_id);
    if (error) throw new Error(`company update failed: ${error.message}`);
  }

  // 5) Prices: owner > site > none.
  const { data: catalogData, error: catalogError } = await admin
    .from("service_catalog_items")
    .select("id, label, pricing_type, unit_label, rate_cents, minimum_cents, active, sort_order, service_key")
    .eq("organization_id", intake.organization_id)
    .eq("company_id", intake.company_id);
  if (catalogError) throw new Error(`catalog lookup failed: ${catalogError.message}`);
  const catalog = (catalogData ?? []) as CatalogRow[];
  const servicePlan = planServicePrices(catalog, answers, drafts);
  const { priced, added } = await applyServicePlan(admin, intake, catalog, servicePlan);

  const summary: EnrichmentSummary = {
    version: 1,
    ranAt: new Date(deps.now()).toISOString(),
    sources,
    company: { applied: companyPlan.applied, kept: companyPlan.kept },
    services: {
      priced,
      added,
      unpricedOnSite: servicePlan.unpricedOnSite,
      notApplied: servicePlan.notApplied,
      skippedByOwner: answers?.prices.skipped ?? false,
    },
    facts: {
      place: place
        ? { name: place.name, address: place.address, phone: place.phoneNational, mapsUrl: place.mapsUrl, primaryType: place.primaryType }
        : null,
      site: crawl ? { phones: crawl.phones.slice(0, 5), logoUrl: crawl.logoUrl, description: crawl.description } : null,
    },
  };
  const { error: writeError } = await admin
    .from("setup_intakes")
    .update({ enrichment: summary as unknown as Json })
    .eq("id", intake.id);
  if (writeError) throw new Error(`enrichment record write failed: ${writeError.message}`);
  return summary;
}

// ── Sweep ────────────────────────────────────────────────────────────────────

let sweepInFlight = false;

/** Claim one intake for enrichment: status/attempts must still be what we read. */
async function claimForEnrichment(admin: AdminClient, intake: SetupIntake, nowMs: number): Promise<SetupIntake | null> {
  const { data, error } = await admin
    .from("setup_intakes")
    .update({ status: "enriching", enrich_attempts: intake.enrich_attempts + 1, updated_at: new Date(nowMs).toISOString() })
    .eq("id", intake.id)
    .eq("status", intake.status)
    .eq("enrich_attempts", intake.enrich_attempts)
    .select("*");
  if (error) throw new Error(`enrichment claim failed: ${error.message}`);
  return ((data ?? []) as SetupIntake[])[0] ?? null;
}

export function isEnrichmentDue(intake: Pick<SetupIntake, "status" | "enrich_attempts" | "updated_at">, nowMs: number): boolean {
  const age = nowMs - Date.parse(intake.updated_at);
  if (intake.status === "submitted") return true;
  if (intake.enrich_attempts >= MAX_ENRICH_ATTEMPTS) return false;
  if (intake.status === "enriching") return age >= ENRICH_STALE_MS;
  if (intake.status === "failed") return age >= ENRICH_RETRY_AFTER_MS;
  return false;
}

/**
 * Scheduler sweep: enrich submitted intakes (and retry failed / crashed ones a few times).
 * Each intake is claimed with a conditional update first, so concurrent workers never run the
 * same one twice; a buyer re-submitting mid-run sends it round again. One pass at a time per
 * process; never throws.
 */
export async function processPendingEnrichments(
  admin: AdminClient,
  options: { nowMs?: number; limit?: number } = {},
  depsOverride: Partial<EnrichDeps> = {},
): Promise<{ claimed: number; enriched: number; failed: number; skipped?: "in_flight" }> {
  if (sweepInFlight) return { claimed: 0, enriched: 0, failed: 0, skipped: "in_flight" };
  sweepInFlight = true;
  const result = { claimed: 0, enriched: 0, failed: 0 };
  try {
    const nowMs = options.nowMs ?? Date.now();
    const { data, error } = await admin
      .from("setup_intakes")
      .select("*")
      .in("status", ["submitted", "enriching", "failed"])
      .order("submitted_at", { ascending: true })
      .limit(50);
    if (error) throw new Error(error.message);
    const due = ((data ?? []) as SetupIntake[]).filter((i) => isEnrichmentDue(i, nowMs)).slice(0, options.limit ?? 3);
    for (const intake of due) {
      const claimed = await claimForEnrichment(admin, intake, nowMs).catch((err) => {
        console.error(`[dfy/enrich] claim failed for intake ${intake.id}: ${errorMessage(err)}`);
        return null;
      });
      if (!claimed) continue;
      result.claimed += 1;
      const finish = (patch: Partial<SetupIntake>) =>
        admin
          .from("setup_intakes")
          .update({ ...patch, updated_at: new Date().toISOString() })
          .eq("id", claimed.id)
          .eq("status", "enriching")
          .eq("enrich_attempts", claimed.enrich_attempts);
      try {
        await enrichCompany(admin, claimed.company_id, depsOverride);
        const { error: doneError } = await finish({ status: "enriched", enriched_at: new Date().toISOString(), last_error: null });
        if (doneError) throw new Error(`status write failed: ${doneError.message}`);
        result.enriched += 1;
        console.log(`[dfy/enrich] enriched company ${claimed.company_id}`);
      } catch (err) {
        result.failed += 1;
        const message = errorMessage(err).slice(0, 1000);
        console.error(`[dfy/enrich] FAILED for company ${claimed.company_id} (try ${claimed.enrich_attempts}): ${message}`);
        await finish({ status: "failed", last_error: message });
      }
    }
  } catch (err) {
    console.error(`[dfy/enrich] sweep failed: ${errorMessage(err)}`);
  } finally {
    sweepInFlight = false;
  }
  return result;
}
