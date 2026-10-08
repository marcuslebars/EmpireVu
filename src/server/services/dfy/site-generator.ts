// ─────────────────────────────────────────────────────────────────────────────
// SANCTIONED EXCEPTION (service role): generated company sites.
// company_sites is server-written only (migration 20261008100000_done_for_you). Every function
// here takes the service-role client and an explicit companyId; owner routes verify org
// membership + role and that the company belongs to the org BEFORE calling in, and the sweep
// derives company ids from DB state (setup_intakes / CrankLeads orgs), never from a request.
// Each write is filtered by company_id (and organization_id where we have it).
// docs/done-for-you.md → "Generated sites".
// ─────────────────────────────────────────────────────────────────────────────
import type { Json, Tables } from "@/server/db/database.types";
import { writeSiteCopy as defaultWriteSiteCopy, type SiteCopyResult } from "@/server/ai/site-copy";
import { isAIConfigured } from "@/server/ai/claude";
import { LIVE_WINDOW, localClock } from "@/server/services/crankleads/followup-schedule";
import type { AdminClient } from "@/server/services/crankleads/purchases";
import { generatePublicFormKey } from "@/server/services/lead-intake/public-form-keys";
import { getPack } from "@/server/services/packs";
import { parseAppliedIndustryPack } from "@/server/services/packs/types";
import { appBaseUrlFor, brandForOrg } from "@/server/services/platform-brand";
import { parseOnlineBookingSettings } from "@/server/services/scheduling/rules";
import type { TenantServiceContext } from "@/server/services/shared";
import { recordAiUsageSafe } from "@/server/services/usage";
import {
  deliverMessage as defaultDeliverMessage,
  type DeliverMessageInput,
  type DeliverMessageResult,
} from "@/server/services/workflow-engine/messaging";

import {
  buildSiteFacts,
  chooseSiteMode,
  copywriterFacts,
  factsUsed,
  parseSiteContent,
  screenSiteCopy,
  siteSlugBase,
  slugCandidates,
  SITE_CONTENT_VERSION,
  templateSiteCopy,
  type CatalogItemFacts,
  type SiteContent,
  type SiteEdits,
  type SiteMode,
  type SiteSettings,
  type SiteStatus,
} from "./site-content";
import { siteUrl } from "./site-url";
import { loadOwnerTextBlock, newFlowCompanyIds } from "./eligibility";

export type CompanySiteRow = Tables<"company_sites">;

export interface SiteGeneratorDeps {
  /** The copywriter. Null → template copy only. Defaults to Claude when ANTHROPIC_API_KEY is set. */
  writeCopy: ((facts: Record<string, unknown>) => Promise<SiteCopyResult>) | null;
  deliver: (input: DeliverMessageInput) => Promise<DeliverMessageResult>;
  now: () => Date;
}

function defaultDeps(): SiteGeneratorDeps {
  return {
    writeCopy: isAIConfigured() ? defaultWriteSiteCopy : null,
    deliver: defaultDeliverMessage,
    now: () => new Date(),
  };
}

function withDeps(partial?: Partial<SiteGeneratorDeps>): SiteGeneratorDeps {
  return { ...defaultDeps(), ...(partial ?? {}) };
}

export class SiteNotFoundError extends Error {
  constructor(message = "Company not found.") {
    super(message);
    this.name = "SiteNotFoundError";
  }
}

// ── Loading facts ────────────────────────────────────────────────────────────

type CompanyRow = Tables<"companies">;

async function loadCompany(admin: AdminClient, companyId: string): Promise<CompanyRow> {
  const { data, error } = await admin.from("companies").select("*").eq("id", companyId).maybeSingle();
  if (error) throw new Error(`company read failed: ${error.message}`);
  if (!data) throw new SiteNotFoundError();
  return data as CompanyRow;
}

async function loadOrgBrand(admin: AdminClient, organizationId: string): Promise<"crankleads" | "empirevu"> {
  const { data, error } = await admin
    .from("organizations")
    .select("platform_brand, crankleads_tier")
    .eq("id", organizationId)
    .maybeSingle();
  if (error) throw new Error(`organization read failed: ${error.message}`);
  return brandForOrg(data as { platform_brand: string | null; crankleads_tier: string | null } | null).key === "crankleads" ? "crankleads" : "empirevu";
}

