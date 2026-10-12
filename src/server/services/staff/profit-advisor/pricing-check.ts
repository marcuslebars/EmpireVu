/**
 * The pricing check, with data (docs/ai-staff.md → "Profit advisor"): loads the last 180 days of
 * finished jobs (job costing), the quotes sent, the price list and past price changes, and runs
 * the pure maths in pricing.ts. Read-only — the monthly sweep (sweeps.ts) turns its proposals into
 * price_change questions; the owner tool `pricing_check` and Settings only show it.
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import type { Db, PriceChangeRow } from "./db-types";
import { addDays, daysBetween, localDay, localMidnightIso } from "./format";
import { loadJobProfits } from "./jobs";
import {
  COOL_DAYS,
  isUnderpriced,
  itemStats,
  OPEN_QUOTE_DAYS,
  PRICING_WINDOW_DAYS,
  proposeRaise,
  SIMPLE_PRICING_TYPES,
  type CatalogForPricing,
  type ItemStats,
  type JobForPricing,
  type PricingLine,
  type Proposal,
  type QuoteForPricing,
} from "./pricing";
import { readAll, type ProfitCompany } from "./settings";

const DAY = 86_400_000;

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** A quote's lines the customer took: [{serviceKey|null (custom), amountCents}]. PURE. */
export function quoteLines(quote: { line_items: unknown; approved_line_items: unknown; input_snapshot: unknown }): Array<{ key: string | null; amountCents: number }> {
  const decided = Array.isArray(quote.approved_line_items) ? quote.approved_line_items : Array.isArray(quote.line_items) ? quote.line_items : [];
  const out: Array<{ key: string | null; amountCents: number }> = [];
  for (const raw of decided) {
    const l = rec(raw);
    if (l.selected === false) continue;
    const key = typeof l.serviceId === "string" && l.serviceId !== "custom" && l.custom !== true ? l.serviceId : null;
    out.push({ key, amountCents: num(l.amountCents) });
  }
  if (out.length > 0) return out;
  // No stored lines: the snapshot's services, equal shares.
  const services = Array.isArray(rec(quote.input_snapshot).services) ? (rec(quote.input_snapshot).services as unknown[]) : [];
  return services.map((s) => rec(s)).filter((s) => typeof s.serviceId === "string" && !(s.optional === true && s.selected !== true)).map((s) => ({ key: String(s.serviceId), amountCents: 0 }));
}

export interface ItemReport extends ItemStats {
  label: string;
  rateCents: number;
  unitLabel: string | null;
  pricingType: string;
  underpriced: boolean;
  proposal: Proposal | null;
  /** Why an underpriced item isn't proposed: changed / asked in the last 90 days, a tiered price, too small a raise. */
  held: "recent_change" | "pending" | "not_simple" | "no_room" | null;
}

export interface ChangeEffect {
  id: string;
  label: string;
  oldRateCents: number;
  newRateCents: number;
  appliedAt: string;
  before: { marginPct: number; winRatePct: number | null; jobs: number };
  after: { jobs: number; marginPct: number | null; quotes: number; winRatePct: number | null };
}

export interface PricingReport {
  windowDays: number;
  companyMargin: number | null;
  pricedJobs: number;
  items: ItemReport[];
  changes: ChangeEffect[];
  pending: Array<{ label: string; oldRateCents: number; newRateCents: number }>;
  truncated: boolean;
}

interface QuoteRow {
  id: string;
  status: string;
  sent_at: string | null;
  approved_at: string | null;
  superseded_by: string | null;
  line_items: unknown;
  approved_line_items: unknown;
  input_snapshot: unknown;
}

