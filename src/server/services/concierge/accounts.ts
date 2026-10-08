// ─────────────────────────────────────────────────────────────────────────────
// SANCTIONED EXCEPTION (service role): concierge console — reads.
// Cross-tenant on purpose: the console is for platform operators only (OPERATOR_EMAILS,
// enforced by requireOperator before any of this runs — everyone else gets a 404). The list
// reads CrankLeads orgs (organizations.platform_brand = 'crankleads'); the detail reads ONE org
// named by the operator, and every per-account query is filtered by that org's id (+ the
// company that belongs to it, resolved here — never trusted from input without checking it
// belongs to the org). Listed in docs/done-for-you.md → "Concierge console".
// ─────────────────────────────────────────────────────────────────────────────
import { buildForwardingInstructions, prettyPhone } from "@/lib/carrier-forwarding";
import {
  carrierLabel,
  hoursToText,
  NEEDS_CALL_AFTER_HOURS,
  phoneKindLabel,
  slaLevel,
  type CallScript,
  type CallScriptItem,
  type ConciergeAccountDetail,
  type ConciergeAccountSummary,
  type ConciergeActivity,
  type ConciergeCompanyFacts,
  type ConciergeFollowup,
  type ConciergeService,
  type NumberStatus,
} from "@/lib/concierge";
import type { Tables } from "@/server/db/database.types";
import { isCrankleadsTier } from "@/server/services/crankleads/config";
import type { AdminClient } from "@/server/services/crankleads/purchases";
import { loadSetupChecklist, type SetupChecklist } from "@/server/services/crankleads/setup-checklist";
import { ConciergeNotFoundError } from "@/server/services/concierge/auth";
import { siteUrl } from "@/server/services/dfy/site-url";
import { needsPrice } from "@/server/services/packs/apply";
import type { TenantServiceContext } from "@/server/services/shared";

const HOUR = 3_600_000;
export const CONCIERGE_LIST_LIMIT = 150;
const CHECKLIST_CONCURRENCY = 6;

type OrgRow = Pick<Tables<"organizations">, "id" | "name" | "crankleads_tier" | "created_at" | "platform_brand">;
const ORG_FIELDS = "id, name, crankleads_tier, created_at, platform_brand";

type PurchaseRow = Pick<
  Tables<"crankleads_purchases">,
  | "id"
  | "organization_id"
  | "company_id"
  | "tier"
  | "owner_name"
  | "owner_email"
  | "owner_phone"
  | "business_name"
  | "paid_at"
  | "created_at"
  | "live_at"
  | "stripe_checkout_session_id"
  | "status"
>;
const PURCHASE_FIELDS =
  "id, organization_id, company_id, tier, owner_name, owner_email, owner_phone, business_name, paid_at, created_at, live_at, stripe_checkout_session_id, status";

type CompanyRow = Tables<"companies">;
type IntakeRow = Pick<Tables<"setup_intakes">, "company_id" | "status" | "enrichment" | "submitted_at" | "enriched_at" | "last_error">;
type VoiceRow = Pick<Tables<"voice_numbers">, "company_id" | "phone_e164" | "mode" | "provider" | "forwarding_verified_at" | "active">;
type SiteRow = Pick<Tables<"company_sites">, "company_id" | "slug" | "status" | "mode" | "published_at">;
type ProgressRow = Pick<
  Tables<"dfy_progress">,
  | "company_id"
  | "number_last_error"
  | "number_flagged_at"
  | "switched_on_at"
  | "forward_text_sent_at"
  | "forward_opened_at"
  | "forward_tapped_at"
  | "forward_tests_started"
  | "forward_last_test_at"
  | "forward_help_requested_at"
  | "escalated_at"
>;
const PROGRESS_FIELDS =
  "company_id, number_last_error, number_flagged_at, switched_on_at, forward_text_sent_at, forward_opened_at, forward_tapped_at, forward_tests_started, forward_last_test_at, forward_help_requested_at, escalated_at";

