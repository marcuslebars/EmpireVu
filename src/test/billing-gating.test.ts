/**
 * Feature gating — orgCan / orgLimit / isBillingHealthy.
 *
 * Proves: internal (house) org passes everything; launch fails marina_reception;
 * past_due beyond grace fails paid features (and within grace still passes);
 * canceled fails; a feature_flags row overrides the plan default (both ways).
 */
import { beforeEach, describe, expect, it } from "vitest";

import { BILLING_FEATURES, PLAN_FEATURE_DEFAULTS } from "@/server/services/billing/config";
import { isBillingHealthy, orgCan, orgLimit, requireFeature } from "@/server/services/billing/gating";

type Row = Record<string, any>;

function createFakeDb(seed: Record<string, Row[]>) {
  const store: Record<string, Row[]> = {
    feature_flags: [],
    organizations: [],
    subscriptions: [],
    ...seed,
  };

  function from(table: string) {
    const filters: Array<[string, unknown]> = [];
    const rows = () => (store[table] ??= []);
    const applyFilters = () => rows().filter((r) => filters.every(([c, v]) => r[c] === v));
    const b: Row = {
      select() { return b; },
      eq(c: string, v: unknown) { filters.push([c, v]); return b; },
      order() { return b; },
      limit() { return b; },
      maybeSingle: async () => ({ data: applyFilters()[0] ?? null, error: null }),
    };
    return b;
  }

  return {
    store,
    client: { from } as unknown as ReturnType<
      typeof import("@/server/supabase/server").createSupabaseServerClient
    >,
  };
}

const ORG = "org-1";
const daysFromNow = (n: number) => new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString();

beforeEach(() => {
  delete process.env.BILLING_PAST_DUE_GRACE_DAYS; // default 7
});

describe("orgCan — internal (house tenants)", () => {
  it("passes every feature and returns unlimited, regardless of status", async () => {
    const fake = createFakeDb({
      organizations: [{ id: ORG, plan: "internal", subscription_status: "none" }],
    });
    for (const feature of BILLING_FEATURES) {
      expect(await orgCan(fake.client, ORG, feature)).toBe(true);
      expect(await orgLimit(fake.client, ORG, feature)).toBeNull();
    }
  });
});

describe("orgCan — plan defaults", () => {
  it("launch (active) allows bookings but not marina_reception or workflows", async () => {
    const fake = createFakeDb({
      organizations: [{ id: ORG, plan: "launch", subscription_status: "active" }],
      subscriptions: [{ current_period_end: daysFromNow(20), organization_id: ORG }],
    });
    expect(await orgCan(fake.client, ORG, "bookings")).toBe(true);
    expect(await orgCan(fake.client, ORG, "marina_reception")).toBe(false);
    expect(await orgCan(fake.client, ORG, "workflows")).toBe(false);
  });

  it("front_desk (active) allows marina_reception", async () => {
    const fake = createFakeDb({
      organizations: [{ id: ORG, plan: "front_desk", subscription_status: "active" }],
      subscriptions: [{ current_period_end: daysFromNow(20), organization_id: ORG }],
    });
    expect(await orgCan(fake.client, ORG, "marina_reception")).toBe(true);
  });

  it("front_desk (active) now allows workflows + sms_sequences (superset of operate)", async () => {
    const fake = createFakeDb({
      organizations: [{ id: ORG, plan: "front_desk", subscription_status: "active" }],
      subscriptions: [{ current_period_end: daysFromNow(20), organization_id: ORG }],
    });
    expect(await orgCan(fake.client, ORG, "workflows")).toBe(true);
    expect(await orgCan(fake.client, ORG, "sms_sequences")).toBe(true);
  });
});

describe("PLAN_FEATURE_DEFAULTS — front_desk is a strict superset of operate", () => {
  it("grants every feature operate grants, plus marina_reception", () => {
    for (const feature of BILLING_FEATURES) {
      if (PLAN_FEATURE_DEFAULTS.operate[feature]) {
        expect(PLAN_FEATURE_DEFAULTS.front_desk[feature]).toBe(true);
      }
    }
    // marina_reception stays front_desk-only among the purchasable plans.
    expect(PLAN_FEATURE_DEFAULTS.front_desk.marina_reception).toBe(true);
    expect(PLAN_FEATURE_DEFAULTS.operate.marina_reception).toBe(false);
  });
});

describe("orgCan — subscription health", () => {
  it("past_due beyond grace fails paid features", async () => {
    const fake = createFakeDb({
      organizations: [{ id: ORG, plan: "launch", subscription_status: "past_due" }],
      subscriptions: [{ current_period_end: daysFromNow(-30), organization_id: ORG }], // grace 7 -> expired
    });
    expect(await orgCan(fake.client, ORG, "bookings")).toBe(false);
    expect(await orgLimit(fake.client, ORG, "bookings")).toBe(0);
  });

  it("past_due within grace still passes", async () => {
    const fake = createFakeDb({
      organizations: [{ id: ORG, plan: "launch", subscription_status: "past_due" }],
      subscriptions: [{ current_period_end: daysFromNow(-1), organization_id: ORG }], // 1 day ago, within 7
    });
    expect(await orgCan(fake.client, ORG, "bookings")).toBe(true);
  });

  it("canceled fails paid features", async () => {
    const fake = createFakeDb({
      organizations: [{ id: ORG, plan: "launch", subscription_status: "canceled" }],
      subscriptions: [{ current_period_end: daysFromNow(20), organization_id: ORG }],
    });
    expect(await orgCan(fake.client, ORG, "bookings")).toBe(false);
  });
});

