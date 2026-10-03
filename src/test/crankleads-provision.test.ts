/**
 * CrankLeads purchase → provisioning, end to end through the billing processor.
 *
 * The REAL services run (billing processor, createOrganization, createCompany + recipe install,
 * applyIndustryPack, public form keys, onboarding progress) against the in-memory PostgREST
 * fake; only the edges are mocked: Supabase Auth admin, and Resend (sendEmail).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "./helpers/fake-supabase";

const sendEmail = vi.fn(async (_input: { to: string; subject: string; body: string; html?: string }) => ({ id: "msg_1" }));
vi.mock("@/server/outbound/email", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/outbound/email")>();
  return { ...original, sendEmail: (input: { to: string; subject: string; body: string }) => sendEmail(input) };
});

import { processBillingEventJob } from "@/server/services/billing/events";
import { runCrankleadsProvisionJob } from "@/server/services/crankleads/rerun";

type Row = Record<string, unknown>;

const SESSION = "cs_test_a1b2c3d4e5f6g7h8i9";
const PURCHASE_ID = "purchase-1";
const CUSTOMER = "cus_cl_1";
const SUBSCRIPTION = "sub_cl_1";
const BUYER = "jane@roofco.example";

let db: FakeDb;
let admin: never;
let authUsers: Array<{ id: string; email: string; email_confirmed_at?: string | null; last_sign_in_at?: string | null }>;
let createUser: ReturnType<typeof vi.fn>;
let updateUserById: ReturnType<typeof vi.fn>;
let generateLink: ReturnType<typeof vi.fn>;
let eventSeq = 0;

function purchaseRow(overrides: Row = {}): Row {
  return {
    id: PURCHASE_ID,
    status: "checkout_created",
    tier: "catch",
    stripe_checkout_session_id: SESSION,
    stripe_customer_id: null,
    stripe_subscription_id: null,
    owner_name: "Jane Roofer",
    owner_email: BUYER,
    owner_phone: "(705) 555-0101",
    business_name: "Jane's Roofing",
    business_type: "Roofing",
    founding: false,
    utm: {},
    organization_id: null,
    company_id: null,
    owner_profile_id: null,
    existing_user: null,
    provision_attempts: 0,
    last_error: null,
    welcome_email_sent_at: null,
    operator_notified_at: null,
    provisioning_started_at: null,
    created_at: "2026-10-02T12:00:00.000Z",
    ...overrides,
  };
}

function sessionObject(overrides: Row = {}): Row {
  return {
    id: SESSION,
    object: "checkout.session",
    payment_status: "paid",
    customer: CUSTOMER,
    subscription: SUBSCRIPTION,
    client_reference_id: PURCHASE_ID,
    customer_details: { email: BUYER },
    metadata: { source: "crankleads", purchaseId: PURCHASE_ID, tier: "catch", plan: "operate" },
    ...overrides,
  };
}

function subscriptionObject(priceId: string): Row {
  return {
    id: SUBSCRIPTION,
    object: "subscription",
    customer: CUSTOMER,
    status: "active",
    items: { data: [{ price: { id: priceId } }] },
    metadata: { source: "crankleads", purchaseId: PURCHASE_ID, tier: "front_desk" },
  };
}

/** Durably record an event + its job the way the webhook's RPC would. */
function seedEvent(type: string, object: Row, job: Row = {}): Row {
  eventSeq += 1;
  const ledgerId = `be-${eventSeq}`;
  db.tables.billing_events.push({
    id: ledgerId,
    stripe_event_id: `evt_${eventSeq}`,
    type,
    payload: { id: `evt_${eventSeq}`, type, data: { object } },
    organization_id: null,
    processed_at: null,
  });
  const jobRow: Row = {
    id: `job-${eventSeq}`,
    billing_event_id: ledgerId,
    status: "running",
    attempt_count: 1,
    max_attempts: 5,
    available_at: new Date().toISOString(),
    ...job,
  };
  db.tables.billing_event_jobs.push(jobRow);
  return jobRow;
}