function fail(what: string, error: { message: string } | null): void {
  if (error) throw new Error(`concierge: ${what} failed: ${error.message}`);
}

function unique(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.filter((v): v is string => typeof v === "string" && v.length > 0)));
}

// ── Pure: summaries ───────────────────────────────────────────────────────────

/** Top-level enrichment keys that carry a value — "what did we find?" at a glance. */
export function enrichmentSummary(intake: Pick<IntakeRow, "enrichment" | "status" | "last_error"> | null): ConciergeAccountSummary["enrichment"] {
  if (!intake) return null;
  const raw = intake.enrichment;
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const fields = Object.entries(record)
    .filter(([, v]) => {
      if (v === null || v === undefined || v === "" || v === false) return false;
      if (Array.isArray(v)) return v.length > 0;
      if (typeof v === "object") return Object.keys(v as object).length > 0;
      return true;
    })
    .map(([k]) => k)
    .sort();
  if (fields.length === 0 && intake.status !== "failed" && !intake.last_error) return null;
  return { fields, error: intake.status === "failed" ? intake.last_error ?? "Enrichment failed." : null };
}

export interface SummarizeInput {
  org: OrgRow;
  purchase: PurchaseRow | null;
  company: Pick<CompanyRow, "id" | "name" | "owner_email" | "owner_phone_e164"> | null;
  intake: IntakeRow | null;
  numbers: VoiceRow[];
  site: SiteRow | null;
  /** The done-for-you number / forwarding state (dfy_progress), if the sweep has touched it. */
  progress: ProgressRow | null;
  checklist: SetupChecklist | null;
  nowMs: number;
}

/** Number state from dfy_progress (the purchase runs at checkout and retries with backoff). */
export function numberStatus(hasNumber: boolean, progress: Pick<ProgressRow, "number_flagged_at" | "number_last_error"> | null): NumberStatus {
  if (hasNumber) return "active";
  if (progress?.number_flagged_at) return "failed";
  if (progress?.number_last_error) return "retrying";
  return "pending";
}

