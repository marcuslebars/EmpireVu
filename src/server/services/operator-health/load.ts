// ─────────────────────────────────────────────────────────────────────────────
// SANCTIONED EXCEPTION (service role): daily operator health email — loader.
// Reads ACROSS tenants with the worker's service-role client: the report is for the platform
// operator (OWNER_EMAIL) only, it is aggregate ("which accounts need a human"), and it takes NO
// request input — it runs in the workflow-event worker's scheduler pass or the
// `npm run job:operator-health` CLI, neither of which has a user session or a tenant to scope
// by. Every per-account read (setup checklist, activity counts) is filtered by the row's OWN
// organization_id (+ company_id) as stored in the database, never by anything a caller chose.
// Output goes only to the operator inbox. Listed in docs/EMPIREVU_RUNBOOK.md.
// ─────────────────────────────────────────────────────────────────────────────
import type { SupabaseClient } from "@supabase/supabase-js";

import { buildForwardingInstructions } from "@/lib/carrier-forwarding";
import type { Tables } from "@/server/db/database.types";
import { isCrankleadsTier } from "@/server/services/crankleads/config";
import type { AdminClient } from "@/server/services/crankleads/purchases";
import { loadSetupChecklist, setupStepPath } from "@/server/services/crankleads/setup-checklist";
import {
  BROKEN_FORWARDING_RESULTS,
  PAYING_STATUSES,
  PAYMENT_PROBLEM_STATUSES,
  PROVISIONING_LOOKBACK_DAYS,
  QUEUE_FAILED_WINDOW_HOURS,
  SETUP_STALL_BUSINESS_DAYS,
  SILENT_DAYS,
  STUCK_PROVISIONING_STATUSES,
  SUPPORT_OPEN_HOURS,
  setupBusinessDays,
  type CheckError,
  type ForwardingFact,
  type OperatorHealthFacts,
  type PaymentFact,
  type ProvisioningFact,
  type QueueFact,
  type SetupFact,
  type SilentFact,
  type SupportFact,
} from "@/server/services/operator-health/rules";
import { QUEUE_KEYS, QUEUE_TABLES } from "@/server/services/queue-health";
import type { TenantServiceContext } from "@/server/services/shared";

/** Not-live purchases older than this are not examined (matches the follow-ups' live detection). */
export const SETUP_LOOKBACK_DAYS = 90;
/** Row caps per scan (the operator has tens of accounts, not thousands). */
const SCAN_LIMIT = 500;

const DAY = 86_400_000;

export interface LoadFactsInput {
  nowMs: number;
  timeZone: string;
  appBaseUrl: string;
  stripeDashboardBase: string;
  graceDays: number;
}

type OrgRow = Pick<Tables<"organizations">, "id" | "name" | "crankleads_tier" | "plan" | "subscription_status" | "stripe_customer_id" | "updated_at">;
const ORG_FIELDS = "id, name, crankleads_tier, plan, subscription_status, stripe_customer_id, updated_at";

type CompanyRow = Pick<Tables<"companies">, "id" | "organization_id" | "name" | "timezone">;

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err) return String((err as { message: unknown }).message);
  return String(err);
}

function fail(what: string, error: { message: string } | null): void {
  if (error) throw new Error(`${what}: ${error.message}`);
}

function unique(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.filter((v): v is string => typeof v === "string" && v.length > 0)));
}

async function loadOrgs(admin: AdminClient, ids: string[]): Promise<Map<string, OrgRow>> {
  if (ids.length === 0) return new Map();
  const { data, error } = await admin.from("organizations").select(ORG_FIELDS).in("id", ids);
  fail("organizations lookup failed", error);
  return new Map(((data ?? []) as OrgRow[]).map((o) => [o.id, o]));
}

async function loadCompanies(admin: AdminClient, ids: string[]): Promise<Map<string, CompanyRow>> {
  if (ids.length === 0) return new Map();
  const { data, error } = await admin.from("companies").select("id, organization_id, name, timezone").in("id", ids);
  fail("companies lookup failed", error);
  return new Map(((data ?? []) as CompanyRow[]).map((c) => [c.id, c]));
}

function base(url: string): string {
  return url.replace(/\/+$/, "");
}

// ── Setup stalled ────────────────────────────────────────────────────────────

type SetupPurchaseRow = Pick<
  Tables<"crankleads_purchases">,
  | "id"
  | "tier"
  | "organization_id"
  | "company_id"
  | "provisioned_at"
  | "business_name"
  | "owner_name"
  | "owner_email"
  | "owner_phone"
  | "stripe_customer_id"
  | "setup_reminders_stopped_at"
