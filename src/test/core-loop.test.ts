/**
 * Core-loop smoke test: create contact -> it appears in the contacts list ->
 * a `contact.created` activity event is emitted.
 *
 * This runs at unit speed against an in-memory fake Supabase (no live DB) and a
 * spied dispatch, so it verifies the service WIRING — not Postgres, RLS, or the
 * real workflow worker. The full DB-backed E2E matrix lives in Phase 5
 * (see docs/EMPIREVU_RUNBOOK.md once written).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// Spy the dispatch seam so we can assert the event without touching the queue,
// matcher, or workflow tables. Keep the rest of the module real.
vi.mock("@/server/services/workflow-engine/dispatch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/services/workflow-engine/dispatch")>();
  return {
    ...actual,
    emitActivityEventAndDispatch: vi
      .fn()
      .mockResolvedValue({ activityEvent: { id: "evt-1" }, workflowEventJob: null }),
  };
});

import { createContact, listContacts } from "@/server/services/contacts";
import { emitActivityEventAndDispatch } from "@/server/services/workflow-engine/dispatch";
import type { TenantServiceContext } from "@/server/services/shared";

type Row = Record<string, unknown>;

/**
 * Minimal in-memory stand-in for the Supabase query builder, covering exactly the
 * chains the contact services use: insert().select().single(),
 * select().eq()…maybeSingle(), and select().eq()…(awaited list).
 */
function createFakeSupabase(seed: Record<string, Row[]> = {}) {
  const store: Record<string, Row[]> = { contacts: [], companies: [], ...seed };
  let idSeq = 1;

  function from(table: string) {
    const filters: Array<[string, unknown]> = [];
    let op: "select" | "insert" | "update" = "select";
    let payload: Row = {};

    const rows = () => (store[table] ??= []);
    const applyFilters = () => rows().filter((r) => filters.every(([c, v]) => r[c] === v));
    const write = () => {
      if (op === "insert") {
        const row = { id: `${table}-${idSeq++}`, ...payload };
        rows().push(row);
        return { data: row, error: null };
      }
      const match = applyFilters();
      match.forEach((r) => Object.assign(r, payload));
      return { data: match[0] ?? null, error: null };
    };

    const builder: Record<string, unknown> = {
      insert(p: Row) { op = "insert"; payload = p; return builder; },
      update(p: Row) { op = "update"; payload = p; return builder; },
      select() { return builder; },
      eq(col: string, val: unknown) { filters.push([col, val]); return builder; },
      order() { return builder; },
      limit() { return builder; },
      single() {
        if (op !== "select") return Promise.resolve(write());
        const first = applyFilters()[0] ?? null;
        return Promise.resolve({ data: first, error: first ? null : new Error("no rows") });
      },
      maybeSingle() {
        if (op !== "select") return Promise.resolve(write());
        return Promise.resolve({ data: applyFilters()[0] ?? null, error: null });
      },
      then(onF: (v: { data: Row[]; error: null }) => unknown, onR?: (e: unknown) => unknown) {
        return Promise.resolve({ data: applyFilters(), error: null }).then(onF, onR);
      },
    };
    return builder;
  }

  return { store, client: { from } as unknown as TenantServiceContext["supabase"] };
}

describe("core loop: create contact", () => {
  const emitMock = vi.mocked(emitActivityEventAndDispatch);

  beforeEach(() => {
    emitMock.mockClear();
  });

  it("inserts the contact, returns it in the list, and records contact.created", async () => {
    const fake = createFakeSupabase({
      companies: [{ id: "comp-1", organization_id: "org-1", name: "A1 Marine Storage" }],
    });
    const context: TenantServiceContext = {
      organizationId: "org-1",
      actorProfileId: "profile-1",
      supabase: fake.client,
    };

    const contact = await createContact(context, {
      companyId: "comp-1",
      firstName: "Jane",
      email: "jane@example.com",
      stage: "lead",
    });

    // inserted + returned
    expect(contact.id).toBeTruthy();
    expect(contact.first_name).toBe("Jane");
    expect(contact.organization_id).toBe("org-1");
    expect(contact.company_id).toBe("comp-1");

    // appears in the CRM contacts list
    const list = await listContacts(context);
    expect(list.map((c) => c.id)).toContain(contact.id);

    // activity event recorded
    expect(emitMock).toHaveBeenCalledTimes(1);
    expect(emitMock).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        entityType: "contact",
        eventType: "contact.created",
        entityId: contact.id,
      }),
      expect.anything(),
    );
  });

  it("rejects a contact whose company is not in the organization (no event emitted)", async () => {
    const fake = createFakeSupabase({ companies: [] });
    const context: TenantServiceContext = {
      organizationId: "org-1",
      actorProfileId: "profile-1",
      supabase: fake.client,
    };

    await expect(
      createContact(context, { companyId: "ghost", firstName: "Nobody" }),
    ).rejects.toThrow();
    expect(emitMock).not.toHaveBeenCalled();
  });
});