export function summarizeAccount(input: SummarizeInput): ConciergeAccountSummary {
  const { org, purchase, company, intake, checklist } = input;
  const purchasedAt = purchase?.paid_at ?? purchase?.created_at ?? org.created_at;
  const hoursSincePurchase = Math.max(0, (input.nowMs - Date.parse(purchasedAt)) / HOUR);
  const tier = org.crankleads_tier ?? purchase?.tier ?? null;

  const active = input.numbers.filter((n) => n.active);
  const catcher = active.find((n) => n.provider === "twilio" && n.mode === "missed_call_catcher") ?? null;
  const ai = active.find((n) => n.mode === "ai_receptionist") ?? null;
  const path = checklist?.phonePath ?? (tier === "front_desk" && !catcher ? "ai_receptionist" : "missed_call_catcher");
  const needed = path === "ai_receptionist" ? ai : catcher;
  const progress = input.progress;
  const status = numberStatus(Boolean(needed), progress);

  const isLive = checklist ? checklist.isLive : Boolean(purchase?.live_at);
  const reasons: string[] = [];
  if (!isLive) {
    if (hoursSincePurchase >= NEEDS_CALL_AFTER_HOURS) reasons.push("Not live after 24 hours");
    if (intake?.status === "failed") reasons.push("Quick setup failed");
    if (status === "failed") reasons.push(path === "ai_receptionist" ? "AI number purchase failed" : "Text-back number purchase failed");
    if (progress?.forward_help_requested_at) reasons.push("Asked us to set up forwarding");
  }
  const needsCall = reasons.length > 0;

  return {
    organizationId: org.id,
    companyId: company?.id ?? null,
    businessName: company?.name ?? purchase?.business_name ?? org.name,
    tier,
    purchasedAt,
    hoursSincePurchase: Math.round(hoursSincePurchase * 10) / 10,
    sla: slaLevel(hoursSincePurchase),
    owner: {
      name: purchase?.owner_name ?? null,
      email: purchase?.owner_email ?? company?.owner_email ?? null,
      // The company's owner phone is what the console edits; the checkout phone is the fallback.
      phone: company?.owner_phone_e164 ?? purchase?.owner_phone ?? null,
    },
    intake: {
      status: intake?.status ?? null,
      submittedAt: intake?.submitted_at ?? null,
      enrichedAt: intake?.enriched_at ?? null,
      lastError: intake?.last_error ?? null,
    },
    enrichment: enrichmentSummary(intake),
    phone: {
      path,
      textBackNumber: catcher?.phone_e164 ?? null,
      aiNumber: ai?.phone_e164 ?? null,
      status,
      lastError: status === "active" ? null : progress?.number_last_error ?? null,
      forwardingVerifiedAt: needed?.forwarding_verified_at ?? null,
    },
    setup: progress
      ? {
          switchedOnAt: progress.switched_on_at,
          forwardTextSentAt: progress.forward_text_sent_at,
          forwardOpenedAt: progress.forward_opened_at,
          forwardTappedAt: progress.forward_tapped_at,
          forwardTestsStarted: progress.forward_tests_started ?? 0,
          forwardLastTestAt: progress.forward_last_test_at,
          forwardHelpRequestedAt: progress.forward_help_requested_at,
          escalatedAt: progress.escalated_at,
        }
      : null,
    site: input.site
      ? {
          slug: input.site.slug,
          url: siteUrl(input.site.slug, org.platform_brand === "crankleads" ? "crankleads" : "empirevu"),
          status: input.site.status,
          mode: input.site.mode,
          publishedAt: input.site.published_at,
        }
      : null,
    checklist: checklist
      ? {
          doneCount: checklist.doneCount,
          totalCount: checklist.totalCount,
          steps: checklist.steps.map((s) => ({ key: s.key, title: s.title, done: s.done })),
          extras: checklist.extras.map((s) => ({ key: s.key, title: s.title, done: s.done })),
          nextStepTitle: checklist.nextStep?.title ?? null,
        }
      : null,
    isLive,
    needsCall,
    needsCallReasons: reasons,
    stage: isLive ? "live" : needsCall ? "needs_call" : "setting_up",
  };
}

// ── Pure: the call script ─────────────────────────────────────────────────────

export interface CallScriptInput {
  account: ConciergeAccountSummary;
  phoneKind: string | null;
  phoneCarrier: string | null;
  servicesNeedingPrices: number;
  pricedServices: number;
}

