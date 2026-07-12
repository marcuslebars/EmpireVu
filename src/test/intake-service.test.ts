/**
 * Intake service — never-drop + the fences approved for the scoped-service-role model:
 *  - garbage body -> raw_leads row (schema_valid false, flagged) + success, no contact;
 *  - valid envelope -> raw_leads + contact routed to the brand's company + activity;
 *  - returning contact -> matched, no duplicate, cross-brand recorded;
 *  - a payload smuggling organizationId/companyId is IGNORED; writes are pinned to A1;
 *  - unknown brand -> stored raw, no company, flagged, still success;
 *  - the result echoes no data (write-only in effect).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, any>;

let fake: ReturnType<typeof createFakeAdmin>;

vi.mock("@/server/supabase/admin", () => ({
  createSupabaseAdminClient: () => fake.client,
}));

import { handleLeadIntake } from "@/server/services/lead-intake/intake";

function createFakeAdmin(seed: Record<string, Row[]>) {
  const store: Record<string, Row[]> = {
    organizations: [],
    companies: [],
    contacts: [],
    activity_events: [],
    bookings: [],
    raw_leads: [],
    ...seed,
  };
  let idSeq = 1;

  function from(table: string) {
    const filters: Array<[string, string, unknown]> = [];
    let op: "select" | "insert" | "update" = "select";
    let payload: Row = {};
    const rows = () => (store[table] ??= []);
    const applyFilters = () =>
      rows().filter((r) =>
        filters.every(([c, o, v]) => {
          if (o === "eq") return r[c] === v;
          if (o === "notNull") return r[c] != null;
          if (o === "like") return new RegExp(`^${String(v).replace(/%/g, ".*")}$`).test(String(r[c] ?? ""));
          if (o === "in") return Array.isArray(v) && v.includes(r[c]);
          return true;
        }),
      );
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
      select() { return b; },
      eq(c: string, v: unknown) { filters.push([c, "eq", v]); return b; },
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

  return { store, client: { from } as unknown as ReturnType<typeof import("@/server/supabase/admin").createSupabaseAdminClient> };
}

function baseSeed(): Record<string, Row[]> {
  return {
    organizations: [{ id: "org-a1", slug: "a1-group" }],
    companies: [
      { id: "co-care", organization_id: "org-a1", slug: "a1-marine-care", name: "A1 Marine Care" },
      { id: "co-storage", organization_id: "org-a1", slug: "a1-marine-storage", name: "A1 Marine Storage" },
    ],
    contacts: [],
    activity_events: [],
    bookings: [],
    raw_leads: [],
  };
}

function validEnvelope(overrides: Row = {}): Row {
  return {
    schemaVersion: 1,
    source: "a1marinestorage-contact",
    sourceSite: "a1marinestorage",
    formType: "contact",
    receivedAt: "2026-07-06T14:00:00.000Z",
    contact: { name: "Jane Boater", email: "jane@example.com", phone: "705-555-0101" },
    message: "Winterize my boat",
    ...overrides,
  };
}

beforeEach(() => {
  fake = createFakeAdmin(baseSeed());
});

describe("intake — never drop", () => {
  it("garbage body -> raw_leads (invalid, flagged) + success, no contact", async () => {
    const res = await handleLeadIntake("not json", null);
    expect(res.ok).toBe(true);
    expect(res.leadId).toMatch(/^lead_/);
    expect(fake.store.raw_leads).toHaveLength(1);
    expect(fake.store.raw_leads[0].schema_valid).toBe(false);
    expect(fake.store.raw_leads[0].needs_attention).toBe(true);
    expect(fake.store.contacts).toHaveLength(0);
  });

  it("valid envelope -> raw_leads (valid) + contact routed to the brand company + lead activity", async () => {
    const env = validEnvelope();
    const res = await handleLeadIntake(JSON.stringify(env), env);
    expect(res.ok).toBe(true);
    expect(fake.store.raw_leads[0].schema_valid).toBe(true);
    expect(fake.store.contacts).toHaveLength(1);
    expect(fake.store.contacts[0].organization_id).toBe("org-a1");
    expect(fake.store.contacts[0].company_id).toBe("co-storage");
    expect(fake.store.activity_events.some((e) => e.event_type === "lead.contact")).toBe(true);
  });

  it("returning within the same brand -> matched, no duplicate", async () => {
    // Jane already exists as an A1 Marine Storage contact; a new Storage lead
    // matches her (within-brand) instead of creating a duplicate.
    fake.store.contacts.push({ id: "c-storage", organization_id: "org-a1", company_id: "co-storage", email: "jane@example.com", phone: null });
    const env = validEnvelope(); // storage lead
    const res = await handleLeadIntake(JSON.stringify(env), env);
    expect(res.ok).toBe(true);
    expect(fake.store.contacts).toHaveLength(1); // matched, not duplicated
    expect(fake.store.raw_leads[0].matched).toBe(true);
    expect(fake.store.raw_leads[0].contact_id).toBe("c-storage");
    const newActivity = fake.store.activity_events.find((e) => e.metadata_json?.leadId);
    expect(newActivity?.company_id).toBe("co-storage");
  });

  it("cross-brand: a lead is attributed to ITS brand (separate contact) + flags the overlap", async () => {
    // Jane is already an A1 Marine CARE contact. The incoming lead is A1 Marine
    // STORAGE — it must NOT attach to the Care contact. It creates a separate
    // Storage contact (attributed to the form's brand), scopes its activity to
    // Storage, and flags that she is also a Care customer.
    fake.store.contacts.push({ id: "c-care", organization_id: "org-a1", company_id: "co-care", email: "jane@example.com", phone: null });
    const env = validEnvelope(); // sourceSite a1marinestorage -> co-storage
    const res = await handleLeadIntake(JSON.stringify(env), env);
    expect(res.ok).toBe(true);
    expect(fake.store.contacts).toHaveLength(2); // separate per-brand contacts
    const storageContact = fake.store.contacts.find((c) => c.company_id === "co-storage");
    expect(storageContact).toBeTruthy();
    expect(fake.store.raw_leads[0].matched).toBe(false); // new for this brand
    expect(fake.store.raw_leads[0].contact_id).toBe(storageContact!.id);
    const newActivity = fake.store.activity_events.find((e) => e.metadata_json?.leadId);
    expect(newActivity?.company_id).toBe("co-storage"); // scoped to the lead's brand
    expect(newActivity?.metadata_json?.crossBrandBrands).toEqual(["A1 Marine Care"]);
    expect(fake.store.raw_leads[0].needs_attention).toBe(false);
  });
});

describe("intake — fences", () => {
  it("ignores a rogue organizationId/companyId in the payload; writes pinned to A1", async () => {
    const env = { ...validEnvelope(), organizationId: "EVIL-ORG", companyId: "EVIL-CO" };
    await handleLeadIntake(JSON.stringify(env), env);
    expect(fake.store.raw_leads[0].organization_id).toBe("org-a1");
    expect(fake.store.raw_leads[0].company_id).toBe("co-storage");
    expect(fake.store.contacts[0].organization_id).toBe("org-a1");
    expect(fake.store.contacts[0].company_id).toBe("co-storage");
  });

  it("unknown brand -> stored raw, no company, flagged, still success", async () => {
    const env = validEnvelope({ sourceSite: "unknownbrand", source: "unknownbrand-contact" });
    const res = await handleLeadIntake(JSON.stringify(env), env);
    expect(res.ok).toBe(true);
    expect(fake.store.raw_leads[0].organization_id).toBe("org-a1"); // org still pinned
    expect(fake.store.raw_leads[0].company_id).toBeNull();
    expect(fake.store.raw_leads[0].needs_attention).toBe(true);
    expect(fake.store.contacts).toHaveLength(0);
  });

  it("result echoes no data (write-only in effect)", async () => {
    const env = validEnvelope();
    const res = await handleLeadIntake(JSON.stringify(env), env);
    expect(Object.keys(res).sort()).toEqual(["leadId", "ok"]);
  });
});