export async function loadCatalog(admin: AdminClient, scope: { organizationId: string; companyId: string }): Promise<CatalogForPricing[]> {
  const db = admin as Db;
  const { data, error } = await db
    .from("service_catalog_items")
    .select("id, label, pricing_type, rate_cents, minimum_cents, unit_label, active, service_key")
    .eq("organization_id", scope.organizationId)
    .eq("company_id", scope.companyId)
    .limit(1000);
  if (error) throw error;
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    label: String(r.label ?? "Service"),
    pricingType: String(r.pricing_type ?? "flat"),
    rateCents: num(r.rate_cents),
    minimumCents: num(r.minimum_cents),
    unitLabel: (r.unit_label as string | null) ?? null,
    active: r.active !== false,
    serviceKey: String(r.service_key ?? ""),
  })) as Array<CatalogForPricing & { serviceKey: string }>;
}

/** Recent price changes (the 90-day rule and the before/after). */
export async function loadPriceChanges(admin: AdminClient, scope: { organizationId: string; companyId: string }, sinceIso: string): Promise<PriceChangeRow[]> {
  const db = admin as Db;
  const { data, error } = await db.from("price_changes").select("*").eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).gte("created_at", sinceIso).order("created_at", { ascending: false }).limit(500);
  if (error) throw error;
  return (data ?? []) as PriceChangeRow[];
}