async function loadCatalog(admin: AdminClient, company: CompanyRow): Promise<CatalogItemFacts[]> {
  const { data, error } = await admin
    .from("service_catalog_items")
    .select("service_key, label, description, pricing_type, rate_cents, minimum_cents, unit_label, sort_order")
    .eq("organization_id", company.organization_id)
    .eq("company_id", company.id)
    .eq("active", true)
    .order("sort_order", { ascending: true });
  if (error) throw new Error(`catalog read failed: ${error.message}`);
  return (data ?? []) as CatalogItemFacts[];
}

export async function loadSiteRow(admin: AdminClient, companyId: string): Promise<CompanySiteRow | null> {
  const { data, error } = await admin.from("company_sites").select("*").eq("company_id", companyId).maybeSingle();
  if (error) throw new Error(`site read failed: ${error.message}`);
  return (data as CompanySiteRow | null) ?? null;
}

/** The company's active quote/contact form key; creates one (service role) when there is none. */
export async function ensureSiteFormKey(admin: AdminClient, company: Pick<CompanyRow, "id" | "organization_id">): Promise<string> {
  const { data, error } = await admin
    .from("public_form_keys")
    .select("public_key, form_type, active")
    .eq("organization_id", company.organization_id)
    .eq("company_id", company.id)
    .eq("active", true)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`form key read failed: ${error.message}`);
  const rows = (data ?? []) as Array<{ public_key: string; form_type: string }>;
  const existing = rows.find((r) => r.form_type === "quote") ?? rows[0];
  if (existing) return existing.public_key;
  const publicKey = generatePublicFormKey();
  const { error: insertError } = await admin.from("public_form_keys").insert({
    organization_id: company.organization_id,
    company_id: company.id,
    public_key: publicKey,
    label: "Website page",
    form_type: "quote",
  });
  if (insertError) throw new Error(`form key create failed: ${insertError.message}`);
  return publicKey;
}

function tradeOf(company: CompanyRow): { id: string; name: string } | null {
  const applied = parseAppliedIndustryPack(company.industry_pack);
  const pack = applied ? getPack(applied.id) : null;
  return pack ? { id: pack.id, name: pack.name } : null;
}

// ── Slug ─────────────────────────────────────────────────────────────────────

async function takenSlugs(admin: AdminClient, candidates: string[]): Promise<Set<string>> {
  const { data, error } = await admin.from("company_sites").select("slug").in("slug", candidates);
  if (error) throw new Error(`slug read failed: ${error.message}`);
  return new Set(((data ?? []) as Array<{ slug: string }>).map((r) => r.slug));
}