>;

export async function loadSetupFacts(admin: AdminClient, input: LoadFactsInput, errors: CheckError[]): Promise<SetupFact[]> {
  const { data, error } = await admin
    .from("crankleads_purchases")
    .select(
      "id, tier, organization_id, company_id, provisioned_at, business_name, owner_name, owner_email, owner_phone, stripe_customer_id, setup_reminders_stopped_at",
    )
    .eq("status", "provisioned")
    .is("live_at", null)
    .gt("provisioned_at", new Date(input.nowMs - SETUP_LOOKBACK_DAYS * DAY).toISOString())
    .order("provisioned_at", { ascending: true })
    .limit(SCAN_LIMIT);
  fail("not-live purchase scan failed", error);
  const purchases = ((data ?? []) as SetupPurchaseRow[]).filter((p) => p.organization_id && p.company_id && p.provisioned_at);
  const orgs = await loadOrgs(admin, unique(purchases.map((p) => p.organization_id)));
  const companies = await loadCompanies(admin, unique(purchases.map((p) => p.company_id)));

  const facts: SetupFact[] = [];
  for (const purchase of purchases) {
    const organizationId = purchase.organization_id as string;
    const companyId = purchase.company_id as string;
    const org = orgs.get(organizationId);
    const company = companies.get(companyId);
    const subscriptionStatus = org?.subscription_status ?? "none";
    if (subscriptionStatus === "canceled") continue;
    const rawTier = org?.crankleads_tier ?? purchase.tier;
    const tier = isCrankleadsTier(rawTier) ? rawTier : isCrankleadsTier(purchase.tier) ? purchase.tier : null;
    const fact: SetupFact = {
      organizationId,
      businessName: company?.name ?? purchase.business_name,
      tier,
      stripeCustomerId: org?.stripe_customer_id ?? purchase.stripe_customer_id,
      purchaseId: purchase.id,
      provisionedAt: purchase.provisioned_at as string,
      timeZone: company?.timezone?.trim() || input.timeZone,
      subscriptionStatus,
      remindersStopped: Boolean(purchase.setup_reminders_stopped_at),
      checklist: null,
      ownerName: purchase.owner_name,
      ownerEmail: purchase.owner_email,
      ownerPhone: purchase.owner_phone,
    };
    // Only the checklist of a purchase that is old enough to flag is worth its 7 queries.
    if (setupBusinessDays(fact, input.nowMs) < SETUP_STALL_BUSINESS_DAYS) continue;
    if (tier) {
      try {
        const ctx: TenantServiceContext = { organizationId, actorProfileId: null, supabase: admin };
        const checklist = await loadSetupChecklist(ctx, { companyId, tier, appBaseUrl: input.appBaseUrl });
        fact.checklist = checklist
          ? {
              doneCount: checklist.doneCount,
              totalCount: checklist.totalCount,
              isLive: checklist.isLive,
              nextStepTitle: checklist.nextStep?.title ?? null,
              nextStepLink: checklist.nextStep?.deepLink ?? null,
            }
          : null;
      } catch (err) {
        errors.push({ section: `the setup checklist for ${fact.businessName}`, message: errorMessage(err) });
      }
    }
    facts.push(fact);
  }
  return facts;
}

// ── Forwarding broken ────────────────────────────────────────────────────────

type CatcherRow = Pick<
  Tables<"voice_numbers">,
  "id" | "organization_id" | "company_id" | "phone_e164" | "forwarding_last_test_result" | "forwarding_last_test_at"
>;
type TestRow = Pick<Tables<"forwarding_tests">, "voice_number_id" | "status" | "started_at">;

/** First failed test after the most recent pass ('answered' is inconclusive and skipped). */
export function failingSinceFrom(tests: TestRow[]): string | null {
  const newestFirst = [...tests].sort((a, b) => b.started_at.localeCompare(a.started_at));
  let since: string | null = null;
  for (const test of newestFirst) {
    if (test.status === "passed") break;
    if (BROKEN_FORWARDING_RESULTS.includes(test.status)) since = test.started_at;
  }
  return since;
}

