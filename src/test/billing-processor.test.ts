/**
 * Billing event processor — the state-transition core.
 *
 * Uses an in-memory PostgREST-like fake (same approach as intake-service.test.ts,
 * extended with upsert). Proves: each handled event type produces the correct
 * organizations/subscriptions transition and stamps the ledger processed; replay
 * is idempotent; an unknown customer dead-letters the job and leaves the ledger
 * unprocessed (never discarded).
 */
import { beforeEach, describe, expect, it } from "vitest";

import { processBillingEventJob } from "@/server/services/billing/events";

type Row = Record<string, any>;

function createFakeDb(seed: Record<string, Row[]>) {
  const store: Record<string, Row[]> = {
    billing_event_jobs: [],
    billing_events: [],
    organizations: [],
    subscriptions: [],
    ...seed,
  };
  let idSeq = 1;

  function from(table: string) {
    const filters: Array<[string, unknown]> = [];
    let op: "select" | "insert" | "update" = "select";
    let payload: Row = {};
    const rows = () => (store[table] ??= []);
    const applyFilters = () => rows().filter((r) => filters.every(([c, v]) => r[c] === v));

    const doInsert = () => {
      const arr = Array.isArray(payload) ? payload : [payload];
      const inserted = arr.map((p) => {
        const row = { id: p.id ?? `${table}-${idSeq++}`, ...p };
        rows().push(row);
        return row;
      });
      return { data: inserted[0], error: null };
    };
    const doUpdate = () => {
      const matched = applyFilters();
      matched.forEach((r) => Object.assign(r, payload));
      return { data: matched, error: null };
    };

    const b: Row = {
      insert(p: Row) { op = "insert"; payload = p; return b; },
      update(p: Row) { op = "update"; payload = p; return b; },
      upsert(p: Row, opts?: { onConflict?: string }) {
        const key = opts?.onConflict;
        const arr = Array.isArray(p) ? p : [p];
        for (const item of arr) {
          const existing = key ? rows().find((r) => r[key] === item[key]) : undefined;
          if (existing) {
            Object.assign(existing, item);
          } else {
            rows().push({ id: item.id ?? `${table}-${idSeq++}`, ...item });
          }
        }
        return Promise.resolve({ data: null, error: null });
      },
      select() { return b; },
      eq(c: string, v: unknown) { filters.push([c, v]); return b; },
      order() { return b; },
      limit() { return b; },
      maybeSingle: async () =>
        op === "insert" ? doInsert() : { data: applyFilters()[0] ?? null, error: null },
      single: async () => {
        if (op === "insert") return doInsert();
        const r = applyFilters()[0];
        return { data: r ?? null, error: r ? null : { message: "no rows" } };
      },
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => {
        const result =
          op === "insert" ? doInsert() : op === "update" ? doUpdate() : { data: applyFilters(), error: null };
        return Promise.resolve(result).then(onF, onR);
      },
    };
    return b;
  }

  return {
    store,
    client: { from } as unknown as ReturnType<
      typeof import("@/server/supabase/admin").createSupabaseAdminClient
    >,
  };
}

const CUSTOMER = "cus_test";
const SUB = "sub_test";

function makeEvent(type: string, object: Row): Row {
  return { data: { object }, id: `evt_${type}`, type };
}

/** Seed one org (with a Stripe customer) + a ledger row + its job, ready to process. */
function seedFor(type: string, object: Row, orgOverrides: Row = {}) {
  const fake = createFakeDb({
    billing_event_jobs: [{ billing_event_id: "be-1", id: "job-1", status: "running" }],
    billing_events: [
      {
        id: "be-1",
        organization_id: null,
        payload: makeEvent(type, object),
        processed_at: null,
        stripe_event_id: `evt_${type}`,
        type,
      },
    ],
    organizations: [
      { id: "org-1", name: "Test Org", plan: "launch", stripe_customer_id: CUSTOMER, subscription_status: "none", ...orgOverrides },
    ],
    subscriptions: [],
  });
  return fake;
}

beforeEach(() => {
  process.env.STRIPE_PRICE_LAUNCH = "price_launch";
  process.env.STRIPE_PRICE_OPERATE = "price_operate";
  process.env.STRIPE_PRICE_FRONT_DESK = "price_front_desk";
});