/** First free slug for this name: acme-snow, acme-snow-2, … */
export async function uniqueSiteSlug(admin: AdminClient, name: string, skip: Set<string> = new Set()): Promise<string> {
  const base = siteSlugBase(name);
  const candidates = slugCandidates(base, 40);
  const taken = await takenSlugs(admin, candidates);
  const free = candidates.find((c) => !taken.has(c) && !skip.has(c));
  if (free) return free;
  return `${base.slice(0, 40)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── Generate ─────────────────────────────────────────────────────────────────

export interface GenerateSiteOptions {
  /** Publish now (done-for-you auto-publish, or the owner's "Regenerate and publish"). */
  publish?: boolean;
  /** Override the mode (otherwise: keep the existing site's mode, else chosen from companies.website). */
  mode?: SiteMode;
  deps?: Partial<SiteGeneratorDeps>;
}

export interface GeneratedSite {
  site: CompanySiteRow;
  content: SiteContent;
  url: string;
  created: boolean;
}

/**
 * Build (or rebuild) a company's site from the facts we hold, write company_sites, and return
 * it. Copy comes from Claude when configured and passes validation + fact screening; otherwise
 * (or on any model error) from the deterministic template — generation never blocks on AI.
 * A rebuild keeps the slug, the owner's edits and settings, the mode, and the status (unless
 * `publish`).
 */
export async function generateSite(admin: AdminClient, companyId: string, options: GenerateSiteOptions = {}): Promise<GeneratedSite> {
  const deps = withDeps(options.deps);
  const company = await loadCompany(admin, companyId);
  const [brand, catalog, existing] = await Promise.all([
    loadOrgBrand(admin, company.organization_id),
    loadCatalog(admin, company),
    loadSiteRow(admin, companyId),
  ]);
  await ensureSiteFormKey(admin, company);

  const previous = existing ? parseSiteContent(existing.content) : null;
  const mode: SiteMode = options.mode ?? (existing?.mode === "price_page" || existing?.mode === "full" ? (existing.mode as SiteMode) : chooseSiteMode(company.website));
  const facts = buildSiteFacts({
    company,
    catalog,
    trade: tradeOf(company),
    bookingEnabled: parseOnlineBookingSettings(company.online_booking_settings).enabled,
    brand,
  });

  let copy = templateSiteCopy(facts, mode);
  let copySource: SiteContent["copySource"] = "template";
  let copyNotes: string[] = [];
  if (deps.writeCopy) {
    try {
      const result = await deps.writeCopy(copywriterFacts(facts, mode));
      const screened = screenSiteCopy(result.copy, facts, mode);
      copy = screened.copy;
      copySource = screened.source;
      copyNotes = screened.notes;
      await recordAiUsageSafe({ organizationId: company.organization_id, companyId, ...result.usage });
    } catch (err) {
      copyNotes = [`model copy unavailable: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`];
      console.warn(`[sites] copy fell back to template for company ${companyId}: ${copyNotes[0]}`);
    }
  } else {
    copyNotes = ["AI not configured"];
  }

  const now = deps.now().toISOString();
  const content: SiteContent = {
    version: SITE_CONTENT_VERSION,
    mode,
    facts,
    factsUsed: factsUsed(facts),
    copy,
    copySource,
    copyNotes,
    edits: previous?.edits ?? {},
    settings: previous?.settings ?? { showPrices: true },
    generatedAt: now,
  };

  if (existing) {
    const status: SiteStatus = options.publish ? "published" : (existing.status as SiteStatus);
    const patch = {
      content: content as unknown as Json,
      mode,
      generated_at: now,
      updated_at: now,
      ...(options.publish ? { status, published_at: existing.status === "published" && existing.published_at ? existing.published_at : now } : {}),
    };
    const { data, error } = await admin.from("company_sites").update(patch).eq("id", existing.id).eq("company_id", companyId).select("*").single();
    if (error) throw new Error(`site update failed: ${error.message}`);
    return { site: data as CompanySiteRow, content, url: siteUrl(existing.slug, brand), created: false };
  }

  const tried = new Set<string>();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const slug = await uniqueSiteSlug(admin, company.name, tried);
    tried.add(slug);
    const { data, error } = await admin
      .from("company_sites")
      .insert({
        organization_id: company.organization_id,
        company_id: companyId,
        slug,
        mode,
        status: options.publish ? "published" : "draft",
        content: content as unknown as Json,
        generated_at: now,
        published_at: options.publish ? now : null,
      })
      .select("*")
      .single();
    if (!error) return { site: data as CompanySiteRow, content, url: siteUrl(slug, brand), created: true };
    if ((error as { code?: string }).code !== "23505") throw new Error(`site insert failed: ${error.message}`);
    // Unique violation: either the slug was taken in the meantime (retry) or another worker
    // already created this company's site (return it).
    const raced = await loadSiteRow(admin, companyId);
    if (raced) return { site: raced, content: parseSiteContent(raced.content) ?? content, url: siteUrl(raced.slug, brand), created: false };
  }
  throw new Error("Couldn't find a free web address for this site.");
}

// ── Owner actions ────────────────────────────────────────────────────────────

export async function setSiteStatus(
  admin: AdminClient,
  companyId: string,
  status: "published" | "unpublished",
  options: { markOwnerNotified?: boolean; now?: Date } = {},
): Promise<CompanySiteRow> {
  const existing = await loadSiteRow(admin, companyId);
  if (!existing) throw new SiteNotFoundError("This company doesn't have a page yet.");
  const now = (options.now ?? new Date()).toISOString();
  const patch: Partial<CompanySiteRow> = { status, updated_at: now };
  if (status === "published") {
    patch.published_at = now;
    if (options.markOwnerNotified && !existing.owner_notified_at) patch.owner_notified_at = now;
  }
  const { data, error } = await admin.from("company_sites").update(patch).eq("id", existing.id).eq("company_id", companyId).select("*").single();
  if (error) throw new Error(`site status update failed: ${error.message}`);
  return data as CompanySiteRow;
}

export interface SiteEditInput extends SiteEdits {
  showPrices?: boolean;
  mode?: SiteMode;
}

/** Owner edits: headline/subhead/about overrides (empty string clears), show prices, mode. */
export async function updateSiteEdits(admin: AdminClient, companyId: string, input: SiteEditInput, now: Date = new Date()): Promise<CompanySiteRow> {
  const existing = await loadSiteRow(admin, companyId);
  if (!existing) throw new SiteNotFoundError("This company doesn't have a page yet.");
  const content = parseSiteContent(existing.content);
  if (!content) throw new Error("This page needs to be regenerated before it can be edited.");
  const edits: SiteEdits = { ...content.edits };
  for (const key of ["headline", "subhead", "about"] as const) {
    if (input[key] !== undefined) {
      const v = (input[key] ?? "").trim();
      edits[key] = v ? v : null;
    }
  }
  const settings: SiteSettings = { ...content.settings, ...(input.showPrices !== undefined ? { showPrices: input.showPrices } : {}) };
  const mode = input.mode ?? content.mode;
  const next: SiteContent = { ...content, edits, settings, mode };
  const { data, error } = await admin
    .from("company_sites")
    .update({ content: next as unknown as Json, mode, updated_at: now.toISOString() })
    .eq("id", existing.id)
    .eq("company_id", companyId)
    .select("*")
    .single();
  if (error) throw new Error(`site edit failed: ${error.message}`);
  return data as CompanySiteRow;
}

// ── Sweep: done-for-you auto-publish + owner text ────────────────────────────

/** How often the scheduler runs the pass (it ticks every minute). */
export const SITE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
/** Sites generated per pass (bounds model spend and pass time). */
export const SITE_SWEEP_BATCH = 10;

const FALLBACK_TIMEZONE = "America/Toronto";

export interface SweepResult {
  generated: Array<{ companyId: string; slug: string }>;
  failed: Array<{ companyId: string; error: string }>;
  notified: Array<{ companyId: string; channel: string; status: string }>;
}

/** Of these org ids, the active CrankLeads ones (bounded batch lookup). */
async function activeCrankleadsOrgs(admin: AdminClient, orgIds: string[]): Promise<Set<string>> {
  const unique = [...new Set(orgIds)];
  if (unique.length === 0) return new Set();
  const { data, error } = await admin.from("organizations").select("id, subscription_status, platform_brand").in("id", unique);
  if (error) throw new Error(`org read failed: ${error.message}`);
  return new Set(
    ((data ?? []) as Array<{ id: string; subscription_status: string | null; platform_brand: string | null }>)
      .filter((o) => o.platform_brand === "crankleads" && o.subscription_status !== "canceled")
      .map((o) => o.id),
  );
}

async function companiesWithSite(admin: AdminClient, companyIds: string[]): Promise<Set<string>> {
  if (companyIds.length === 0) return new Set();
  const { data, error } = await admin.from("company_sites").select("company_id").in("company_id", companyIds);
  if (error) throw new Error(`site list failed: ${error.message}`);
  return new Set(((data ?? []) as Array<{ company_id: string }>).map((s) => s.company_id));
}

/** Only recent done-for-you buyers are swept (older ones are the operator's). */
export const SITE_SWEEP_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const SWEEP_PAGE = 100;
const SWEEP_MAX_PAGES = 10;

/**
 * Kept for the console / tests: "enough data" for a page. The sweep no longer builds pages for
 * legacy companies (bought before done-for-you) — an operator can build them a draft.
 */
export function hasEnoughSiteData(company: Pick<CompanyRow, "name" | "owner_phone_e164" | "service_area" | "hours">, activeServices: number): boolean {
  if (!company.name?.trim() || !company.owner_phone_e164?.trim()) return false;
  const hours = company.hours && typeof company.hours === "object" && Object.keys(company.hours as object).length > 0;
  return Boolean(company.service_area?.trim()) || Boolean(hours) || activeServices >= 3;
}

/**
 * Company ids that should get a site this pass (no company_sites row yet). Done-for-you buyers
 * ONLY (they have a setup_intakes row): an intake enriched in the last 30 days, or a company the
 * orchestrator switched on (the backstop for its inline build, incl. the 2 h fallback).
 * Legacy CrankLeads companies are never auto-built or published (docs: "Who done-for-you
 * applies to"). Paged queries over candidates only — never a list of every org/company.
 */
export async function pendingSiteCompanyIds(admin: AdminClient, limit = SITE_SWEEP_BATCH, nowMs: number = Date.now()): Promise<string[]> {
  const since = new Date(nowMs - SITE_SWEEP_LOOKBACK_MS).toISOString();
  const out: string[] = [];
  const consider = async (rows: Array<{ company_id: string; organization_id: string }>, requireIntake: boolean) => {
    if (rows.length === 0) return;
    const [orgs, sites, intakes] = await Promise.all([
      activeCrankleadsOrgs(admin, rows.map((r) => r.organization_id)),
      companiesWithSite(admin, rows.map((r) => r.company_id)),
      requireIntake ? newFlowCompanyIds(admin, rows.map((r) => r.company_id)) : Promise.resolve(null),
    ]);
    for (const row of rows) {
      if (out.length >= limit) return;
      if (!orgs.has(row.organization_id) || sites.has(row.company_id) || out.includes(row.company_id)) continue;
      if (intakes && !intakes.has(row.company_id)) continue;
      out.push(row.company_id);
    }
  };

  // 1) Quick setup finished enriching → build it.
  for (let page = 0; page < SWEEP_MAX_PAGES && out.length < limit; page++) {
    const { data, error } = await admin
      .from("setup_intakes")
      .select("company_id, organization_id")
      .eq("status", "enriched")
      .gte("enriched_at", since)
      .order("enriched_at", { ascending: true })
      .range(page * SWEEP_PAGE, page * SWEEP_PAGE + SWEEP_PAGE - 1);
    if (error) throw new Error(`intake list failed: ${error.message}`);
    const rows = (data ?? []) as Array<{ company_id: string; organization_id: string }>;
    await consider(rows, false);
    if (rows.length < SWEEP_PAGE) break;
  }

  // 1b) Switched on by the done-for-you orchestrator but still no page (its inline build failed).
  for (let page = 0; page < SWEEP_MAX_PAGES && out.length < limit; page++) {
    const { data, error } = await admin
      .from("dfy_progress")
      .select("company_id, organization_id")
      .gte("switched_on_at", since)
      .order("switched_on_at", { ascending: true })
      .range(page * SWEEP_PAGE, page * SWEEP_PAGE + SWEEP_PAGE - 1);
    if (error) throw new Error(`progress list failed: ${error.message}`);
    const rows = (data ?? []) as Array<{ company_id: string; organization_id: string }>;
    await consider(rows, true);
    if (rows.length < SWEEP_PAGE) break;
  }
  return out;
}

/** Generate + publish every pending CrankLeads site (done-for-you). Idempotent: a company with a row is skipped. */
export async function generatePendingSites(
  admin: AdminClient,
  options: { limit?: number; deps?: Partial<SiteGeneratorDeps>; nowMs?: number } = {},
): Promise<SweepResult> {
  const result: SweepResult = { generated: [], failed: [], notified: [] };
  const ids = await pendingSiteCompanyIds(admin, options.limit ?? SITE_SWEEP_BATCH, options.nowMs ?? Date.now());
  for (const companyId of ids) {
    try {
      const generated = await generateSite(admin, companyId, { publish: true, deps: options.deps });
      if (generated.created) result.generated.push({ companyId, slug: generated.site.slug });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[sites] generate failed for company ${companyId}: ${message}`);
      result.failed.push({ companyId, error: message });
    }
  }
  return result;
}