export async function runPricingCheck(admin: AdminClient, company: Pick<ProfitCompany, "organizationId" | "companyId" | "timeZone">, nowMs: number): Promise<PricingReport> {
  const db = admin as Db;
  const scope = { organizationId: company.organizationId, companyId: company.companyId };
  const today = localDay(nowMs, company.timeZone);
  const fromIso = localMidnightIso(addDays(today, -PRICING_WINDOW_DAYS), company.timeZone);
  const toIso = new Date(nowMs).toISOString();
  const catalog = (await loadCatalog(admin, scope)) as Array<CatalogForPricing & { serviceKey: string }>;
  const byKey = new Map(catalog.map((c) => [c.serviceKey, c.id]));
  const byId = new Map(catalog.map((c) => [c.id, c]));

  const profits = await loadJobProfits(admin, scope, fromIso, toIso, nowMs);
  const quoteIds = [...new Set(profits.rows.map((r) => r.quoteId).filter((x): x is string => !!x))];
  const jobQuotes = new Map<string, QuoteRow>();
  for (let i = 0; i < quoteIds.length; i += 200) {
    const { data, error } = await db.from("quotes").select("id, line_items, approved_line_items, input_snapshot").eq("organization_id", scope.organizationId).in("id", quoteIds.slice(i, i + 200));
    if (error) throw error;
    for (const q of (data ?? []) as QuoteRow[]) jobQuotes.set(q.id, q);
  }
  const toLines = (q: Pick<QuoteRow, "line_items" | "approved_line_items" | "input_snapshot">): PricingLine[] => quoteLines(q).map((l) => ({ itemId: l.key ? (byKey.get(l.key) ?? null) : null, amountCents: l.amountCents }));
  const jobs: Array<JobForPricing & { at: string }> = profits.rows.map((r) => {
    const q = r.quoteId ? jobQuotes.get(r.quoteId) : undefined;
    const lines = q ? toLines(q) : r.serviceItemId ? [{ itemId: r.serviceItemId, amountCents: r.revenueCents }] : [];
    return { bookingId: r.bookingId, revenueCents: r.revenueCents, profitCents: r.profitCents, lines, at: r.scheduledFor };
  });

  const sent = await readAll<QuoteRow>((from, to) =>
    db
      .from("quotes")
      .select("id, status, sent_at, approved_at, superseded_by, line_items, approved_line_items, input_snapshot")
      .eq("organization_id", scope.organizationId)
      .eq("company_id", scope.companyId)
      .gte("sent_at", fromIso)
      .order("sent_at", { ascending: true })
      .range(from, to),
  );
  const openSince = nowMs - OPEN_QUOTE_DAYS * DAY;
  const quotes: Array<QuoteForPricing & { at: string }> = [];
  for (const q of sent) {
    if (q.superseded_by || !q.sent_at) continue;
    const won = Boolean(q.approved_at);
    const decided = won || q.status === "expired" || q.status === "cancelled" || Date.parse(q.sent_at) < openSince;
    if (!decided) continue;
    const itemIds = [...new Set(toLines(q).map((l) => l.itemId).filter((x): x is string => !!x))];
    if (itemIds.length) quotes.push({ id: q.id, won, itemIds, at: q.sent_at });
  }

  const { companyMargin, items } = itemStats(jobs, quotes);
  const changes = await loadPriceChanges(admin, scope, new Date(nowMs - PRICING_WINDOW_DAYS * DAY).toISOString());
  const coolSince = nowMs - COOL_DAYS * DAY;
  const reports: ItemReport[] = [];
  for (const s of items.values()) {
    const item = byId.get(s.itemId);
    if (!item) continue;
    const underpriced = isUnderpriced(s, companyMargin);
    let proposal: Proposal | null = null;
    let held: ItemReport["held"] = null;
    if (underpriced && companyMargin != null) {
      const mine = changes.filter((c) => c.service_catalog_item_id === item.id);
      if (mine.some((c) => c.status === "proposed" || c.status === "applying")) held = "pending";
      else if (mine.some((c) => ["applied", "declined"].includes(c.status) && Date.parse(c.applied_at ?? c.decided_at ?? c.created_at) >= coolSince)) held = "recent_change";
      else {
        proposal = proposeRaise(item, s, companyMargin);
        if (!proposal) held = SIMPLE_PRICING_TYPES.has(item.pricingType) ? "no_room" : "not_simple";
      }
    }
    reports.push({ ...s, label: item.label, rateCents: item.rateCents, unitLabel: item.unitLabel, pricingType: item.pricingType, underpriced, proposal, held });
  }
  reports.sort((a, b) => b.jobs - a.jobs || a.label.localeCompare(b.label));

  const effects: ChangeEffect[] = [];
  for (const c of changes) {
    if (c.status !== "applied" || !c.applied_at || !c.service_catalog_item_id) continue;
    const after = itemStats(
      jobs.filter((j) => j.at >= c.applied_at!),
      quotes.filter((q) => q.at >= c.applied_at!),
    ).items.get(c.service_catalog_item_id);
    effects.push({
      id: c.id,
      label: c.item_label,
      oldRateCents: c.old_rate_cents,
      newRateCents: c.new_rate_cents,
      appliedAt: c.applied_at,
      before: { marginPct: c.basis?.marginPct ?? 0, winRatePct: c.basis?.winRatePct ?? null, jobs: c.basis?.jobs ?? 0 },
      after: {
        jobs: after?.jobs ?? 0,
        marginPct: after?.margin != null ? Math.round(after.margin * 100) : null,
        quotes: after?.quotes ?? 0,
        winRatePct: after?.winRate != null ? Math.round(after.winRate * 100) : null,
      },
    });
  }
  return {
    windowDays: PRICING_WINDOW_DAYS,
    companyMargin,
    pricedJobs: jobs.filter((j) => j.revenueCents > 0).length,
    items: reports,
    changes: effects,
    pending: changes.filter((c) => c.status === "proposed").map((c) => ({ label: c.item_label, oldRateCents: c.old_rate_cents, newRateCents: c.new_rate_cents })),
    truncated: profits.truncated,
  };
}

/** "Gutter cleaning: +11% on Oct 6 - 4 jobs since at 31% margin (was 12%)". PURE. */
export function effectLine(e: ChangeEffect, nowMs: number): string {
  const days = Math.max(0, daysBetween(e.appliedAt.slice(0, 10), new Date(nowMs).toISOString().slice(0, 10)));
  const since = e.after.jobs === 0 ? "no jobs since yet" : `${e.after.jobs} job${e.after.jobs === 1 ? "" : "s"} since at ${e.after.marginPct ?? "?"}% margin (was ${e.before.marginPct}%)`;
  const win = e.after.winRatePct != null && e.after.quotes > 0 ? `, winning ${e.after.winRatePct}% of quotes (was ${e.before.winRatePct ?? "?"}%)` : "";
  return `${e.label}: raised ${days} days ago - ${since}${win}`;
}