function setup(seed: Record<string, Row[]> = {}) {
  db = createFakeDb(
    {
      billing_events: [],
      billing_event_jobs: [],
      crankleads_purchases: [purchaseRow()],
      organizations: [],
      organization_memberships: [],
      profiles: [],
      subscriptions: [],
      companies: [],
      workflows: [],
      service_catalog_items: [],
      public_form_keys: [],
      onboarding_progress: [],
      activity_events: [],
      ...seed,
    },
    { organizations: [["stripe_customer_id"], ["slug"]], profiles: [["email"]] },
  );
  authUsers = [];
  createUser = vi.fn(async ({ email, user_metadata }: { email: string; user_metadata: { full_name: string } }) => {
    const id = `00000000-0000-4000-8000-00000000${String(authUsers.length + 1).padStart(4, "0")}`;
    authUsers.push({ id, email, email_confirmed_at: "2026-10-02T12:00:00Z", last_sign_in_at: null });
    // The on_auth_user_created trigger.
    db.tables.profiles.push({ id, email, full_name: user_metadata.full_name });
    return { data: { user: { id, email } }, error: null };
  });
  updateUserById = vi.fn(async (id: string, attrs: Record<string, unknown>) => {
    const user = authUsers.find((u) => u.id === id);
    if (user && attrs.email_confirm) user.email_confirmed_at = "2026-10-03T00:00:00Z";
    return { data: { user }, error: null };
  });
  generateLink = vi.fn(async () => ({ data: { properties: { hashed_token: "hashed_tok_123" } }, error: null }));
  const auth = {
    admin: {
      createUser,
      generateLink,
      listUsers: vi.fn(async () => ({ data: { users: authUsers }, error: null })),
      getUserById: vi.fn(async (id: string) => {
        const user = authUsers.find((u) => u.id === id);
        return user ? { data: { user }, error: null } : { data: { user: null }, error: { message: "User not found" } };
      }),
      updateUserById,
    },
  };
  admin = Object.assign(db.client as object, { auth }) as never;
}

function purchase(): Row {
  return db.tables.crankleads_purchases[0];
}

function job(id: string): Row {
  return db.tables.billing_event_jobs.find((j) => j.id === id) as Row;
}