/**
 * While a done-for-you buyer is still being set up, the page is announced IN the "You're live"
 * message (setup-followups.ts stamps owner_notified_at when it sends it) — so the separate
 * "Your new page is live" text waits. After this long without going live it goes on its own.
 */
export const PAGE_TEXT_HOLD_MS = 3 * 24 * 60 * 60 * 1000;
/** Same as setup-followups LIVE_CONFIRMATION_MAX_AGE_MS: a claimed-but-unsent live message still goes this long after live_at. */
const LIVE_MESSAGE_PENDING_MS = 3 * 24 * 60 * 60 * 1000;

type HoldPurchase = {
  id: string;
  live_at: string | null;
  provisioned_at: string | null;
  setup_followups_exempt_at: string | null;
  setup_reminders_stopped_at: string | null;
};

/**
 * Should the standalone page text wait for (be folded into) the "You're live" message?
 * Yes while the buyer's done-for-you purchase isn't live yet (within PAGE_TEXT_HOLD_MS), or is
 * live but the live message hasn't gone out yet. Exempt / stopped purchases never get a live
 * message, so their page text goes as usual. Older buyers with no purchase: no hold.
 */
export async function pageTextHeldForLive(
  admin: AdminClient,
  site: Pick<CompanySiteRow, "organization_id" | "company_id">,
  nowMs: number,
): Promise<boolean> {
  const { data, error } = await admin
    .from("crankleads_purchases")
    .select("id, live_at, provisioned_at, setup_followups_exempt_at, setup_reminders_stopped_at")
    .eq("organization_id", site.organization_id)
    .eq("company_id", site.company_id)
    .eq("status", "provisioned")
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`purchase read failed: ${error.message}`);
  const purchase = ((data ?? []) as HoldPurchase[])[0];
  // Stopped / exempt purchases never get a page text at all (notifyPublishedSites skips them).
  if (!purchase || purchase.setup_followups_exempt_at || purchase.setup_reminders_stopped_at) return false;
  if (!purchase.live_at) {
    const since = Date.parse(purchase.provisioned_at ?? "");
    return Number.isFinite(since) && nowMs - since < PAGE_TEXT_HOLD_MS;
  }
  if (nowMs - Date.parse(purchase.live_at) >= LIVE_MESSAGE_PENDING_MS) return false;
  const { data: live, error: liveError } = await admin
    .from("crankleads_setup_followups")
    .select("stage")
    .eq("organization_id", site.organization_id)
    .eq("purchase_id", purchase.id)
    .eq("stage", "live")
    .limit(1);
  if (liveError) throw new Error(`follow-up read failed: ${liveError.message}`);
  return (live ?? []).length === 0;
}

