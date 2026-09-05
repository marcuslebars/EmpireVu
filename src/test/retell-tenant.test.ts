import { describe, expect, it } from "vitest";

import { resolveRetellTenant } from "@/server/services/retell/tenant";

// A table + filter aware fake: the resolver runs several queries (voice_numbers by phone,
// voice_numbers by agent, companies by id or slug, organizations by slug), so the fake
// answers based on which filters were applied.
function fakeAdmin(resolve: (table: string, filters: Record<string, unknown>) => unknown) {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const chain: unknown = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "eq") {
              return (col: string, val: unknown) => {
                filters[col] = val;
                return chain;
              };
            }
            if (prop === "maybeSingle" || prop === "single") {
              return () => Promise.resolve({ data: resolve(table, filters), error: null });
            }
            if (prop === "then") {
              const result = Promise.resolve({ data: resolve(table, filters), error: null });
              return (onF: unknown, onR: unknown) => result.then(onF as never, onR as never);
            }
            return () => chain; // select, limit, order, …
          },
        },
      );
      return chain;
    },
  } as never;
}

describe("resolveRetellTenant", () => {
  it("resolves by the dialled number first", async () => {
    const admin = fakeAdmin((table, f) => {
      if (table === "voice_numbers" && f.phone_e164 === "+17055550188" && f.provider === "retell") {
        return { organization_id: "org-1", company_id: "co-1" };
      }
      if (table === "companies" && f.id === "co-1") return { slug: "a1-marine-care" };
      return null;
    });

    const tenant = await resolveRetellTenant(admin, {
      toNumber: "+17055550188",
      agentId: "agent_x",
      legacySourceSite: "a1marinestorage",
    });
    // sourceSite tag derived from the company slug.
    expect(tenant).toEqual({ organizationId: "org-1", companyId: "co-1", sourceSite: "a1marinecare" });
  });

  it("falls back to the agent id when the number isn't mapped", async () => {
    const admin = fakeAdmin((table, f) => {
      if (table === "voice_numbers" && f.provider_agent_id === "agent_x") {
        return { organization_id: "org-2", company_id: "co-2" };
      }
      if (table === "companies" && f.id === "co-2") return { slug: "a1-coatings" };
      return null; // phone lookup misses
    });

    const tenant = await resolveRetellTenant(admin, {
      toNumber: "+19995550000",
      agentId: "agent_x",
      legacySourceSite: "a1marinestorage",
    });
    expect(tenant).toEqual({ organizationId: "org-2", companyId: "co-2", sourceSite: "a1coatings" });
  });

  it("falls back to the legacy env brand when neither number nor agent maps", async () => {
    const admin = fakeAdmin((table, f) => {
      if (table === "organizations") return { id: "org-legacy" };
      if (table === "companies" && f.slug === "a1-marine-storage") return { id: "co-legacy" };
      return null; // no voice_numbers match
    });

    const tenant = await resolveRetellTenant(admin, {
      toNumber: "+19995550000",
      agentId: null,
      legacySourceSite: "a1marinestorage",
    });
    expect(tenant).toEqual({ organizationId: "org-legacy", companyId: "co-legacy", sourceSite: "a1marinestorage" });
  });

  it("returns a null company for a fully unmapped call (intake then stores raw + flags it)", async () => {
    const admin = fakeAdmin((table) => {
      if (table === "organizations") return { id: "org-legacy" };
      return null; // no number, no agent, unknown brand → no company
    });

    const tenant = await resolveRetellTenant(admin, {
      toNumber: "+19995550000",
      agentId: null,
      legacySourceSite: "unknown-brand",
    });
    expect(tenant.companyId).toBeNull();
    expect(tenant.organizationId).toBe("org-legacy");
  });
});