beforeEach(() => {
  eventSeq = 0;
  sendEmail.mockClear();
  vi.stubEnv("APP_BASE_URL", "https://app.empirevu.test");
  vi.stubEnv("OWNER_EMAIL", "ops@empirevu.test");
  vi.stubEnv("STRIPE_PRICE_CL_CATCH", "price_cl_catch");
  vi.stubEnv("STRIPE_PRICE_CL_CLOSE", "price_cl_close");
  vi.stubEnv("STRIPE_PRICE_CL_FRONT_DESK", "price_cl_front_desk");
  setup();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("checkout.session.completed (CrankLeads) → provisioned account", () => {
  it("creates the owner login, paid org, owner membership, company, pack, form key, onboarding steps and emails", async () => {
    const checkoutJob = seedEvent("checkout.session.completed", sessionObject());
    await processBillingEventJob(admin, checkoutJob as never);

    // Purchase state machine.
    const p = purchase();
    expect(p.status).toBe("provisioned");
    expect(p.stripe_customer_id).toBe(CUSTOMER);
    expect(p.stripe_subscription_id).toBe(SUBSCRIPTION);
    expect(p.provision_attempts).toBe(1);
    expect(p.existing_user).toBe(false);

    // Login.
    expect(createUser).toHaveBeenCalledWith(expect.objectContaining({ email: BUYER, email_confirm: true }));

    // Org: paid, tier plan, linked to Stripe, NOT on a trial and NOT internal.
    expect(db.tables.organizations).toHaveLength(1);
    const org = db.tables.organizations[0];
    expect(org).toMatchObject({
      name: "Jane's Roofing",
      slug: "jane-s-roofing",
      plan: "operate",
      subscription_status: "active",
      trial_ends_at: null,
      stripe_customer_id: CUSTOMER,
      crankleads_tier: "catch",
      billing_email: BUYER,
    });
    expect(p.organization_id).toBe(org.id);

    // Owner membership.
    expect(db.tables.organization_memberships).toEqual([
      expect.objectContaining({ organization_id: org.id, profile_id: p.owner_profile_id, role: "owner" }),
    ]);

    // Company via the wizard's service: normalized phone, owner email, Ontario timezone.
    expect(db.tables.companies).toHaveLength(1);
    const company = db.tables.companies[0];
    expect(company).toMatchObject({
      organization_id: org.id,
      name: "Jane's Roofing",
      owner_phone_e164: "+17055550101",
      owner_email: BUYER,
      timezone: "America/Toronto",
    });
    expect(p.company_id).toBe(company.id);

    // Roofing pack: services (unpriced, inactive) + Catch automations only.
    expect((company.industry_pack as Row).id).toBe("roofing");
    const services = db.tables.service_catalog_items.filter((s) => s.company_id === company.id);
    expect(services.length).toBeGreaterThan(0);
    expect(services.every((s) => s.rate_cents === 0 && s.active === false)).toBe(true);
    const tailored = (company.industry_pack as { recipes: string[] }).recipes;
    expect(tailored).toContain("missed-call-text-back");
    expect(tailored).not.toContain("post-call-quote-text");
    expect(tailored).not.toContain("call-summary-to-owner");

    // Website form key.
    expect(db.tables.public_form_keys).toEqual([
      expect.objectContaining({ organization_id: org.id, company_id: company.id, active: true }),
    ]);
    const formKey = db.tables.public_form_keys[0].public_key as string;

    // Onboarding resumes after business + services.
    const steps = Object.fromEntries(db.tables.onboarding_progress.map((s) => [s.step, s.status]));
    expect(steps).toEqual({ business: "complete", services: "complete" });

    // Subscription mirror + ledger backfill + job done.
    expect(db.tables.subscriptions).toEqual([
      expect.objectContaining({ organization_id: org.id, stripe_subscription_id: SUBSCRIPTION, plan: "operate", status: "active" }),
    ]);
    expect(db.tables.billing_events[0]).toMatchObject({ organization_id: org.id });
    expect(db.tables.billing_events[0].processed_at).toBeTruthy();
    expect(job(checkoutJob.id as string).status).toBe("completed");

    // Emails: buyer welcome (set-password token_hash link + hosted form) and operator note.
    expect(sendEmail).toHaveBeenCalledTimes(2);
    const welcome = sendEmail.mock.calls.find(([m]) => m.to === BUYER)?.[0];
    expect(welcome?.subject).toBe("Your CrankLeads system is ready — finish setup (10 min)");
    expect(welcome?.body).toContain(
      "https://app.empirevu.test/update-password?token_hash=hashed_tok_123&type=recovery&next=%2Fonboarding",
    );
    expect(welcome?.body).toContain(`https://app.empirevu.test/f/${formKey}`);
    expect(welcome?.body).toContain("Set your password and log in to EmpireVu");
    expect(welcome?.body).not.toMatch(/\$\s?\d/);
    expect(generateLink).toHaveBeenCalledWith(expect.objectContaining({ type: "recovery", email: BUYER }));
    const operator = sendEmail.mock.calls.find(([m]) => m.to === "ops@empirevu.test")?.[0];
    expect(operator?.subject).toBe("New CrankLeads purchase: Jane's Roofing (Catch)");
    expect(p.welcome_email_sent_at).toBeTruthy();
    expect(p.operator_notified_at).toBeTruthy();
  });

  it("is idempotent: the same session delivered twice → one org, one company, one welcome email", async () => {
    await processBillingEventJob(admin, seedEvent("checkout.session.completed", sessionObject()) as never);
    // A second, distinct delivery for the same session (e.g. async_payment_succeeded).
    await processBillingEventJob(admin, seedEvent("checkout.session.async_payment_succeeded", sessionObject()) as never);

    expect(db.tables.organizations).toHaveLength(1);
    expect(db.tables.organization_memberships).toHaveLength(1);
    expect(db.tables.companies).toHaveLength(1);
    expect(db.tables.public_form_keys).toHaveLength(1);
    expect(createUser).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls.filter(([m]) => m.to === BUYER)).toHaveLength(1);
    expect(purchase().provision_attempts).toBe(1);
  });

  it("waits (no provisioning) while the session is not paid yet", async () => {
    const j = seedEvent("checkout.session.completed", sessionObject({ payment_status: "unpaid" }));
    await processBillingEventJob(admin, j as never);
    expect(db.tables.organizations).toHaveLength(0);
    expect(purchase().status).toBe("checkout_created");
    expect(job(j.id as string).status).toBe("completed");
  });

  it("attaches the org to an EXISTING (confirmed) user, leaves their default org alone, and sends the 'log in' email", async () => {
    setup({
      profiles: [{ id: "11111111-1111-4111-8111-111111111111", email: BUYER, full_name: "Jane", default_organization_id: "their-own-org" }],
    });
    authUsers.push({ id: "11111111-1111-4111-8111-111111111111", email: BUYER, email_confirmed_at: "2026-01-01T00:00:00Z" });
    await processBillingEventJob(admin, seedEvent("checkout.session.completed", sessionObject()) as never);

    expect(createUser).not.toHaveBeenCalled();
    expect(generateLink).not.toHaveBeenCalled();
    expect(purchase().existing_user).toBe(true);
    expect(db.tables.organization_memberships).toEqual([
      expect.objectContaining({ profile_id: "11111111-1111-4111-8111-111111111111", role: "owner" }),
    ]);
    const welcome = sendEmail.mock.calls.find(([m]) => m.to === BUYER)?.[0];
    expect(welcome?.body).not.toContain("update-password");
    expect(welcome?.body).toContain("https://app.empirevu.test/onboarding");
    expect(welcome?.body).toContain("existing account");
    expect(db.tables.profiles[0].default_organization_id).toBe("their-own-org");
    expect(updateUserById).not.toHaveBeenCalled();
  });

  it("an UNCONFIRMED pre-registered user with the buyer's email is reclaimed for the payer (sessions revoked, set-password link)", async () => {
    const squatter = "22222222-2222-4222-8222-222222222222";
    setup({ profiles: [{ id: squatter, email: BUYER, full_name: "Someone else", default_organization_id: null }] });
    authUsers.push({ id: squatter, email: BUYER, email_confirmed_at: null });
    await processBillingEventJob(admin, seedEvent("checkout.session.completed", sessionObject()) as never);

    expect(createUser).not.toHaveBeenCalled();
    // Password scrambled + email confirmed + banned, then unbanned (GoTrue revokes sessions on ban).
    expect(updateUserById).toHaveBeenNthCalledWith(1, squatter, expect.objectContaining({ email_confirm: true, ban_duration: "876000h", password: expect.any(String) }));
    expect(updateUserById).toHaveBeenNthCalledWith(2, squatter, { ban_duration: "none" });
    expect(purchase().existing_user).toBe(false);
    expect(generateLink).toHaveBeenCalledWith(expect.objectContaining({ type: "recovery", email: BUYER }));
    const welcome = sendEmail.mock.calls.find(([m]) => m.to === BUYER)?.[0];
    expect(welcome?.body).toContain("update-password?token_hash=");
    expect(db.tables.profiles[0].default_organization_id).toBe(db.tables.organizations[0].id);
  });

  it("provisions a no_payment_required session (100%-off)", async () => {
    await processBillingEventJob(admin, seedEvent("checkout.session.completed", sessionObject({ payment_status: "no_payment_required" })) as never);
    expect(purchase().status).toBe("provisioned");
  });

  it("generic business types get no pack (and no services step)", async () => {
    setup({ crankleads_purchases: [purchaseRow({ business_type: "Cleaning", tier: "close" })] });
    await processBillingEventJob(
      admin,
      seedEvent("checkout.session.completed", sessionObject({ metadata: { source: "crankleads", purchaseId: PURCHASE_ID, tier: "close", plan: "operate" } })) as never,
    );
    expect(purchase().status).toBe("provisioned");
    expect(db.tables.companies[0].industry_pack ?? null).toBeNull();
    expect(db.tables.onboarding_progress.map((s) => s.step)).toEqual(["business"]);
  });

  it("rebuilds a missing purchase row from the session metadata (a paid purchase is never lost)", async () => {
    setup({ crankleads_purchases: [] });
    await processBillingEventJob(
      admin,
      seedEvent(
        "checkout.session.completed",
        sessionObject({
          metadata: {
            source: "crankleads",
            purchaseId: "gone",
            tier: "front_desk",
            plan: "front_desk",
            businessName: "Lakeside Marine",
            businessType: "Marine",
            ownerName: "Sam",
            ownerPhone: "7055550199",
          },
        }),
      ) as never,
    );
    expect(purchase()).toMatchObject({ status: "provisioned", business_name: "Lakeside Marine", tier: "front_desk" });
    expect(db.tables.organizations[0]).toMatchObject({ plan: "front_desk", crankleads_tier: "front_desk" });
  });
});

describe("subscription / invoice events that arrive before provisioning finishes", () => {
  it("are retried with backoff (not dead-lettered), then resolve to the new org", async () => {
    setup({ crankleads_purchases: [purchaseRow({ tier: "front_desk" })] });
    const subJob = seedEvent("customer.subscription.updated", subscriptionObject("price_cl_front_desk"));
    const invoiceJob = seedEvent("invoice.paid", {
      customer: CUSTOMER,
      parent: { subscription_details: { subscription: SUBSCRIPTION, metadata: { source: "crankleads", purchaseId: PURCHASE_ID } } },
    });

    await processBillingEventJob(admin, subJob as never);
    await processBillingEventJob(admin, invoiceJob as never);

    for (const j of [job(subJob.id as string), job(invoiceJob.id as string)]) {
      expect(j.status).toBe("pending");
      expect(Date.parse(j.available_at as string)).toBeGreaterThan(Date.now());
      expect(j.attempt_count).toBe(1);
      expect(String(j.last_error)).toContain("still being provisioned");
    }

    // The checkout event provisions the org and pulls the deferred jobs forward.
    await processBillingEventJob(
      admin,
      seedEvent("checkout.session.completed", sessionObject({ metadata: { source: "crankleads", purchaseId: PURCHASE_ID, tier: "front_desk", plan: "front_desk" } })) as never,
    );
    const org = db.tables.organizations[0];
    expect(org.plan).toBe("front_desk");
    expect(Date.parse(job(subJob.id as string).available_at as string)).toBeLessThanOrEqual(Date.now());

    // Re-run the deferred subscription job: it now maps to the org (CL price → front_desk plan).
    await processBillingEventJob(admin, { ...job(subJob.id as string), attempt_count: 2 } as never);
    expect(job(subJob.id as string).status).toBe("completed");
    expect(db.tables.billing_events.find((e) => e.id === subJob.billing_event_id)?.organization_id).toBe(org.id);
    expect(db.tables.organizations[0]).toMatchObject({ plan: "front_desk", crankleads_tier: "front_desk" });
  });

  it("dead-letters once the retries are spent", async () => {
    const j = seedEvent("customer.subscription.updated", subscriptionObject("price_cl_catch"), { attempt_count: 5 });
    await expect(processBillingEventJob(admin, j as never)).rejects.toThrow(/still being provisioned/);
    expect(job(j.id as string).status).toBe("failed");
    expect(db.tables.billing_events[0].processed_at).toBeNull();
  });

  it("an unknown NON-CrankLeads customer still dead-letters immediately; subscription.created stays a no-op", async () => {
    setup({ crankleads_purchases: [] });
    const updated = seedEvent("customer.subscription.updated", { id: "sub_x", customer: "cus_other", status: "active", items: { data: [] } });
    await expect(processBillingEventJob(admin, updated as never)).rejects.toThrow(/No organization/);
    expect(job(updated.id as string).status).toBe("failed");

    const created = seedEvent("customer.subscription.created", { id: "sub_x", customer: "cus_other", status: "active", items: { data: [] } });
    await processBillingEventJob(admin, created as never);
    expect(job(created.id as string).status).toBe("completed");
  });
});

describe("provisioning failures", () => {
  it("non-final failure → purchase failed + retry; final failure → operator alert + dead-letter; re-run job recovers", async () => {
    db.failNext("companies", "insert", { message: "db is down" });
    const first = seedEvent("checkout.session.completed", sessionObject());
    await processBillingEventJob(admin, first as never);

    expect(purchase()).toMatchObject({ status: "failed" });
    expect(String(purchase().last_error)).toContain("db is down");
    expect(job(first.id as string).status).toBe("pending"); // retried with backoff
    expect(sendEmail).not.toHaveBeenCalled(); // no alert before the last attempt

    // Last automatic attempt fails too.
    db.failNext("public_form_keys", "insert", { message: "still broken" });
    const last = { ...job(first.id as string), status: "running", attempt_count: 5 };
    await expect(processBillingEventJob(admin, last as never)).rejects.toThrow(/still broken/);
    expect(purchase().status).toBe("failed");
    expect(job(first.id as string).status).toBe("failed");
    const alert = sendEmail.mock.calls.find(([m]) => m.to === "ops@empirevu.test")?.[0];
    expect(alert?.subject).toContain("ACTION NEEDED");
    expect(alert?.body).toContain(`npm run job:crankleads-provision -- --session ${SESSION}`);
    // The failed attempt never created a second org.
    expect(db.tables.organizations).toHaveLength(1);

    // Operator re-run.
    const result = await runCrankleadsProvisionJob(admin, { sessionId: SESSION, stuck: false, olderThanMinutes: 15 });
    expect(result.outcome).toBe("provisioned");
    expect(purchase().status).toBe("provisioned");
    expect(db.tables.organizations).toHaveLength(1);
    expect(db.tables.companies).toHaveLength(1);
    expect(db.tables.public_form_keys).toHaveLength(1);
    // The dead-lettered checkout job is re-queued so the ledger gets processed too.
    expect(job(first.id as string)).toMatchObject({ status: "pending", attempt_count: 0 });
    expect(sendEmail.mock.calls.filter(([m]) => m.to === BUYER)).toHaveLength(1);
  });

  it("re-run asks Stripe when the webhook never arrived (checkout_created) and refuses an unpaid session", async () => {
    const stripe = {
      checkout: {
        sessions: {
          retrieve: vi.fn(async () => ({ ...sessionObject({ payment_status: "unpaid" }) })),
        },
      },
    };
    const unpaid = await runCrankleadsProvisionJob(admin, { sessionId: SESSION, stuck: false, olderThanMinutes: 15 }, { stripe: stripe as never });
    expect(unpaid.outcome).toBe("not_paid");
    expect(db.tables.organizations).toHaveLength(0);

    stripe.checkout.sessions.retrieve.mockResolvedValueOnce({ ...sessionObject() });
    const paid = await runCrankleadsProvisionJob(admin, { sessionId: SESSION, stuck: false, olderThanMinutes: 15 }, { stripe: stripe as never });
    expect(paid.outcome).toBe("provisioned");
    expect(purchase().status).toBe("provisioned");
  });

  it("a welcome-email failure does not fail provisioning (recorded + flagged to the operator)", async () => {
    sendEmail.mockImplementationOnce(async () => {
      throw new Error("resend down");
    });
    await processBillingEventJob(admin, seedEvent("checkout.session.completed", sessionObject()) as never);
    expect(purchase()).toMatchObject({ status: "provisioned", welcome_email_error: "resend down", welcome_email_sent_at: null });
    const operator = sendEmail.mock.calls.find(([m]) => m.to === "ops@empirevu.test")?.[0];
    expect(operator?.body).toContain("WELCOME EMAIL FAILED");
  });
});

describe("H1: no paid purchase dead-letters silently", () => {
  it("an error BEFORE the claim (purchase lookup) retries on a non-final attempt", async () => {
    db.failNext("crankleads_purchases", "select", { message: "connection reset" });
    const j = seedEvent("checkout.session.completed", sessionObject());
    await processBillingEventJob(admin, j as never);
    expect(job(j.id as string).status).toBe("pending");
    expect(String(job(j.id as string).last_error)).toContain("connection reset");
    expect(sendEmail).not.toHaveBeenCalled();

    // Next attempt succeeds.
    await processBillingEventJob(admin, { ...job(j.id as string), status: "running", attempt_count: 2 } as never);
    expect(purchase().status).toBe("provisioned");
  });

  it("an error before the claim on the FINAL attempt alerts the operator and dead-letters", async () => {
    db.failNext("crankleads_purchases", "select", { message: "connection reset" });
    const j = seedEvent("checkout.session.completed", sessionObject(), { attempt_count: 5 });
    await expect(processBillingEventJob(admin, j as never)).rejects.toThrow(/connection reset/);
    expect(job(j.id as string).status).toBe("failed");
    const alert = sendEmail.mock.calls.find(([m]) => m.to === "ops@empirevu.test")?.[0];
    expect(alert?.subject).toContain("ACTION NEEDED");
    expect(alert?.body).toContain(SESSION);
  });

  it("a failing status write (marking the purchase paid) retries instead of dead-lettering", async () => {
    db.failNext("crankleads_purchases", "update", { message: "cannot write" });
    const j = seedEvent("checkout.session.completed", sessionObject());
    await processBillingEventJob(admin, j as never);
    expect(job(j.id as string).status).toBe("pending");
    expect(String(job(j.id as string).last_error)).toContain("cannot write");
  });
});

describe("stuck-purchase sweep (--stuck)", () => {
  const old = "2026-10-02T11:00:00.000Z";
  const now = new Date("2026-10-02T12:00:00.000Z");

  it("provisions a paid-but-stuck purchase, asks Stripe about checkout_created ones, skips fresh/expired", async () => {
    setup({
      crankleads_purchases: [
        purchaseRow({ id: "p-paid", status: "paid", stripe_customer_id: CUSTOMER, stripe_subscription_id: SUBSCRIPTION, updated_at: old, created_at: old }),
        purchaseRow({ id: "p-missed", stripe_checkout_session_id: "cs_test_missedwebhook01", owner_email: "b@x.example", updated_at: old, created_at: old }),
        purchaseRow({ id: "p-abandoned", stripe_checkout_session_id: "cs_test_abandoned00001", updated_at: old, created_at: old }),
        purchaseRow({ id: "p-fresh", status: "paid", updated_at: "2026-10-02T11:58:00.000Z", created_at: old }),
      ],
    });
    const { runStuckPurchaseSweep } = await import("@/server/services/crankleads/rerun");
    const stripe = {
      checkout: {
        sessions: {
          retrieve: vi.fn(async (id: string) =>
            id === "cs_test_missedwebhook01"
              ? {
                  ...sessionObject({
                    id,
                    customer: "cus_missed",
                    subscription: "sub_missed",
                    client_reference_id: "p-missed",
                    customer_details: { email: "b@x.example" },
                    metadata: { source: "crankleads", purchaseId: "p-missed", tier: "catch", plan: "operate" },
                  }),
                  status: "complete",
                }
              : { id, status: "expired", payment_status: "unpaid", metadata: { source: "crankleads" } },
          ),
        },
      },
    };
    const items = await runStuckPurchaseSweep(admin, { stripe: stripe as never, now });
    const byId = Object.fromEntries(items.map((i) => [i.purchaseId, i.outcome]));
    expect(byId).toEqual({ "p-paid": "provisioned", "p-missed": "provisioned", "p-abandoned": "abandoned" });
    expect(db.tables.organizations).toHaveLength(2);
    const statuses = Object.fromEntries(db.tables.crankleads_purchases.map((p) => [p.id, p.status]));
    expect(statuses).toMatchObject({ "p-paid": "provisioned", "p-missed": "provisioned", "p-abandoned": "checkout_created", "p-fresh": "paid" });
  });

  it("a failure during the sweep alerts the operator (final attempt) and is reported", async () => {
    setup({
      crankleads_purchases: [purchaseRow({ status: "paid", stripe_customer_id: CUSTOMER, updated_at: old, created_at: old })],
    });
    db.failNext("organizations", "insert", { message: "boom" });
    const { runStuckPurchaseSweep } = await import("@/server/services/crankleads/rerun");
    const items = await runStuckPurchaseSweep(admin, { stripe: {} as never, now });
    expect(items[0]).toMatchObject({ outcome: "failed" });
    expect(sendEmail.mock.calls.find(([m]) => m.to === "ops@empirevu.test")?.[0]?.subject).toContain("ACTION NEEDED");
  });
});

describe("welcome-email resend (L2)", () => {
  it("re-sends a fresh link until the owner signs in; then (or after 7 days) says use Forgot password", async () => {
    const { resendWelcomeEmail } = await import("@/server/services/crankleads/provision");
    await processBillingEventJob(admin, seedEvent("checkout.session.completed", sessionObject()) as never);
    sendEmail.mockClear();

    expect(await resendWelcomeEmail(admin, SESSION)).toBe("sent");
    expect(sendEmail.mock.calls[0][0].body).toContain("update-password?token_hash=");

    authUsers[0].last_sign_in_at = "2026-10-03T09:00:00Z";
    expect(await resendWelcomeEmail(admin, SESSION)).toBe("use_forgot_password");

    authUsers[0].last_sign_in_at = null;
    purchase().provisioned_at = new Date(Date.now() - 8 * 864e5).toISOString();
    expect(await resendWelcomeEmail(admin, SESSION)).toBe("use_forgot_password");
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });
});