describe("billing processor — state transitions", () => {
  it("checkout.session.completed -> org active, plan from metadata, subscription row", async () => {
    const fake = seedFor("checkout.session.completed", {
      customer: CUSTOMER,
      metadata: { organizationId: "org-1", plan: "operate" },
      subscription: SUB,
    });

    await processBillingEventJob(fake.client, fake.store.billing_event_jobs[0] as any);

    expect(fake.store.organizations[0].subscription_status).toBe("active");
    expect(fake.store.organizations[0].plan).toBe("operate");
    expect(fake.store.subscriptions).toHaveLength(1);
    expect(fake.store.subscriptions[0].stripe_subscription_id).toBe(SUB);
    expect(fake.store.subscriptions[0].status).toBe("active");
    expect(fake.store.billing_events[0].processed_at).toBeTruthy();
    expect(fake.store.billing_events[0].organization_id).toBe("org-1");
    expect(fake.store.billing_event_jobs[0].status).toBe("completed");
  });

  it("invoice.paid -> org active", async () => {
    const fake = seedFor("invoice.paid", {
      customer: CUSTOMER,
      lines: { data: [{ period: { end: 1893456000 } }] },
      subscription: SUB,
    });

    await processBillingEventJob(fake.client, fake.store.billing_event_jobs[0] as any);

    expect(fake.store.organizations[0].subscription_status).toBe("active");
    expect(fake.store.subscriptions[0].status).toBe("active");
    expect(fake.store.subscriptions[0].current_period_end).toBeTruthy();
  });

  it("invoice.payment_failed -> org past_due", async () => {
    const fake = seedFor("invoice.payment_failed", { customer: CUSTOMER, subscription: SUB });

    await processBillingEventJob(fake.client, fake.store.billing_event_jobs[0] as any);

    expect(fake.store.organizations[0].subscription_status).toBe("past_due");
    expect(fake.store.subscriptions[0].status).toBe("past_due");
  });

  it("customer.subscription.updated -> plan from price, status mapped", async () => {
    const fake = seedFor("customer.subscription.updated", {
      current_period_end: 1893456000,
      customer: CUSTOMER,
      id: SUB,
      items: { data: [{ price: { id: "price_launch" } }] },
      status: "active",
    });

    await processBillingEventJob(fake.client, fake.store.billing_event_jobs[0] as any);

    expect(fake.store.organizations[0].plan).toBe("launch");
    expect(fake.store.organizations[0].subscription_status).toBe("active");
    expect(fake.store.subscriptions[0].plan).toBe("launch");
    expect(fake.store.subscriptions[0].current_period_end).toBeTruthy();
  });

  it("customer.subscription.deleted -> org canceled, plan retained for history", async () => {
    const fake = seedFor(
      "customer.subscription.deleted",
      { current_period_end: 1893456000, customer: CUSTOMER, id: SUB, status: "canceled" },
      { plan: "operate", subscription_status: "active" },
    );

    await processBillingEventJob(fake.client, fake.store.billing_event_jobs[0] as any);

    expect(fake.store.organizations[0].subscription_status).toBe("canceled");
    expect(fake.store.organizations[0].plan).toBe("operate"); // retained, not reset
    expect(fake.store.subscriptions[0].status).toBe("canceled");
  });
});

describe("billing processor — idempotency & dead-letter", () => {
  it("reprocessing the same event yields identical state and no duplicate subscription", async () => {
    const object = {
      current_period_end: 1893456000,
      customer: CUSTOMER,
      id: SUB,
      items: { data: [{ price: { id: "price_launch" } }] },
      status: "active",
    };
    const fake = seedFor("customer.subscription.updated", object);

    await processBillingEventJob(fake.client, fake.store.billing_event_jobs[0] as any);
    const afterFirst = JSON.stringify({
      org: fake.store.organizations[0],
      subs: fake.store.subscriptions,
    });

    // Simulate a crash-retry: the job runs again on a ledger row whose transition
    // was applied but processed_at wasn't yet written. Transitions must be idempotent.
    fake.store.billing_events[0].processed_at = null;
    await processBillingEventJob(fake.client, fake.store.billing_event_jobs[0] as any);

    const afterSecond = JSON.stringify({
      org: fake.store.organizations[0],
      subs: fake.store.subscriptions,
    });
    expect(afterSecond).toBe(afterFirst);
    expect(fake.store.subscriptions).toHaveLength(1); // upsert did not duplicate
  });

  it("already-processed ledger row is a no-op that still completes the job", async () => {
    const fake = seedFor("invoice.payment_failed", { customer: CUSTOMER, subscription: SUB });
    fake.store.billing_events[0].processed_at = "2026-08-01T00:00:00.000Z";

    await processBillingEventJob(fake.client, fake.store.billing_event_jobs[0] as any);

    // No transition applied (org untouched), job completed.
    expect(fake.store.organizations[0].subscription_status).toBe("none");
    expect(fake.store.billing_event_jobs[0].status).toBe("completed");
  });

  it("unknown customer -> job dead-lettered, ledger left unprocessed, throws", async () => {
    const fake = seedFor("invoice.payment_failed", { customer: "cus_unknown", subscription: SUB });

    await expect(
      processBillingEventJob(fake.client, fake.store.billing_event_jobs[0] as any),
    ).rejects.toThrow();

    expect(fake.store.billing_event_jobs[0].status).toBe("failed");
    expect(fake.store.billing_events[0].processed_at).toBeNull();
    // The org (real customer) is untouched.
    expect(fake.store.organizations[0].subscription_status).toBe("none");
  });
});