function forwardingItem(input: CallScriptInput): CallScriptItem {
  const ai = input.account.phone.path === "ai_receptionist";
  const target = ai ? input.account.phone.aiNumber : input.account.phone.textBackNumber;
  const what = ai ? "the AI number" : "the text-back number";
  if (!target) {
    return { key: "forwarding", text: `Forwarding not on yet — get ${what} first ("Retry text-back number"), then have them forward to it` };
  }
  const fwd = buildForwardingInstructions(target);
  const carrier = carrierLabel(input.phoneCarrier);
  const kind = phoneKindLabel(input.phoneKind);
  const setup = input.account.setup;
  const tapped = setup?.forwardTappedAt ? " (they tapped the link but our test didn't see it forward)" : "";
  if (input.phoneKind === "landline" || input.phoneKind === "voip") {
    return {
      key: "forwarding",
      text: `Forwarding not on yet${tapped} — ${carrier ? `${carrier} ` : ""}${kind}: they call their phone provider (or use its portal) and ask for "call forward no answer + busy" to`,
      code: fwd.pretty,
    };
  }
  if (input.phoneKind === "cell") {
    return { key: "forwarding", text: `Forwarding not on yet${tapped} — ${carrier ? `${carrier} ` : ""}cell: have them dial`, code: fwd.recommended.activate };
  }
  return {
    key: "forwarding",
    text: `Forwarding not on yet${tapped} — ask if the business line is a cell, landline or VoIP${carrier ? ` (${carrier})` : ""}. Cell: have them dial`,
    code: fwd.recommended.activate,
  };
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** The optional extras, as one short "nice to have" line (never blocks live). */
function niceToHaveLine(input: CallScriptInput): string | null {
  const { account } = input;
  const bits: string[] = [];
  const intakeStatus = account.intake.status;
  if (intakeStatus === "failed") bits.push("their website or Google listing (quick setup failed)");
  else if (intakeStatus && ["pending", "sent", "opened"].includes(intakeStatus)) bits.push("their website or Google listing (quick setup not filled in)");
  for (const extra of account.checklist?.extras ?? []) {
    if (extra.done) continue;
    if (extra.key === "services") {
      bits.push(input.servicesNeedingPrices > 0 ? `prices for ${plural(input.servicesNeedingPrices, "service")}` : "their prices");
    } else if (extra.key === "payments") {
      bits.push("connect payments (they do it in Settings → Payments)");
    } else if (extra.key === "website") {
      bits.push("the lead form on their own site");
    }
  }
  return bits.length ? `Nice to have: ${bits.join("; ")}.` : null;
}

/**
 * "Who do I call and what do I tell them": ONLY the required steps still missing for live (the
 * setup checklist's definition), in plain words, plus one short "nice to have" line.
 */
export function buildCallScript(input: CallScriptInput): CallScript {
  const { account } = input;
  const missing: CallScriptItem[] = [];
  if (!account.isLive) {
    for (const step of account.checklist?.steps ?? []) {
      if (step.done) continue;
      switch (step.key) {
        case "phone":
          missing.push({
            key: "phone",
            text: `No ${account.phone.path === "ai_receptionist" ? "AI receptionist" : "text-back"} number yet${
              account.phone.status === "failed"
                ? ` (purchase failed${account.phone.lastError ? `: ${account.phone.lastError}` : ""})`
                : account.phone.status === "retrying"
                  ? " (retrying)"
                  : ""
            } — tap "Retry text-back number"`,
          });
          break;
        case "forwarding":
          missing.push(forwardingItem(input));
          break;
        case "automations":
          missing.push({ key: "automations", text: 'Missed-call text-back is off — tap "Run switch-on now"' });
          break;
        default:
          missing.push({ key: step.key, text: step.title });
      }
    }
  }

  const ownerName = account.owner.name?.trim() || null;
  return {
    ownerName,
    ownerFirstName: ownerName ? ownerName.split(/\s+/)[0] : null,
    ownerPhone: account.owner.phone,
    missing,
    niceToHave: account.isLive ? null : niceToHaveLine(input),
  };
}

// ── Loaders ───────────────────────────────────────────────────────────────────

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

function tenantCtx(admin: AdminClient, organizationId: string): TenantServiceContext {
  return { organizationId, actorProfileId: null, supabase: admin };
}

async function loadChecklistSafe(
  admin: AdminClient,
  org: OrgRow,
  companyId: string | null,
  purchaseTier: string | null,
): Promise<SetupChecklist | null> {
  if (!companyId) return null;
  const rawTier = org.crankleads_tier ?? purchaseTier;
  try {
    return await loadSetupChecklist(tenantCtx(admin, org.id), {
      companyId,
      tier: isCrankleadsTier(rawTier) ? rawTier : null,
    });
  } catch (err) {
    console.error(`[concierge] checklist for org ${org.id} failed:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/** Newest purchase per org. */
function latestByOrg(purchases: PurchaseRow[]): Map<string, PurchaseRow> {
  const map = new Map<string, PurchaseRow>();
  for (const p of [...purchases].sort((a, b) => b.created_at.localeCompare(a.created_at))) {
    if (p.organization_id && !map.has(p.organization_id)) map.set(p.organization_id, p);
  }
  return map;
}

/** The org's CrankLeads company: the purchase's company, else its newest company (same as the setup checklist). */
function pickCompany(orgId: string, purchase: PurchaseRow | null, companies: CompanyRow[]): CompanyRow | null {
  const own = companies.filter((c) => c.organization_id === orgId);
  if (purchase?.company_id) {
    const match = own.find((c) => c.id === purchase.company_id);
    if (match) return match;
  }
  return [...own].sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null;
}

export interface ListOptions {
  nowMs?: number;
  limit?: number;
}

/** CrankLeads orgs, newest first, each with its setup state. */
export async function listConciergeAccounts(admin: AdminClient, options: ListOptions = {}): Promise<ConciergeAccountSummary[]> {
  const nowMs = options.nowMs ?? Date.now();
  const { data: orgData, error: orgError } = await admin
    .from("organizations")
    .select(ORG_FIELDS)
    .eq("platform_brand", "crankleads")
    .order("created_at", { ascending: false })
    .limit(options.limit ?? CONCIERGE_LIST_LIMIT);
  fail("organizations lookup", orgError);
  const orgs = (orgData ?? []) as OrgRow[];
  if (orgs.length === 0) return [];
  const orgIds = orgs.map((o) => o.id);

  const [purchasesRes, companiesRes] = await Promise.all([
    admin.from("crankleads_purchases").select(PURCHASE_FIELDS).in("organization_id", orgIds),
    admin.from("companies").select("*").in("organization_id", orgIds),
  ]);
  fail("purchases lookup", purchasesRes.error);
  fail("companies lookup", companiesRes.error);
  const purchases = latestByOrg((purchasesRes.data ?? []) as PurchaseRow[]);
  const allCompanies = (companiesRes.data ?? []) as CompanyRow[];
  const picked = new Map(orgs.map((o) => [o.id, pickCompany(o.id, purchases.get(o.id) ?? null, allCompanies)]));
  const companyIds = unique([...picked.values()].map((c) => c?.id));

  const [intakesRes, numbersRes, sitesRes, progressRes] = companyIds.length
    ? await Promise.all([
        admin.from("setup_intakes").select("company_id, status, enrichment, submitted_at, enriched_at, last_error").in("company_id", companyIds),
        admin
          .from("voice_numbers")
          .select("company_id, phone_e164, mode, provider, forwarding_verified_at, active")
          .in("company_id", companyIds)
          .eq("active", true),
        admin.from("company_sites").select("company_id, slug, status, mode, published_at").in("company_id", companyIds),
        admin.from("dfy_progress").select(PROGRESS_FIELDS).in("company_id", companyIds),
      ])
    : [
        { data: [], error: null },
        { data: [], error: null },
        { data: [], error: null },
        { data: [], error: null },
      ];
  fail("intakes lookup", intakesRes.error);
  fail("voice numbers lookup", numbersRes.error);
  fail("sites lookup", sitesRes.error);
  // dfy_progress is context (number / forwarding state); a failure there shouldn't hide the list.
  if (progressRes.error) console.error("[concierge] dfy_progress lookup failed:", progressRes.error.message);
  const intakes = new Map(((intakesRes.data ?? []) as IntakeRow[]).map((r) => [r.company_id, r]));
  const sites = new Map(((sitesRes.data ?? []) as SiteRow[]).map((r) => [r.company_id, r]));
  const progressRows = new Map(((progressRes.error ? [] : progressRes.data ?? []) as ProgressRow[]).map((r) => [r.company_id, r]));
  const numbers = (numbersRes.data ?? []) as VoiceRow[];

  return mapWithConcurrency(orgs, CHECKLIST_CONCURRENCY, async (org) => {
    const purchase = purchases.get(org.id) ?? null;
    const company = picked.get(org.id) ?? null;
    const checklist = await loadChecklistSafe(admin, org, company?.id ?? null, purchase?.tier ?? null);
    return summarizeAccount({
      org,
      purchase,
      company,
      intake: company ? intakes.get(company.id) ?? null : null,
      numbers: company ? numbers.filter((n) => n.company_id === company.id) : [],
      site: company ? sites.get(company.id) ?? null : null,
      progress: company ? progressRows.get(company.id) ?? null : null,
      checklist,
      nowMs,
    });
  });
}

export interface ResolvedAccount {
  org: OrgRow;
  purchase: PurchaseRow | null;
  company: CompanyRow;
}

/**
 * The org (must exist) and the company an operator works on. A `companyId` from the
 * request is honoured only if that company belongs to the org — otherwise 404, so a
 * mismatched id can never steer a write into another tenant.
 */
export async function resolveAccount(admin: AdminClient, organizationId: string, companyId?: string | null): Promise<ResolvedAccount> {
  const { data: org, error: orgError } = await admin.from("organizations").select(ORG_FIELDS).eq("id", organizationId).maybeSingle();
  fail("organization lookup", orgError);
  if (!org) throw new ConciergeNotFoundError();

  const { data: purchaseData, error: purchaseError } = await admin
    .from("crankleads_purchases")
    .select(PURCHASE_FIELDS)
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(1);
  fail("purchase lookup", purchaseError);
  const purchase = ((purchaseData ?? []) as PurchaseRow[])[0] ?? null;

  const { data: companyData, error: companyError } = await admin.from("companies").select("*").eq("organization_id", organizationId);
  fail("companies lookup", companyError);
  const companies = (companyData ?? []) as CompanyRow[];

  let company: CompanyRow | null;
  if (companyId) {
    company = companies.find((c) => c.id === companyId && c.organization_id === organizationId) ?? null;
  } else {
    company = pickCompany(organizationId, purchase, companies);
  }
  if (!company) throw new ConciergeNotFoundError();
  return { org: org as OrgRow, purchase, company };
}

function companyFacts(c: CompanyRow): ConciergeCompanyFacts {
  const profile = c.profile && typeof c.profile === "object" && !Array.isArray(c.profile) ? (c.profile as Record<string, unknown>) : {};
  return {
    id: c.id,
    name: c.name,
    website: c.website,
    hours: c.hours,
    hoursText: hoursToText(c.hours),
    serviceArea: c.service_area,
    logoUrl: c.brand_logo_url,
    reviewUrl: c.brand_review_url,
    googlePlaceId: c.google_place_id,
    googleRating: c.google_rating === null || c.google_rating === undefined ? null : Number(c.google_rating),
    googleReviewCount: c.google_review_count,
    businessPhone: c.brand_reply_phone,
    ownerPhone: c.owner_phone_e164,
    phoneKind: c.business_phone_kind,
    phoneCarrier: c.business_phone_carrier,
    timezone: c.timezone,
    profile,
  };
}

/** Full detail for one org (the operator named it explicitly). */
export async function loadConciergeAccountDetail(
  admin: AdminClient,
  organizationId: string,
  options: { nowMs?: number; companyId?: string | null; actions?: Array<{ name: string; label: string }> } = {},
): Promise<ConciergeAccountDetail> {
  const nowMs = options.nowMs ?? Date.now();
  const { org, purchase, company } = await resolveAccount(admin, organizationId, options.companyId);
  const org_ = organizationId;
  const co = company.id;

  const [intakeRes, numbersRes, siteRes, servicesRes, workflowsRes, activityRes, followupsRes, progressRes] = await Promise.all([
    admin
      .from("setup_intakes")
      .select("company_id, status, enrichment, submitted_at, enriched_at, last_error")
      .eq("organization_id", org_)
      .eq("company_id", co)
      .maybeSingle(),
    admin
      .from("voice_numbers")
      .select("company_id, phone_e164, mode, provider, forwarding_verified_at, active")
      .eq("organization_id", org_)
      .eq("company_id", co)
      .eq("active", true),
    admin.from("company_sites").select("company_id, slug, status, mode, published_at").eq("organization_id", org_).eq("company_id", co).maybeSingle(),
    admin
      .from("service_catalog_items")
      .select("*")
      .eq("organization_id", org_)
      .eq("company_id", co)
      .order("sort_order", { ascending: true }),
    admin.from("workflows").select("id, name, slug, status").eq("organization_id", org_).eq("company_id", co).order("name", { ascending: true }),
    admin
      .from("operator_actions")
      .select("id, operator_email, action, detail, created_at")
      .eq("organization_id", org_)
      .order("created_at", { ascending: false })
      .limit(50),
    admin
      .from("crankleads_setup_followups")
      .select("id, stage, local_date, sms_status, email_status, created_at")
      .eq("organization_id", org_)
      .order("created_at", { ascending: false })
      .limit(20),
    admin.from("dfy_progress").select(PROGRESS_FIELDS).eq("organization_id", org_).eq("company_id", co).maybeSingle(),
  ]);
  fail("intake lookup", intakeRes.error);
  fail("voice numbers lookup", numbersRes.error);
  fail("site lookup", siteRes.error);
  fail("services lookup", servicesRes.error);
  fail("automations lookup", workflowsRes.error);
  fail("activity lookup", activityRes.error);
  // Follow-ups are nice-to-have context; a failure there shouldn't hide the account.
  if (followupsRes.error) console.error("[concierge] follow-ups lookup failed:", followupsRes.error.message);
  if (progressRes.error) console.error("[concierge] dfy_progress lookup failed:", progressRes.error.message);

  const items = (servicesRes.data ?? []) as Tables<"service_catalog_items">[];
  const services: ConciergeService[] = items.map((i) => ({
    id: i.id,
    label: i.label,
    unitLabel: i.unit_label,
    pricingType: i.pricing_type,
    rateCents: i.rate_cents,
    minimumCents: i.minimum_cents,
    active: i.active,
    needsPrice: needsPrice(i),
  }));
  const activityRows = (activityRes.data ?? []) as Array<Pick<Tables<"operator_actions">, "id" | "operator_email" | "action" | "detail" | "created_at">>;
  const activity: ConciergeActivity[] = activityRows.map((r) => ({
    id: r.id,
    operatorEmail: r.operator_email,
    action: r.action,
    detail: r.detail && typeof r.detail === "object" && !Array.isArray(r.detail) ? (r.detail as Record<string, unknown>) : {},
    createdAt: r.created_at,
  }));
  const followups: ConciergeFollowup[] = (
    (followupsRes.error ? [] : followupsRes.data ?? []) as Array<
      Pick<Tables<"crankleads_setup_followups">, "id" | "stage" | "local_date" | "sms_status" | "email_status" | "created_at">
    >
  ).map((f) => ({
    id: f.id,
    stage: f.stage,
    localDate: f.local_date,
    smsStatus: f.sms_status,
    emailStatus: f.email_status,
    createdAt: f.created_at,
  }));

  const checklist = await loadChecklistSafe(admin, org, co, purchase?.tier ?? null);
  const account = summarizeAccount({
    org,
    purchase,
    company,
    intake: (intakeRes.data as IntakeRow | null) ?? null,
    numbers: (numbersRes.data ?? []) as VoiceRow[],
    site: (siteRes.data as SiteRow | null) ?? null,
    progress: progressRes.error ? null : ((progressRes.data as ProgressRow | null) ?? null),
    checklist,
    nowMs,
  });

  return {
    account,
    company: companyFacts(company),
    services,
    automations: ((workflowsRes.data ?? []) as Array<Pick<Tables<"workflows">, "id" | "name" | "slug" | "status">>).map((w) => ({
      id: w.id,
      name: w.name,
      slug: w.slug,
      status: w.status,
    })),
    activity,
    followups,
    callScript: buildCallScript({
      account,
      phoneKind: company.business_phone_kind,
      phoneCarrier: company.business_phone_carrier,
      servicesNeedingPrices: services.filter((s) => s.needsPrice).length,
      pricedServices: services.filter((s) => !s.needsPrice).length,
    }),
    actions: options.actions ?? [],
  };
}