export async function loadForwardingFacts(admin: AdminClient, input: LoadFactsInput): Promise<ForwardingFact[]> {
  const { data, error } = await admin
    .from("voice_numbers")
    .select("id, organization_id, company_id, phone_e164, forwarding_last_test_result, forwarding_last_test_at")
    .eq("provider", "twilio")
    .eq("mode", "missed_call_catcher")
    .eq("active", true)
    .in("forwarding_last_test_result", [...BROKEN_FORWARDING_RESULTS])
    .limit(SCAN_LIMIT);
  fail("catcher number scan failed", error);
  const numbers = (data ?? []) as CatcherRow[];
  if (numbers.length === 0) return [];

  const orgIds = unique(numbers.map((n) => n.organization_id));
  const [orgs, companies] = await Promise.all([loadOrgs(admin, orgIds), loadCompanies(admin, unique(numbers.map((n) => n.company_id)))]);

  const { data: testData, error: testError } = await admin
    .from("forwarding_tests")
    .select("voice_number_id, status, started_at")
    .in("voice_number_id", numbers.map((n) => n.id))
    .neq("status", "calling")
    .order("started_at", { ascending: false })
    .limit(5000);
  fail("forwarding test lookup failed", testError);
  const tests = (testData ?? []) as TestRow[];

  const { data: liveData, error: liveError } = await admin
    .from("crankleads_purchases")
    .select("organization_id")
    .in("organization_id", orgIds)
    .not("live_at", "is", null);
  fail("live purchase lookup failed", liveError);
  const liveOrgs = new Set(unique(((liveData ?? []) as Array<{ organization_id: string | null }>).map((r) => r.organization_id)));

  const facts: ForwardingFact[] = [];
  for (const vn of numbers) {
    const org = orgs.get(vn.organization_id);
    const mine = tests.filter((t) => t.voice_number_id === vn.id);
    let everWorked = mine.some((t) => t.status === "passed");
    if (!everWorked) {
      // Passive proof: a real call the carrier forwarded from the business line (missed-call.ts).
      const { data: proof, error: proofError } = await admin
        .from("missed_calls")
        .select("id")
        .eq("organization_id", vn.organization_id)
        .eq("company_id", vn.company_id)
        .eq("to_number", vn.phone_e164)
        .not("forwarded_from", "is", null)
        .limit(1);
      fail("forwarded-call lookup failed", proofError);
      everWorked = (proof ?? []).length > 0;
    }
    let activateCode: string | null = null;
    try {
      activateCode = buildForwardingInstructions(vn.phone_e164).recommended.activate;
    } catch {
      activateCode = null;
    }
    facts.push({
      organizationId: vn.organization_id,
      businessName: companies.get(vn.company_id)?.name ?? org?.name ?? vn.organization_id,
      tier: org?.crankleads_tier ?? null,
      stripeCustomerId: org?.stripe_customer_id ?? null,
      voiceNumberId: vn.id,
      catcherNumber: vn.phone_e164,
      lastResult: vn.forwarding_last_test_result ?? "",
      lastTestAt: vn.forwarding_last_test_at,
      failingSince: failingSinceFrom(mine),
      everWorked,
      accountLive: liveOrgs.has(vn.organization_id),
      subscriptionStatus: org?.subscription_status ?? "none",
      activateCode,
      fixLink: `${base(input.appBaseUrl)}${setupStepPath(vn.organization_id, "phone")}`,
    });
  }
  return facts;
}

// ── Payment problems ─────────────────────────────────────────────────────────

type SubscriptionRow = Pick<Tables<"subscriptions">, "organization_id" | "stripe_subscription_id" | "current_period_end" | "updated_at">;

export async function loadPaymentFacts(admin: AdminClient): Promise<PaymentFact[]> {
  const { data, error } = await admin
    .from("organizations")
    .select(ORG_FIELDS)
    .in("subscription_status", [...PAYMENT_PROBLEM_STATUSES])
    .neq("plan", "internal")
    .limit(SCAN_LIMIT);
  fail("past-due organization scan failed", error);
  const orgs = (data ?? []) as OrgRow[];
  if (orgs.length === 0) return [];

  const { data: subData, error: subError } = await admin
    .from("subscriptions")
    .select("organization_id, stripe_subscription_id, current_period_end, updated_at")
    .in("organization_id", orgs.map((o) => o.id));
  fail("subscription lookup failed", subError);
  const latest = new Map<string, SubscriptionRow>();
  for (const sub of (subData ?? []) as SubscriptionRow[]) {
    const seen = latest.get(sub.organization_id);
    if (!seen || sub.updated_at > seen.updated_at) latest.set(sub.organization_id, sub);
  }

  return orgs.map((org) => {
    const sub = latest.get(org.id) ?? null;
    return {
      organizationId: org.id,
      businessName: org.name,
      tier: org.crankleads_tier,
      stripeCustomerId: org.stripe_customer_id,
      plan: org.plan,
      subscriptionStatus: org.subscription_status,
      since: sub?.updated_at ?? org.updated_at,
      currentPeriodEnd: sub?.current_period_end ?? null,
      stripeSubscriptionId: sub?.stripe_subscription_id ?? null,
    };
  });
}

