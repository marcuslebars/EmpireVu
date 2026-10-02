/**
 * Website lead forms — service layer.
 *  - key resolution: malformed keys never hit the DB; revoked keys resolve to null;
 *  - the public config exposes display fields + catalog LABELS only (no prices, no owner
 *    contacts, no Stripe ids, no tenant ids);
 *  - through the real handleLeadIntake (fake service-role client): tenant pinned from the
 *    key target, the raw_leads durable write happens BEFORE the notification, a NEW
 *    contact dispatches contact.created stamped source=public_form (so the paid-action
 *    guard throttles it), and a ticked opt-in records EXPRESS consent;
 *  - management helpers: key format + allowed-origin normalization.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- same loose fake-row shape as intake-service.test.ts
type Row = Record<string, any>;

let fake: ReturnType<typeof createFakeAdmin>;
const notifyCalls: Array<{ rawLeadsAtCall: number; lead: Row }> = [];

vi.mock("@/server/supabase/admin", () => ({
  createSupabaseAdminClient: () => fake.client,
}));
vi.mock("@/server/services/lead-intake/notify", () => ({
  sendLeadNotification: async (lead: Row) => {
    notifyCalls.push({ rawLeadsAtCall: fake.store.raw_leads.length, lead });
    return true;
  },
}));

import { handleLeadIntake } from "@/server/services/lead-intake/intake";
import { buildPublicFormEnvelope, normalizeOrigin, publicFormSubmissionSchema } from "@/server/services/lead-intake/public-form-envelope";
import { generatePublicFormKey, normalizeAllowedOrigins } from "@/server/services/lead-intake/public-form-keys";
import {
  listPublicServiceLabels,
  resolvePublicFormKey,
  toPublicFormConfig,
} from "@/server/services/lead-intake/public-forms";
import { unauthenticatedSource } from "@/server/services/workflow-engine/guards";
import { checkConsent, type ConsentContact } from "@/server/services/workflow-engine/messaging";
import type { WorkflowEventContext } from "@/server/services/workflow-engine/types";

function createFakeAdmin(seed: Record<string, Row[]>) {
  const store: Record<string, Row[]> = { ...seed };
  const queried: string[] = [];
  let idSeq = 1;

  function from(table: string) {
    queried.push(table);
    const filters: Array<[string, string, unknown]> = [];
    let op: "select" | "insert" | "update" = "select";
    let payload: Row = {};
    const rows = () => (store[table] ??= []);
    const applyFilters = () =>
      rows().filter((r) =>
        filters.every(([c, o, v]) => {
          if (o === "eq") return r[c] === v;
          if (o === "isNull") return r[c] == null;
          if (o === "notNull") return r[c] != null;
          if (o === "like") return new RegExp(`^${String(v).replace(/%/g, ".*")}$`).test(String(r[c] ?? ""));
          if (o === "in") return Array.isArray(v) && v.includes(r[c]);
          return true;
        }),
      );
    const doInsert = () => {
      const arr = Array.isArray(payload) ? payload : [payload];
      const inserted = arr.map((p) => {
        const row = { id: p.id ?? `${table}-${idSeq++}`, created_at: new Date().toISOString(), ...p };
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
      select() { return b; },
      eq(c: string, v: unknown) { filters.push([c, "eq", v]); return b; },
      is(c: string, v: unknown) { filters.push([c, "isNull", v]); return b; },
      not(c: string) { filters.push([c, "notNull", null]); return b; },
      in(c: string, v: unknown) { filters.push([c, "in", v]); return b; },
      like(c: string, v: unknown) { filters.push([c, "like", v]); return b; },
      order() { return b; },
      limit() { return b; },
      maybeSingle: async () => (op === "insert" ? doInsert() : { data: applyFilters()[0] ?? null, error: null }),
      single: async () => {
        if (op === "insert") return doInsert();
        const r = applyFilters()[0];
        return { data: r ?? null, error: r ? null : { message: "no rows" } };
      },
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => {
        const result = op === "insert" ? doInsert() : op === "update" ? doUpdate() : { data: applyFilters(), error: null };
        return Promise.resolve(result).then(onF, onR);
      },
    };
    return b;
  }

  return { store, queried, client: { from } };
}

const ACTIVE_KEY = `evpk_${"1".repeat(48)}`;
const REVOKED_KEY = `evpk_${"2".repeat(48)}`;

function seed(): Record<string, Row[]> {
  return {
    organizations: [{ id: "org-K", slug: "kirk" }, { id: "org-a1", slug: "a1-group" }],
    companies: [
      {
        id: "co-K",
        organization_id: "org-K",
        name: "Kirk Snow Removal",
        slug: "kirk-snow",
        brand_logo_url: "https://cdn.example/logo.png",
        brand_reply_phone: "+17055550100",
        brand_primary_color: "#1d4ed8",
        owner_email: "owner-private@kirk.example",
        owner_phone_e164: "+17055559999",
        stripe_connected_account_id: "acct_secret",
        quote_deposit_flat_cents: 5000,
      },
    ],
    public_form_keys: [
      { id: "form-1", organization_id: "org-K", company_id: "co-K", public_key: ACTIVE_KEY, form_type: "quote", allowed_origins: [], active: true },
      { id: "form-2", organization_id: "org-K", company_id: "co-K", public_key: REVOKED_KEY, form_type: "quote", allowed_origins: [], active: false },
    ],
    service_catalog_items: [
      { id: "s1", organization_id: "org-K", company_id: "co-K", label: "Driveway clearing", active: true, rate_cents: 4500, minimum_cents: 9000, service_key: "driveway", sort_order: 1 },
      { id: "s2", organization_id: "org-K", company_id: "co-K", label: "Salting", active: true, rate_cents: 2500, minimum_cents: 2500, service_key: "salt", sort_order: 2 },
      { id: "s3", organization_id: "org-K", company_id: "co-K", label: "Retired service", active: false, rate_cents: 100, minimum_cents: 0, service_key: "old", sort_order: 3 },
      { id: "s4", organization_id: "org-other", company_id: "co-other", label: "Other tenant's service", active: true, rate_cents: 1, minimum_cents: 1, service_key: "x", sort_order: 1 },
    ],
    contacts: [],
    activity_events: [],
    bookings: [],
    raw_leads: [],
    workflow_event_jobs: [],
  };
}

beforeEach(() => {
  fake = createFakeAdmin(seed());
  notifyCalls.length = 0;
});

describe("resolvePublicFormKey", () => {
  it("malformed keys never reach the database", async () => {
    expect(await resolvePublicFormKey("evk_not-a-form-key")).toBeNull();
    expect(await resolvePublicFormKey("")).toBeNull();
    expect(fake.queried).toHaveLength(0);
  });

  it("an active key resolves to its pinned tenant", async () => {
    const form = await resolvePublicFormKey(ACTIVE_KEY);
    expect(form).toMatchObject({ id: "form-1", organizationId: "org-K", companyId: "co-K", formType: "quote" });
  });

  it("a revoked key resolves to null", async () => {
    expect(await resolvePublicFormKey(REVOKED_KEY)).toBeNull();
  });
});

describe("public config — display-safe only", () => {
  it("exposes name/logo/public phone/colour + active labels of THIS company; no prices or PII", async () => {
    const form = await resolvePublicFormKey(ACTIVE_KEY);
    expect(form).not.toBeNull();
    const services = await listPublicServiceLabels(form!);
    const config = toPublicFormConfig(form!, services);
    expect(config.services).toEqual(["Driveway clearing", "Salting"]);
    expect(config.company).toEqual({
      name: "Kirk Snow Removal",
      logoUrl: "https://cdn.example/logo.png",
      phone: "+17055550100",
      primaryColor: "#1d4ed8",
    });
    const text = JSON.stringify(config);
    for (const secret of ["4500", "9000", "cents", "owner-private", "+17055559999", "acct_secret", "org-K", "co-K", "driveway", ACTIVE_KEY]) {
      expect(text).not.toContain(secret);
    }
    expect(config.form.smsConsentText).toMatch(/Reply STOP to opt out/);
  });
});

function envelopeFor(body: Row) {
  const input = publicFormSubmissionSchema.parse(body);
  return buildPublicFormEnvelope(input, { formType: "quote", companyName: "Kirk Snow Removal", companySlug: "kirk-snow" });
}

describe("through handleLeadIntake (the same durable path)", () => {
  it("durable raw_leads write happens before the notification; tenant pinned from the key", async () => {
    const env = envelopeFor({ name: "Pat Plow", email: "pat@example.com", phone: "705-555-0199", organizationId: "EVIL" });
    const res = await handleLeadIntake(JSON.stringify(env), env, {
      target: { organizationId: "org-K", companyId: "co-K" },
      workflowTrigger: { source: "public_form" },
    });
    expect(res.ok).toBe(true);
    expect(fake.store.raw_leads).toHaveLength(1);
    expect(fake.store.raw_leads[0]).toMatchObject({ organization_id: "org-K", company_id: "co-K", schema_valid: true, source: "public_form" });
    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0].rawLeadsAtCall).toBe(1); // raw lead already persisted when notify ran
    expect(fake.store.contacts[0]).toMatchObject({ organization_id: "org-K", company_id: "co-K" });
  });

  it("a NEW contact dispatches contact.created stamped source=public_form (guarded as unauthenticated)", async () => {
    const env = envelopeFor({ name: "Pat Plow", email: "pat@example.com" });
    await handleLeadIntake(JSON.stringify(env), env, {
      target: { organizationId: "org-K", companyId: "co-K" },
      workflowTrigger: { source: "public_form" },
    });
    const created = fake.store.activity_events.find((e) => e.event_type === "contact.created");
    expect(created?.metadata_json).toMatchObject({ source: "public_form", contactId: fake.store.contacts[0].id });
    expect(fake.store.workflow_event_jobs).toHaveLength(1);
    expect(fake.store.workflow_event_jobs[0].activity_event_id).toBe(created?.id);

    const eventContext = { activityEvent: { actor_user_id: null }, metadata: created?.metadata_json } as WorkflowEventContext;
    expect(unauthenticatedSource(eventContext)).toBe("public_form");
  });

  it("without workflowTrigger (spokes, phone leads) nothing is dispatched — unchanged", async () => {
    const env = envelopeFor({ name: "Pat Plow", email: "pat@example.com" });
    await handleLeadIntake(JSON.stringify(env), env, { target: { organizationId: "org-K", companyId: "co-K" } });
    expect(fake.store.workflow_event_jobs).toHaveLength(0);
  });

  it("a ticked opt-in records EXPRESS consent on a new contact", async () => {
    const env = envelopeFor({ name: "Pat", phone: "705-555-0199", smsConsent: true });
    await handleLeadIntake(JSON.stringify(env), env, { target: { organizationId: "org-K", companyId: "co-K" }, workflowTrigger: { source: "public_form" } });
    const c = fake.store.contacts[0];
    expect(c.consent_source).toBe("express_optin");
    expect(checkConsent(c as ConsentContact, "sms", Date.now() + 365 * 24 * 3600 * 1000)).toEqual({ ok: true });
    // The exact wording shown is kept on the raw lead as the consent record.
    expect(fake.store.raw_leads[0].raw_payload.meta.smsConsent.text).toMatch(/Reply STOP/);
  });

  it("an unticked box records implied inquiry consent (same as every other path)", async () => {
    const env = envelopeFor({ name: "Pat", phone: "705-555-0199", smsConsent: false });
    await handleLeadIntake(JSON.stringify(env), env, { target: { organizationId: "org-K", companyId: "co-K" }, workflowTrigger: { source: "public_form" } });
    expect(fake.store.contacts[0].consent_source).toBe("implied_inquiry");
  });

  it("opt-in upgrades a matched contact's implied consent, but never touches an opted-out one", async () => {
    fake.store.contacts.push(
      { id: "c-1", organization_id: "org-K", company_id: "co-K", email: "a@example.com", phone: null, sms_consent_at: "2026-01-01T00:00:00.000Z", consent_source: "implied_inquiry", sms_opt_out_at: null },
      { id: "c-2", organization_id: "org-K", company_id: "co-K", email: "b@example.com", phone: null, sms_consent_at: "2026-01-01T00:00:00.000Z", consent_source: "implied_inquiry", sms_opt_out_at: "2026-02-01T00:00:00.000Z" },
    );
    for (const email of ["a@example.com", "b@example.com"]) {
      const env = envelopeFor({ email, phone: "705-555-0101", smsConsent: true });
      await handleLeadIntake(JSON.stringify(env), env, { target: { organizationId: "org-K", companyId: "co-K" }, workflowTrigger: { source: "public_form" } });
    }
    expect(fake.store.contacts.find((c) => c.id === "c-1")?.consent_source).toBe("express_optin");
    const optedOut = fake.store.contacts.find((c) => c.id === "c-2");
    expect(optedOut?.consent_source).toBe("implied_inquiry");
    expect(optedOut?.sms_opt_out_at).toBe("2026-02-01T00:00:00.000Z");
    // Matched contacts are deduped, not re-created, and never re-dispatch contact.created.
    expect(fake.store.contacts).toHaveLength(2);
    expect(fake.store.workflow_event_jobs).toHaveLength(0);
  });
});

describe("management helpers", () => {
  it("generates evpk_ keys in the DB-checked format", () => {
    const key = generatePublicFormKey();
    expect(key).toMatch(/^evpk_[0-9a-f]{48}$/);
    expect(generatePublicFormKey()).not.toBe(key);
  });

  it("normalizes + dedupes allowed websites and rejects junk", () => {
    expect(normalizeAllowedOrigins(["KirkSnow.ca", "https://kirksnow.ca/", "https://www.kirksnow.ca/contact?x=1", ""])).toEqual([
      "https://kirksnow.ca",
      "https://www.kirksnow.ca",
    ]);
    expect(() => normalizeAllowedOrigins(["javascript:alert(1)"])).toThrow(/not a website address/);
    expect(normalizeOrigin("ftp://example.com")).toBeNull();
  });
});