export function sitePublishedSms(url: string, settingsUrl: string): string {
  return `Your new page is live: ${url}. Want changes? ${settingsUrl}`;
}

/**
 * Text the owner once per published CrankLeads site ("Your new page is live") — unless it is
 * folded into the done-for-you "You're live" message (pageTextHeldForLive). The send is
 * CLAIMED first (owner_notified_at set where null) so overlapping workers can't double-send;
 * outside 08:00–21:00 company time it waits for the next pass. A landline business number
 * (or no number) gets the email instead.
 */
export async function notifyPublishedSites(admin: AdminClient, options: { deps?: Partial<SiteGeneratorDeps> } = {}): Promise<SweepResult["notified"]> {
  const deps = withDeps(options.deps);
  // Candidates only (published, not yet announced), oldest first, bounded — no org-wide IN().
  const { data, error } = await admin
    .from("company_sites")
    .select("id, organization_id, company_id, slug, status, owner_notified_at")
    .eq("status", "published")
    .is("owner_notified_at", null)
    .order("published_at", { ascending: true })
    .limit(SWEEP_PAGE);
  if (error) throw new Error(`site notify list failed: ${error.message}`);
  const candidates = (data ?? []) as Array<Pick<CompanySiteRow, "id" | "organization_id" | "company_id" | "slug">>;
  if (candidates.length === 0) return [];
  const [orgs, newFlow] = await Promise.all([
    activeCrankleadsOrgs(admin, candidates.map((c) => c.organization_id)),
    newFlowCompanyIds(admin, candidates.map((c) => c.company_id)),
  ]);

  const out: SweepResult["notified"] = [];
  const nowMs = deps.now().getTime();
  for (const site of candidates) {
    if (!orgs.has(site.organization_id)) continue;
    // Legacy accounts (no quick-setup intake) and buyers who stopped setup texts never get the
    // page text. Mark it handled so it leaves the queue (nothing is sent).
    const blocked = !newFlow.has(site.company_id) ? "legacy" : await loadOwnerTextBlock(admin, site.organization_id, site.company_id).catch(() => "unknown");
    if (blocked) {
      if (blocked !== "unknown") {
        await admin.from("company_sites").update({ owner_notified_at: new Date(deps.now().getTime()).toISOString() }).eq("id", site.id).is("owner_notified_at", null);
        out.push({ companyId: site.company_id, channel: "none", status: `skipped:${blocked}` });
      }
      continue;
    }
    const { data: companyData } = await admin
      .from("companies")
      .select("id, organization_id, name, timezone, owner_phone_e164, owner_email, business_phone_kind")
      .eq("organization_id", site.organization_id)
      .eq("id", site.company_id)
      .maybeSingle();
    const company = companyData as Pick<CompanyRow, "id" | "organization_id" | "name" | "timezone" | "owner_phone_e164" | "owner_email" | "business_phone_kind"> | null;
    if (!company) continue;
    const clock = localClock(company.timezone?.trim() || FALLBACK_TIMEZONE, nowMs);
    if (clock.hour < LIVE_WINDOW.startHour || clock.hour >= LIVE_WINDOW.endHour) continue;
    try {
      if (await pageTextHeldForLive(admin, site, nowMs)) continue;
    } catch (err) {
      // Unsure → wait for the next pass rather than risk a second text next to "You're live".
      console.error(`[sites] hold check failed for ${site.id}: ${err instanceof Error ? err.message : err}`);
      continue;
    }

    const { data: claimed, error: claimError } = await admin
      .from("company_sites")
      .update({ owner_notified_at: new Date(nowMs).toISOString() })
      .eq("id", site.id)
      .is("owner_notified_at", null)
      .select("id");
    if (claimError) {
      console.error(`[sites] notify claim failed for ${site.id}: ${claimError.message}`);
      continue;
    }
    if (!claimed || (claimed as unknown[]).length === 0) continue;

    const url = siteUrl(site.slug, "crankleads");
    const settingsUrl = `${appBaseUrlFor("crankleads")}/settings?section=website`;
    const body = sitePublishedSms(url, settingsUrl);
    const ctx: TenantServiceContext = { organizationId: site.organization_id, actorProfileId: null, supabase: admin };
    const phone = company.owner_phone_e164?.trim() || null;
    const useSms = Boolean(phone) && company.business_phone_kind !== "landline";
    let status = "skipped:no_recipient";
    let channel = useSms ? "sms" : "email";
    try {
      const sent = useSms
        ? await deps.deliver({ context: ctx, channel: "sms", to: phone, body, companyId: company.id, contactId: null, consentContact: null, smsFrom: "platform" })
        : await deps.deliver({
            context: ctx,
            channel: "email",
            to: company.owner_email?.trim() || null,
            subject: "Your new page is live",
            body: `Hi,\n\nThe page we built for ${company.name} is live: ${url}\n\nWant changes? Open Settings, then "Your website": ${settingsUrl}\n`,
            companyId: company.id,
            contactId: null,
            consentContact: null,
          });
      status = sent.reason ? `${sent.status}:${sent.reason}` : sent.status;
    } catch (err) {
      status = "failed";
      channel = useSms ? "sms" : "email";
      console.error(`[sites] owner notify failed for ${site.id}: ${err instanceof Error ? err.message : err}`);
    }
    out.push({ companyId: company.id, channel, status });
  }
  return out;
}

let lastSiteSweepMs = 0;

/**
 * The scheduler's ONE entry point (workflow-engine/scheduler.ts): throttled to every 5 minutes
 * per worker process, self-guarded (never throws), idempotent across workers.
 */
export async function runGeneratedSitesPass(admin: AdminClient, nowMs: number = Date.now(), deps?: Partial<SiteGeneratorDeps>): Promise<SweepResult | null> {
  if (nowMs - lastSiteSweepMs < SITE_SWEEP_INTERVAL_MS) return null;
  lastSiteSweepMs = nowMs;
  try {
    const result = await generatePendingSites(admin, { deps, nowMs });
    result.notified = await notifyPublishedSites(admin, { deps });
    if (result.generated.length || result.failed.length || result.notified.length) {
      console.log(`[scheduler] sites: generated=${result.generated.length} failed=${result.failed.length} notified=${result.notified.length}`);
    }
    return result;
  } catch (err) {
    console.error("[scheduler] generated sites failed", err instanceof Error ? err.message : err);
    return null;
  }
}

/** Test hook: reset the per-process throttle. */
export function resetSiteSweepThrottle(): void {
  lastSiteSweepMs = 0;
}