describe("orgCan — feature_flags override the plan default", () => {
  it("an enabled flag turns a plan-off feature on", async () => {
    const fake = createFakeDb({
      feature_flags: [{ enabled: true, feature: "workflows", limit_value: null, organization_id: ORG }],
      organizations: [{ id: ORG, plan: "launch", subscription_status: "active" }],
      subscriptions: [{ current_period_end: daysFromNow(20), organization_id: ORG }],
    });
    expect(await orgCan(fake.client, ORG, "workflows")).toBe(true); // plan default is false
  });

  it("a disabled flag turns a plan-on feature off", async () => {
    const fake = createFakeDb({
      feature_flags: [{ enabled: false, feature: "bookings", limit_value: null, organization_id: ORG }],
      organizations: [{ id: ORG, plan: "launch", subscription_status: "active" }],
      subscriptions: [{ current_period_end: daysFromNow(20), organization_id: ORG }],
    });
    expect(await orgCan(fake.client, ORG, "bookings")).toBe(false); // plan default is true
  });

  it("limit_value overrides the plan limit", async () => {
    const fake = createFakeDb({
      feature_flags: [{ enabled: true, feature: "bookings", limit_value: 5, organization_id: ORG }],
      organizations: [{ id: ORG, plan: "launch", subscription_status: "active" }],
      subscriptions: [{ current_period_end: daysFromNow(20), organization_id: ORG }],
    });
    expect(await orgLimit(fake.client, ORG, "bookings")).toBe(5);
  });
});

describe("orgCan — trial", () => {
  it("full plan access while the trial is live, then gated once it lapses", async () => {
    const live = createFakeDb({
      organizations: [
        { id: ORG, plan: "operate", subscription_status: "trialing", trial_ends_at: daysFromNow(10) },
      ],
    });
    expect(await orgCan(live.client, ORG, "workflows")).toBe(true);

    const lapsed = createFakeDb({
      organizations: [
        { id: ORG, plan: "operate", subscription_status: "trialing", trial_ends_at: daysFromNow(-1) },
      ],
    });
    expect(await orgCan(lapsed.client, ORG, "workflows")).toBe(false);
  });
});

describe("isBillingHealthy", () => {
  const now = new Date("2026-08-04T00:00:00.000Z");
  it("active is healthy; an open-ended trial (no end date) is healthy", () => {
    expect(isBillingHealthy("active", null, null, now, 7)).toBe(true);
    expect(isBillingHealthy("trialing", null, null, now, 7)).toBe(true);
  });
  it("a trial is healthy before trial_ends_at and lapses after", () => {
    expect(isBillingHealthy("trialing", null, "2026-08-10T00:00:00.000Z", now, 7)).toBe(true); // ends in 6d
    expect(isBillingHealthy("trialing", null, "2026-08-01T00:00:00.000Z", now, 7)).toBe(false); // ended 3d ago
  });
  it("none / canceled are not healthy", () => {
    expect(isBillingHealthy("none", null, null, now, 7)).toBe(false);
    expect(isBillingHealthy("canceled", "2099-01-01T00:00:00Z", null, now, 7)).toBe(false);
  });
  it("past_due respects the grace window from current_period_end", () => {
    expect(isBillingHealthy("past_due", "2026-08-01T00:00:00.000Z", null, now, 7)).toBe(true); // +3d < 7
    expect(isBillingHealthy("past_due", "2026-07-20T00:00:00.000Z", null, now, 7)).toBe(false); // +15d > 7
    expect(isBillingHealthy("past_due", null, null, now, 7)).toBe(false); // no period end -> off
  });
});

describe("requireFeature (route enforcement guard)", () => {
  it("throws for a launch org calling marina_reception", async () => {
    const fake = createFakeDb({
      organizations: [{ id: ORG, plan: "launch", subscription_status: "active" }],
      subscriptions: [{ current_period_end: daysFromNow(20), organization_id: ORG }],
    });
    await expect(requireFeature(fake.client, ORG, "marina_reception")).rejects.toThrow();
  });

  it("passes for an internal (house) org", async () => {
    const fake = createFakeDb({
      organizations: [{ id: ORG, plan: "internal", subscription_status: "none" }],
    });
    await expect(requireFeature(fake.client, ORG, "marina_reception")).resolves.toBeUndefined();
  });

  it("passes for a front_desk org (active)", async () => {
    const fake = createFakeDb({
      organizations: [{ id: ORG, plan: "front_desk", subscription_status: "active" }],
      subscriptions: [{ current_period_end: daysFromNow(20), organization_id: ORG }],
    });
    await expect(requireFeature(fake.client, ORG, "marina_reception")).resolves.toBeUndefined();
  });

  it("gates workflows + sms_sequences by plan (operate includes them, launch does not)", async () => {
    const launch = createFakeDb({
      organizations: [{ id: ORG, plan: "launch", subscription_status: "active" }],
      subscriptions: [{ current_period_end: daysFromNow(20), organization_id: ORG }],
    });
    await expect(requireFeature(launch.client, ORG, "workflows")).rejects.toThrow();
    await expect(requireFeature(launch.client, ORG, "sms_sequences")).rejects.toThrow();

    const operate = createFakeDb({
      organizations: [{ id: ORG, plan: "operate", subscription_status: "active" }],
      subscriptions: [{ current_period_end: daysFromNow(20), organization_id: ORG }],
    });
    await expect(requireFeature(operate.client, ORG, "workflows")).resolves.toBeUndefined();
    await expect(requireFeature(operate.client, ORG, "sms_sequences")).resolves.toBeUndefined();
  });
});