// ── Provisioning failures ────────────────────────────────────────────────────

type ProvisioningRow = Pick<
  Tables<"crankleads_purchases">,
  | "id"
  | "status"
  | "tier"
  | "business_name"
  | "stripe_checkout_session_id"
  | "stripe_customer_id"
  | "last_error"
  | "provision_attempts"
  | "paid_at"
  | "failed_at"
  | "created_at"
  | "updated_at"
>;

export async function loadProvisioningFacts(admin: AdminClient, input: LoadFactsInput): Promise<ProvisioningFact[]> {
  const { data, error } = await admin
    .from("crankleads_purchases")
    .select(
      "id, status, tier, business_name, stripe_checkout_session_id, stripe_customer_id, last_error, provision_attempts, paid_at, failed_at, created_at, updated_at",
    )
    .in("status", ["failed", ...STUCK_PROVISIONING_STATUSES])
    .gt("updated_at", new Date(input.nowMs - PROVISIONING_LOOKBACK_DAYS * DAY).toISOString())
    .limit(SCAN_LIMIT);
  fail("provisioning scan failed", error);
  return ((data ?? []) as ProvisioningRow[]).map((row) => ({
    purchaseId: row.id,
    businessName: row.business_name,
    tier: row.tier,
    status: row.status,
    sessionId: row.stripe_checkout_session_id,
    stripeCustomerId: row.stripe_customer_id,
    lastError: row.last_error,
    attempts: row.provision_attempts,
    paidAt: row.paid_at,
    failedAt: row.failed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

// ── Silent accounts ──────────────────────────────────────────────────────────

async function countSince(
  admin: AdminClient,
  table: "contacts" | "missed_calls" | "retell_calls",
  organizationId: string,
  sinceIso: string,
): Promise<number> {
  const { count, error } = await admin
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .gte("created_at", sinceIso);
  fail(`${table} count failed`, error);
  return count ?? 0;
}

export async function loadSilentFacts(admin: AdminClient, input: LoadFactsInput): Promise<SilentFact[]> {
  const { data, error } = await admin
    .from("crankleads_purchases")
    .select("organization_id, live_at")
    .eq("status", "provisioned")
    .not("live_at", "is", null)
    .lte("live_at", new Date(input.nowMs - SILENT_DAYS * DAY).toISOString())
    .limit(SCAN_LIMIT);
  fail("live purchase scan failed", error);
  const rows = (data ?? []) as Array<{ organization_id: string | null; live_at: string | null }>;
  const liveAtByOrg = new Map<string, string>();
  for (const row of rows) {
    if (row.organization_id && row.live_at && !liveAtByOrg.has(row.organization_id)) liveAtByOrg.set(row.organization_id, row.live_at);
  }
  const orgs = await loadOrgs(admin, Array.from(liveAtByOrg.keys()));
  const sinceIso = new Date(input.nowMs - SILENT_DAYS * DAY).toISOString();

  const facts: SilentFact[] = [];
  for (const [organizationId, liveAt] of liveAtByOrg) {
    const org = orgs.get(organizationId);
    if (!org || !PAYING_STATUSES.includes(org.subscription_status)) continue;
    // Cheapest first; stop counting as soon as there is any activity.
    const newContacts = await countSince(admin, "contacts", organizationId, sinceIso);
    const missedCalls = newContacts > 0 ? 0 : await countSince(admin, "missed_calls", organizationId, sinceIso);
    const aiCalls = newContacts + missedCalls > 0 ? 0 : await countSince(admin, "retell_calls", organizationId, sinceIso);
    facts.push({
      organizationId,
      businessName: org.name,
      tier: org.crankleads_tier,
      stripeCustomerId: org.stripe_customer_id,
      liveAt,
      subscriptionStatus: org.subscription_status,
      newContacts,
      missedCalls,
      aiCalls,
    });
  }
  return facts;
}

// ── Open support requests ────────────────────────────────────────────────────

type SupportRow = Pick<Tables<"support_requests">, "id" | "organization_id" | "requester_email" | "question" | "status" | "created_at">;

export async function loadSupportFacts(admin: AdminClient, input: LoadFactsInput): Promise<SupportFact[]> {
  const { data, error } = await admin
    .from("support_requests")
    .select("id, organization_id, requester_email, question, status, created_at")
    .eq("status", "open")
    .lte("created_at", new Date(input.nowMs - SUPPORT_OPEN_HOURS * 3_600_000).toISOString())
    .order("created_at", { ascending: true })
    .limit(SCAN_LIMIT);
  fail("support request scan failed", error);
  const rows = (data ?? []) as SupportRow[];
  const orgs = await loadOrgs(admin, unique(rows.map((r) => r.organization_id)));
  return rows.map((row) => {
    const org = orgs.get(row.organization_id);
    return {
      id: row.id,
      organizationId: row.organization_id,
      businessName: org?.name ?? row.organization_id,
      tier: org?.crankleads_tier ?? null,
      requesterEmail: row.requester_email,
      question: row.question,
      status: row.status,
      createdAt: row.created_at,
    };
  });
}

// ── Queue health ─────────────────────────────────────────────────────────────

/**
 * Aggregate-only reads of the durable queues (same tables as /api/health). Uses the library's
 * loosely-typed client so the table / ready column can be chosen by name.
 */
export async function loadQueueFacts(admin: AdminClient, input: LoadFactsInput, errors: CheckError[]): Promise<QueueFact[]> {
  const loose: SupabaseClient = admin;
  const nowIso = new Date(input.nowMs).toISOString();
  const failedSince = new Date(input.nowMs - QUEUE_FAILED_WINDOW_HOURS * 3_600_000).toISOString();
  const facts: QueueFact[] = [];
  for (const key of QUEUE_KEYS) {
    const spec = QUEUE_TABLES[key];
    try {
      const failed = await loose
        .from(spec.table)
        .select("*", { count: "exact", head: true })
        .in("status", [...spec.failedStatuses])
        .gte("updated_at", failedSince);
      fail(`${spec.table} failed count`, failed.error);
      const pending = await loose.from(spec.table).select("*", { count: "exact", head: true }).eq("status", "pending");
      fail(`${spec.table} pending count`, pending.error);
      const oldest = await loose
        .from(spec.table)
        .select("*")
        .eq("status", "pending")
        .lte(spec.readyColumn, nowIso)
        .order(spec.readyColumn, { ascending: true })
        .limit(1)
        .maybeSingle();
      fail(`${spec.table} oldest pending`, oldest.error);
      const oldestRow = oldest.data as Record<string, string | null> | null;
      facts.push({
        key,
        label: spec.label,
        table: spec.table,
        service: spec.service,
        failedStatuses: spec.failedStatuses,
        failedRecent: failed.count ?? 0,
        pending: pending.count ?? 0,
        oldestReadyAt: oldestRow?.[spec.readyColumn] ?? null,
      });
    } catch (err) {
      errors.push({ section: `the ${spec.label} queue`, message: errorMessage(err) });
    }
  }
  return facts;
}

// ── All facts ────────────────────────────────────────────────────────────────

/**
 * Every section's facts. A section that fails to load is reported as a CheckError (so a broken
 * query is never mistaken for "all clear"); the other sections still load.
 */
export async function loadOperatorHealthFacts(admin: AdminClient, input: LoadFactsInput): Promise<OperatorHealthFacts> {
  const errors: CheckError[] = [];
  const guard = async <T>(section: string, work: () => Promise<T[]>): Promise<T[]> => {
    try {
      return await work();
    } catch (err) {
      errors.push({ section, message: errorMessage(err) });
      return [];
    }
  };
  const provisioning = await guard("provisioning", () => loadProvisioningFacts(admin, input));
  const forwarding = await guard("call forwarding", () => loadForwardingFacts(admin, input));
  const setup = await guard("setup progress", () => loadSetupFacts(admin, input, errors));
  const payments = await guard("payments", () => loadPaymentFacts(admin));
  const support = await guard("support requests", () => loadSupportFacts(admin, input));
  const silent = await guard("silent accounts", () => loadSilentFacts(admin, input));
  const queues = await guard("job queues", () => loadQueueFacts(admin, input, errors));
  return {
    nowMs: input.nowMs,
    timeZone: input.timeZone,
    appBaseUrl: input.appBaseUrl,
    stripeDashboardBase: input.stripeDashboardBase,
    graceDays: input.graceDays,
    setup,
    forwarding,
    payments,
    provisioning,
    silent,
    support,
    queues,
    errors,
  };
}
